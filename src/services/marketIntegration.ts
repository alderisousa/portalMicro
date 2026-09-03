import { supabase } from '../lib/supabase'
import type {
  MarketIntegrationConfiguration,
  MarketProductCatalogPreview,
  MarketProductSyncRun,
  MarketSalesSyncRequest,
  MarketSalesSyncResult,
  SaveMarketIntegrationInput,
} from '../types/marketIntegration'

export const ACCESYS_BASE_URL = 'https://apigateway.accesyslab.com.br'

type IntegrationFunctionError = {
  error?: { code?: unknown; message?: unknown }
}

const errorMessages: Record<string, string> = {
  UNAUTHORIZED: 'Sua sessão expirou. Entre novamente para continuar.',
  FORBIDDEN: 'Apenas o Admin global do GiroMicro pode administrar integrações.',
  INVALID_REQUEST: 'Revise os dados informados e tente novamente.',
  MARKET_ACCOUNT_NOT_FOUND: 'A conta Market não foi encontrada ou está indisponível.',
  INTEGRATION_NOT_FOUND: 'A integração não foi encontrada nesta conta Market.',
  CREDENTIALS_NOT_CONFIGURED: 'Configure usuário e senha antes de continuar.',
  CREDENTIALS_UNAVAILABLE: 'As credenciais da integração não puderam ser utilizadas.',
  INVALID_PERIOD: 'O período deve ter no máximo 31 dias.',
  INTEGRATION_UNAVAILABLE: 'Ative e configure a integração Accesys antes de sincronizar.',
  PRODUCT_SYNC_ALREADY_RUNNING: 'Já existe uma sincronização de produtos ativa. Atualize o status para continuar.',
  PRODUCT_SYNC_NOT_FOUND: 'A execução de produtos não foi encontrada.',
  PRODUCT_SYNC_FAILED: 'Não foi possível processar esta página do catálogo.',
  PROVIDER_INVALID_RESPONSE: 'A Accesys retornou uma resposta inesperada. Tente novamente.',
  INVALID_PROVIDER: 'Este provider ainda não é suportado.',
  INVALID_PROVIDER_URL: 'A URL configurada não é permitida para a Accesys.',
  AUTHENTICATION_FAILED: 'Falha na autenticação da integração. Confira usuário e senha.',
  PROVIDER_UNAVAILABLE: 'A Accesys está indisponível ou recusou a empresa informada.',
  PROVIDER_TIMEOUT: 'A Accesys não respondeu no prazo esperado.',
  INTERNAL_ERROR: 'Não foi possível concluir a operação da integração.',
  SERVICE_NOT_CONFIGURED: 'O serviço de integrações ainda não está configurado.',
}

export class MarketIntegrationError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(errorMessages[code] ?? message ?? 'Não foi possível administrar a integração.')
    this.code = code
  }
}

const throwFunctionError = async (error: unknown): Promise<never> => {
  let payload: IntegrationFunctionError | null = null
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      payload = await context.clone().json().catch(() => null) as IntegrationFunctionError | null
    }
  }
  const code = typeof payload?.error?.code === 'string' ? payload.error.code : 'INTERNAL_ERROR'
  const message = typeof payload?.error?.message === 'string' ? payload.error.message : undefined
  throw new MarketIntegrationError(code, message)
}

const invokeIntegrationAdmin = async <T>(body: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.functions.invoke('market-integration-admin', { body })
  if (error) return throwFunctionError(error)
  if (!data || typeof data !== 'object') throw new MarketIntegrationError('INTERNAL_ERROR')
  return data as T
}

export async function findAccesysIntegrationId(marketAccountId: string) {
  const { data, error } = await supabase
    .from('market_integrations')
    .select('id')
    .eq('market_account_id', marketAccountId)
    .eq('provider', 'accesys')
    .order('created_at', { ascending: true })
    .limit(2)
  if (error) throw new MarketIntegrationError('INTERNAL_ERROR')
  if ((data?.length ?? 0) > 1) {
    throw new MarketIntegrationError(
      'INVALID_REQUEST',
      'Há mais de uma integração Accesys nesta conta. Revise a configuração antes de continuar.',
    )
  }
  return data?.[0]?.id as string | undefined
}

export async function getMarketIntegration(
  marketAccountId: string,
  integrationId: string,
) {
  const data = await invokeIntegrationAdmin<{ integration: MarketIntegrationConfiguration }>({
    action: 'get', marketAccountId, integrationId,
  })
  return data.integration
}

