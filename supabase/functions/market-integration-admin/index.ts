import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { ApiError, executeAction, type Integration, type IntegrationRepository } from './core.ts'
import { ENCRYPTION_SECRET_NAME } from './crypto.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const integrationColumns = [
  'id', 'market_account_id', 'provider', 'base_url', 'external_company_id',
  'status', 'last_test_at', 'last_test_succeeded', 'last_test_error',
].join(',')

class SupabaseIntegrationRepository implements IntegrationRepository {
  private readonly serviceClient: SupabaseClient
  private readonly userClient: SupabaseClient

  constructor(serviceClient: SupabaseClient, userClient: SupabaseClient) {
    this.serviceClient = serviceClient
    this.userClient = userClient
  }

  async isGlobalAdmin(_userId: string) {
    const { data, error } = await this.userClient.rpc('is_admin')
    if (error) throw new Error('Global admin lookup failed')
    return data === true
  }

  async marketAccountExists(marketAccountId: string) {
    const { data, error } = await this.serviceClient
      .from('market_accounts')
      .select('id')
      .eq('id', marketAccountId)
      .in('status', ['pilot', 'active'])
      .maybeSingle()
    if (error) throw new Error('Market account lookup failed')
    return data !== null
  }

  async getIntegration(marketAccountId: string, integrationId: string) {
    const { data, error } = await this.serviceClient
      .from('market_integrations')
      .select(integrationColumns)
      .eq('market_account_id', marketAccountId)
      .eq('id', integrationId)
      .maybeSingle()
    if (error) throw new Error('Integration lookup failed')
    return data as Integration | null
  }

  async createIntegration(input: Omit<Integration, 'id' | 'last_test_at' | 'last_test_succeeded' | 'last_test_error'>) {
    const { data, error } = await this.serviceClient
      .from('market_integrations')
      .insert(input)
      .select(integrationColumns)
      .single()
    if (error) throw new Error('Integration create failed')
    return data as Integration
  }

  async updateIntegration(marketAccountId: string, integrationId: string, input: Partial<Integration>) {
    const { data, error } = await this.serviceClient
      .from('market_integrations')
      .update(input)
      .eq('market_account_id', marketAccountId)
      .eq('id', integrationId)
      .select(integrationColumns)
      .single()
    if (error) throw new Error('Integration update failed')
    return data as Integration
  }

  async getCredential(marketAccountId: string, integrationId: string) {
    const { data, error } = await this.serviceClient
      .from('market_integration_credentials')
      .select('username, password_ciphertext')
      .eq('market_account_id', marketAccountId)
      .eq('integration_id', integrationId)
      .maybeSingle()
    if (error) throw new Error('Credential lookup failed')
    return data as { username: string; password_ciphertext: string } | null
  }

  async saveCredential(input: {
    marketAccountId: string
    integrationId: string
    username: string
    passwordCiphertext?: string
  }) {
    if (input.passwordCiphertext) {
      const { error } = await this.serviceClient
        .from('market_integration_credentials')
        .upsert({
          integration_id: input.integrationId,
          market_account_id: input.marketAccountId,
          username: input.username,
          password_ciphertext: input.passwordCiphertext,
          encryption_version: 1,
        }, { onConflict: 'integration_id' })
      if (error) throw new Error('Credential save failed')
      return
    }

    const { data, error } = await this.serviceClient
      .from('market_integration_credentials')
      .update({ username: input.username })
      .eq('market_account_id', input.marketAccountId)
      .eq('integration_id', input.integrationId)
      .select('integration_id')
      .maybeSingle()
    if (error || !data) throw new Error('Credential update failed')
  }

  async updateTestResult(
    marketAccountId: string,
    integrationId: string,
    input: { testedAt: string; succeeded: boolean; error: string | null },
  ) {
    const { error } = await this.serviceClient
      .from('market_integrations')
      .update({
        last_test_at: input.testedAt,
        last_test_succeeded: input.succeeded,
        last_test_error: input.error,
      })
      .eq('market_account_id', marketAccountId)
      .eq('id', integrationId)
    if (error) throw new Error('Test audit update failed')
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Método não permitido.' } }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const encryptionKey = Deno.env.get(ENCRYPTION_SECRET_NAME)
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !encryptionKey) {
    console.error('market-integration-admin: configuração server-side ausente')
    return json({ error: { code: 'SERVICE_NOT_CONFIGURED', message: 'Serviço não configurado.' } }, 503)
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Autenticação necessária.' } }, 401)
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await userClient.auth.getUser(token)
  if (authError || !authData.user) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Sessão inválida.' } }, 401)
  }

  let body: unknown
  try {
    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (contentLength > 32_768) throw new Error('Payload too large')
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > 32_768) throw new Error('Payload too large')
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: { code: 'INVALID_REQUEST', message: 'JSON inválido.' } }, 400)
  }

  try {
    const result = await executeAction(authData.user.id, body, {
      repository: new SupabaseIntegrationRepository(serviceClient, userClient),
      encryptionKey,
    })
    return json(result)
  } catch (error) {
    const apiError = error instanceof ApiError
      ? error
      : new ApiError('INTERNAL_ERROR', 'Erro interno ao administrar integração.', 500)
    const requestBody = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    console.error('market-integration-admin: operação falhou', {
      code: apiError.code,
      action: typeof requestBody.action === 'string' ? requestBody.action : undefined,
      marketAccountId: typeof requestBody.marketAccountId === 'string'
        ? requestBody.marketAccountId
        : undefined,
      integrationId: typeof requestBody.integrationId === 'string'
        ? requestBody.integrationId
        : undefined,
    })
    return json({ error: { code: apiError.code, message: apiError.message } }, apiError.status)
  }
})
