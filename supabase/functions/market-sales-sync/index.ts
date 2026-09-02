import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'
import { executeSalesSync, getSalesSyncStatus, SyncApiError, type RunCounters, type SalesSyncRepository, type SyncIntegration, type SyncRunStatus } from './core.ts'
import { createAccesysOrdersProvider } from './provider.ts'
import { ENCRYPTION_SECRET_NAME, decryptPassword, postgresByteaToBytes } from '../market-integration-admin/crypto.ts'
import { normalizeAndValidateProviderUrl } from '../market-integration-admin/providers.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

class SupabaseSalesSyncRepository implements SalesSyncRepository {
  constructor(
    private readonly serviceClient: SupabaseClient,
    private readonly userClient: SupabaseClient,
  ) {}

  async isGlobalAdmin(_userId: string) {
    const { data, error } = await this.userClient.rpc('is_admin')
    if (error) throw new Error('Global admin lookup failed')
    return data === true
  }

  async hasMarketRole(marketAccountId: string, roles: string[]) {
    const { data, error } = await this.userClient.rpc('market_has_role', {
      p_account_id: marketAccountId,
      p_roles: roles,
    })
    if (error) throw new Error('Market role lookup failed')
    return data === true
  }

  async marketAccountExists(marketAccountId: string) {
    const { data, error } = await this.serviceClient.from('market_accounts').select('id')
      .eq('id', marketAccountId).in('status', ['pilot', 'active']).maybeSingle()
    if (error) throw new Error('Market account lookup failed')
    return data !== null
  }

  async getIntegration(marketAccountId: string, integrationId: string) {
    const { data, error } = await this.serviceClient.from('market_integrations')
      .select('id,market_account_id,provider,base_url,external_company_id,status')
      .eq('market_account_id', marketAccountId).eq('id', integrationId).maybeSingle()
    if (error) throw new Error('Integration lookup failed')
    return data as SyncIntegration | null
  }

  async getEligibleIntegrations(marketAccountId: string) {
    const { data, error } = await this.serviceClient.from('market_integrations')
      .select('id,market_account_id,provider,base_url,external_company_id,status')
      .eq('market_account_id', marketAccountId).eq('provider', 'accesys').eq('status', 'active')
      .order('created_at', { ascending: true }).limit(2)
    if (error) throw new Error('Eligible integrations lookup failed')
    return (data ?? []) as SyncIntegration[]
  }

  async getCredential(marketAccountId: string, integrationId: string) {
    const { data, error } = await this.serviceClient.from('market_integration_credentials')
      .select('username,password_ciphertext').eq('market_account_id', marketAccountId)
      .eq('integration_id', integrationId).maybeSingle()
    if (error) throw new Error('Credential lookup failed')
    return data as { username: string; password_ciphertext: string } | null
  }

  async getStoreMappings(marketAccountId: string, integrationId: string) {
    const { data, error } = await this.serviceClient.from('market_store_external_refs')
      .select('id,external_store_id').eq('market_account_id', marketAccountId)
      .eq('integration_id', integrationId)
    if (error) throw new Error('Store mappings lookup failed')
    return (data ?? []) as Array<{ id: string; external_store_id: string }>
  }

  async beginRun(input: {
    marketAccountId: string; integrationId: string; startDate: string; endDate: string; requestedBy: string
  }) {
    const { data, error } = await this.serviceClient.rpc('market_begin_sales_sync', {
      p_market_account_id: input.marketAccountId,
      p_integration_id: input.integrationId,
      p_period_start: input.startDate,
      p_period_end: input.endDate,
      p_requested_by: input.requestedBy,
    })
    if (error) {
      if (error.message.includes('SYNC_ALREADY_RUNNING')) {
        throw new SyncApiError(
          'SYNC_ALREADY_RUNNING',
          'Ja existe uma sincronizacao ativa para esta integracao.',
          409,
        )
      }
      throw new Error('Sync run acquisition failed')
    }
    if (typeof data !== 'string') throw new Error('Sync run acquisition returned invalid result')
    return data
  }

  async heartbeatRun(runId: string, marketAccountId: string) {
    const { data, error } = await this.serviceClient.from('market_sales_sync_runs').update({
      heartbeat_at: new Date().toISOString(),
    }).eq('id', runId).eq('market_account_id', marketAccountId).eq('status', 'running')
      .select('id').maybeSingle()
    if (error) throw new Error('Sync run heartbeat failed')
    if (!data) throw new SyncApiError('SYNC_RUN_LOST', 'A execucao perdeu a posse da sincronizacao.', 409)
  }

  async finishRun(runId: string, marketAccountId: string, status: 'completed' | 'partial' | 'failed', counters: RunCounters, errorMessage: string | null) {
    const { error } = await this.serviceClient.from('market_sales_sync_runs').update({
      status,
      pages_read: counters.pagesRead,
      orders_read: counters.ordersRead,
      orders_inserted: counters.ordersInserted,
      orders_updated: counters.ordersUpdated,
      items_processed: counters.itemsProcessed,
      payments_processed: counters.paymentsProcessed,
      skipped_orders: counters.skippedOrders,
      error_message: errorMessage,
      finished_at: new Date().toISOString(),
    }).eq('id', runId).eq('market_account_id', marketAccountId).eq('status', 'running')
    if (error) throw new Error('Sync run finish failed')
  }