export async function saveMarketIntegration(input: SaveMarketIntegrationInput) {
  const body: Record<string, unknown> = {
    action: 'save',
    marketAccountId: input.marketAccountId,
    provider: 'accesys',
    baseUrl: ACCESYS_BASE_URL,
    externalCompanyId: input.externalCompanyId.trim(),
    username: input.username.trim(),
    status: input.status,
  }
  if (input.integrationId) body.integrationId = input.integrationId
  if (input.password) body.password = input.password

  const data = await invokeIntegrationAdmin<{ integration: MarketIntegrationConfiguration }>(body)
  return data.integration
}

export async function testMarketIntegration(marketAccountId: string, integrationId: string) {
  return invokeIntegrationAdmin<{ succeeded: true; testedAt: string }>({
    action: 'test', marketAccountId, integrationId,
  })
}

export async function previewMarketProducts(
  marketAccountId: string,
  integrationId: string,
  page = 1,
) {
  const data = await invokeIntegrationAdmin<{
    mode: 'preview'; persisted: false; preview: MarketProductCatalogPreview
  }>({
    action: 'sync-products', mode: 'preview', marketAccountId, integrationId, page, pageSize: 5,
  })
  return data.preview
}

export async function getMarketProductSyncStatus(marketAccountId: string, integrationId: string) {
  const data = await invokeIntegrationAdmin<{ mode: 'status'; run: MarketProductSyncRun | null; lastCompletedRun: MarketProductSyncRun | null }>({
    action: 'sync-products', mode: 'status', marketAccountId, integrationId,
  })
  return { run: data.run, lastCompletedRun: data.lastCompletedRun }
}

export async function syncMarketProductsPage(marketAccountId: string, integrationId: string, runId?: string) {
  const data = await invokeIntegrationAdmin<{ mode: 'sync'; run: MarketProductSyncRun }>({
    action: 'sync-products', mode: 'sync', marketAccountId, integrationId,
    ...(runId ? { runId } : {}),
  })
  return data.run
}

export async function synchronizeMarketProducts(
  marketAccountId: string,
  integrationId: string,
  source: 'admin' | 'inventory' = 'admin',
  currentRun?: MarketProductSyncRun | null,
  onProgress?: (run: MarketProductSyncRun) => void,
) {
  let runId = currentRun?.status === 'running' ? currentRun.id : undefined
  let run = await invokeIntegrationAdmin<{ mode: 'sync'; run: MarketProductSyncRun }>({
    action: 'sync-products', mode: 'sync', source, marketAccountId, integrationId,
    ...(runId ? { runId } : {}),
  }).then((result) => result.run)
  onProgress?.(run)
  while (run.status === 'running') {
    runId = run.id
    run = await invokeIntegrationAdmin<{ mode: 'sync'; run: MarketProductSyncRun }>({
      action: 'sync-products', mode: 'sync', source, marketAccountId, integrationId, runId,
    }).then((result) => result.run)
    onProgress?.(run)
  }
  return run
}

const isSalesSyncResult = (value: unknown): value is MarketSalesSyncResult => {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return typeof result.syncRunId === 'string' &&
    (result.status === 'running' || result.status === 'completed' || result.status === 'partial' || result.status === 'failed') &&
    typeof result.pagesRead === 'number' && typeof result.ordersRead === 'number' &&
    typeof result.ordersInserted === 'number' && typeof result.ordersUpdated === 'number' &&
    typeof result.itemsProcessed === 'number' && typeof result.paymentsProcessed === 'number' &&
    typeof result.skippedOrders === 'number' && Array.isArray(result.unmappedSites) &&
    Array.isArray(result.errors) && typeof result.totalDays === 'number' &&
    typeof result.completedDays === 'number' && typeof result.continue === 'boolean'
}

export async function syncMarketSales(input: MarketSalesSyncRequest) {
  const { data, error } = await supabase.functions.invoke('market-sales-sync', {
    body: {
      marketAccountId: input.marketAccountId,
      integrationId: input.integrationId,
      startDate: input.startDate,
      endDate: input.endDate,
      ...(input.runId ? { runId: input.runId } : {}),
    },
  })
  if (!error) {
    if (!isSalesSyncResult(data)) throw new MarketIntegrationError('INTERNAL_ERROR')
    return data
  }

  if (typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      const payload = await context.clone().json().catch(() => null)
      if (isSalesSyncResult(payload)) return payload
    }
  }
  return throwFunctionError(error)
}
