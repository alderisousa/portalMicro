import { createClient } from 'npm:@supabase/supabase-js@2'
import { accessKeyFromQrUrl, normalizeAccessKey, parseImportRequest, PurchaseImportError } from './core.ts'
import { createProviderFromEnvironment, type NfeProvider } from './provider.ts'
import { isSefazSpQrUrl, parseSefazSpQrUrl, SefazSpNfceProvider } from './sefazSpProvider.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' } }, 405)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const authorization = request.headers.get('Authorization')
  if (!supabaseUrl || !anonKey) return json({ error: { code: 'SERVICE_NOT_CONFIGURED', message: 'Serviço não configurado.' } }, 503)
  if (!authorization?.startsWith('Bearer ')) return json({ error: { code: 'UNAUTHORIZED', message: 'Autenticação necessária.' } }, 401)

  const client = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: authData, error: authError } = await client.auth.getUser(authorization.slice(7))
  if (authError || !authData.user) return json({ error: { code: 'UNAUTHORIZED', message: 'Sessão inválida.' } }, 401)

  try {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > 16_384) throw new PurchaseImportError('INVALID_REQUEST', 'Requisição muito grande.', 413)
    const input = parseImportRequest(JSON.parse(raw))
    const [{ data: hasRole, error: roleError }, { data: account, error: accountError }, { data: destination, error: destinationError }] = await Promise.all([
      client.rpc('market_has_role', { p_account_id: input.marketAccountId, p_roles: ['owner', 'admin', 'manager'] }),
      client.from('market_accounts').select('id').eq('id', input.marketAccountId).in('status', ['pilot', 'active']).maybeSingle(),
      client.from('market_stores').select('id').eq('id', input.destinationStoreId).eq('market_account_id', input.marketAccountId)
        .eq('store_type', 'warehouse').eq('status', 'active').maybeSingle(),
    ])
    if (roleError || accountError || destinationError) throw new PurchaseImportError('AUTHORIZATION_FAILED', 'Não foi possível validar o acesso à compra.', 403)
    if (!hasRole) throw new PurchaseImportError('PURCHASE_IMPORT_PERMISSION_DENIED', 'Seu perfil não pode importar NF-e.', 403)
    if (!account) throw new PurchaseImportError('PURCHASE_ACCOUNT_NOT_AVAILABLE', 'Conta Market não encontrada ou indisponível.', 404)
    if (!destination) throw new PurchaseImportError('PURCHASE_DESTINATION_NOT_ALLOWED', 'Selecione um galpão permitido para esta conta.', 403)
    const allowedHosts = (Deno.env.get('NFE_QR_ALLOWED_HOSTS') ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
    let accessKey: string
    let provider: NfeProvider
    if (input.sourceType === 'qrcode_url' && isSefazSpQrUrl(input.sourceValue)) {
      // Consulta publica oficial da SEFAZ-SP: a URL do QR Code e o proprio endpoint,
      // sem token, dispensando NFE_PROVIDER_URL/NFE_PROVIDER_TOKEN para este fluxo.
      const sefaz = parseSefazSpQrUrl(input.sourceValue)
      accessKey = sefaz.accessKey
      provider = new SefazSpNfceProvider(sefaz.url)
    } else {
      accessKey = input.sourceType === 'access_key'
        ? normalizeAccessKey(input.sourceValue)
        : accessKeyFromQrUrl(input.sourceValue, allowedHosts)
      provider = createProviderFromEnvironment()
    }
    const document = await provider.fetchDocument(accessKey)
    // Reimportar so troca a RPC chamada: mesmo documento normalizado, mesma validacao
    // de papel/conta/destino acima. market_reimport_purchase_staging revalida sozinha,
    // dentro da propria transacao, se a compra existente ainda pode ser substituida.
    const rpcName = input.mode === 'reimport' ? 'market_reimport_purchase_staging' : 'market_import_purchase_staging'
    const { data, error } = await client.rpc(rpcName, {
      p_market_account_id: input.marketAccountId,
      p_destination_store_id: input.destinationStoreId,
      p_source_type: input.sourceType === 'qrcode_url' ? 'qrcode' : 'nfe',
      p_document: document,
    })
    if (error) {
      const code = error.message.match(/PURCHASE_[A-Z_]+/)?.[0] ?? 'PURCHASE_IMPORT_FAILED'
      if (code === 'PURCHASE_REIMPORT_BLOCKED') {
        throw new PurchaseImportError(code, 'Esta nota já possui itens conciliados ou movimentação de estoque e não pode ser reimportada.', 409)
      }
      if (code === 'PURCHASE_NOT_FOUND_FOR_REIMPORT') {
        throw new PurchaseImportError(code, 'Não foi possível localizar a nota para reimportar. Tente importar novamente.', 404)
      }
      const status = code.includes('PERMISSION') || code.includes('NOT_ALLOWED') ? 403 : code.includes('NOT_AVAILABLE') ? 404 : 400
      throw new PurchaseImportError(code, code === 'PURCHASE_IMPORT_FAILED' ? 'Não foi possível importar a NF-e.' : 'A NF-e não pôde ser importada com os dados informados.', status)
    }
    return json(data)
  } catch (error) {
    const safe = error instanceof PurchaseImportError ? error : new PurchaseImportError('INVALID_REQUEST', 'Requisição inválida.', 400)
    console.error('market-purchase-import failed', { code: safe.code, userId: authData.user.id })
    return json({ error: { code: safe.code, message: safe.message } }, safe.status)
  }
})