  async recordOrderError(input: {
    marketAccountId: string; runId: string; externalOrderId: string | null
    externalStoreId: string | null; code: string; message: string
  }) {
    const { error } = await this.serviceClient.from('market_sales_sync_errors').insert({
      market_account_id: input.marketAccountId,
      sync_run_id: input.runId,
      external_order_id: input.externalOrderId,
      external_store_id: input.externalStoreId,
      error_code: input.code,
      error_message: input.message,
    })
    if (error) throw new Error('Sync order error audit failed')
  }

  async upsertSale(input: {
    marketAccountId: string; integrationId: string; storeExternalRefId: string
    sale: unknown; items: unknown[]; payments: unknown[]
  }) {
    const { data, error } = await this.serviceClient.rpc('market_upsert_external_sale', {
      p_market_account_id: input.marketAccountId,
      p_integration_id: input.integrationId,
      p_store_external_ref_id: input.storeExternalRefId,
      p_sale: input.sale,
      p_items: input.items,
      p_payments: input.payments,
    })
    if (error || !data || typeof data !== 'object') throw new Error('Sale upsert failed')
    const result = data as Record<string, unknown>
    if (typeof result.saleId !== 'string' || typeof result.inserted !== 'boolean' ||
        typeof result.itemsProcessed !== 'number' || !Number.isInteger(result.itemsProcessed) ||
        typeof result.paymentsProcessed !== 'number' || !Number.isInteger(result.paymentsProcessed)) {
      throw new Error('Sale upsert returned invalid result')
    }
    return result as { saleId: string; inserted: boolean; itemsProcessed: number; paymentsProcessed: number }
  }

  async getLatestRun(marketAccountId: string) {
    const { data, error } = await this.serviceClient.from('market_sales_sync_runs')
      .select('id,status,period_start,period_end,started_at,heartbeat_at,finished_at,orders_read,orders_inserted,orders_updated,items_processed,payments_processed,skipped_orders,error_message')
      .eq('market_account_id', marketAccountId).order('started_at', { ascending: false }).limit(1).maybeSingle()
    if (error) throw new Error('Sync status lookup failed')
    if (!data) return null
    return {
      runId: data.id,
      status: data.status,
      periodStart: data.period_start,
      periodEnd: data.period_end,
      startedAt: data.started_at,
      heartbeatAt: data.heartbeat_at,
      finishedAt: data.finished_at,
      ordersRead: data.orders_read,
      ordersInserted: data.orders_inserted,
      ordersUpdated: data.orders_updated,
      itemsProcessed: data.items_processed,
      paymentsProcessed: data.payments_processed,
      skippedOrders: data.skipped_orders,
      errorMessage: data.error_message,
    } as SyncRunStatus
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') {
    return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Metodo nao permitido.' } }, 405)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const encryptionKey = Deno.env.get(ENCRYPTION_SECRET_NAME)
  if (!supabaseUrl || !anonKey || !serviceRoleKey || !encryptionKey) {
    console.error('market-sales-sync: configuracao server-side ausente')
    return json({ error: { code: 'SERVICE_NOT_CONFIGURED', message: 'Servico nao configurado.' } }, 503)
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Autenticacao necessaria.' } }, 401)
  }
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: authData, error: authError } = await userClient.auth.getUser(authorization.slice(7))
  if (authError || !authData.user) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Sessao invalida.' } }, 401)
  }

  let body: unknown
  try {
    const contentLength = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(contentLength) && contentLength > 32_768) throw new Error('Payload too large')
    const rawBody = await request.text()
    if (new TextEncoder().encode(rawBody).byteLength > 32_768) throw new Error('Payload too large')
    body = JSON.parse(rawBody)
  } catch {
    return json({ error: { code: 'INVALID_REQUEST', message: 'JSON invalido.' } }, 400)
  }

  try {
    const repository = new SupabaseSalesSyncRepository(serviceClient, userClient)
    if (body && typeof body === 'object' && !Array.isArray(body) &&
        (body as Record<string, unknown>).action === 'status') {
      const result = await getSalesSyncStatus(authData.user.id, body, repository)
      return json(result as unknown as Record<string, unknown>)
    }
    const result = await executeSalesSync(authData.user.id, body, {
      repository,
      decryptCredential: (ciphertext) => decryptPassword(postgresByteaToBytes(ciphertext), encryptionKey),
      validateProviderUrl: normalizeAndValidateProviderUrl,
      createProvider: (configuration) => createAccesysOrdersProvider(configuration),
    })
    return json(result.summary as unknown as Record<string, unknown>, result.httpStatus)
  } catch (error) {
    const apiError = error instanceof SyncApiError
      ? error
      : new SyncApiError('INTERNAL_ERROR', 'Erro interno ao iniciar sincronizacao.', 500)
    console.error('market-sales-sync: solicitacao rejeitada', { code: apiError.code })
    return json({ error: { code: apiError.code, message: apiError.message } }, apiError.status)
  }
})
