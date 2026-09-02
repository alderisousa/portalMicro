import { mapAccesysOrder } from './accesysMapper.ts'
import type { AccesysOrdersProvider } from './provider.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const PAGE_SIZE = 100
const MAX_PAGES = 10_000
const MAX_RESPONSE_DETAILS = 50

export type SyncStatus = 'completed' | 'partial' | 'failed'

export type SyncIntegration = {
  id: string
  market_account_id: string
  provider: string
  base_url: string
  external_company_id: string
  status: string
}

export type SyncCredential = { username: string; password_ciphertext: string }
export type StoreMapping = { id: string; external_store_id: string }
export type RpcResult = {
  saleId: string
  inserted: boolean
  itemsProcessed: number
  paymentsProcessed: number
}

export type RunCounters = {
  pagesRead: number
  ordersRead: number
  ordersInserted: number
  ordersUpdated: number
  itemsProcessed: number
  paymentsProcessed: number
  skippedOrders: number
}

type SyncErrorSummary = {
  externalOrderId: string | null
  externalStoreId: string | null
  code: string
}

export type SyncSummary = RunCounters & {
  syncRunId: string
  status: SyncStatus
  period: { startDate: string; endDate: string }
  unmappedSites: Array<{ externalStoreId: string; siteName: string | null }>
  errors: SyncErrorSummary[]
}

export interface SalesSyncRepository {
  isGlobalAdmin(userId: string): Promise<boolean>
  marketAccountExists(marketAccountId: string): Promise<boolean>
  getIntegration(marketAccountId: string, integrationId: string): Promise<SyncIntegration | null>
  getCredential(marketAccountId: string, integrationId: string): Promise<SyncCredential | null>
  getStoreMappings(marketAccountId: string, integrationId: string): Promise<StoreMapping[]>
  beginRun(input: {
    marketAccountId: string
    integrationId: string
    startDate: string
    endDate: string
    requestedBy: string
  }): Promise<string>
  heartbeatRun(runId: string, marketAccountId: string): Promise<void>
  finishRun(runId: string, marketAccountId: string, status: SyncStatus, counters: RunCounters, error: string | null): Promise<void>
  recordOrderError(input: {
    marketAccountId: string
    runId: string
    externalOrderId: string | null
    externalStoreId: string | null
    code: string
    message: string
  }): Promise<void>
  upsertSale(input: {
    marketAccountId: string
    integrationId: string
    storeExternalRefId: string
    sale: unknown
    items: unknown[]
    payments: unknown[]
  }): Promise<RpcResult>
}

export class SyncApiError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export type SyncDependencies = {
  repository: SalesSyncRepository
  decryptCredential(ciphertext: string): Promise<string>
  validateProviderUrl(provider: string, baseUrl: string): string
  createProvider(configuration: {
    provider: string
    baseUrl: string
    externalCompanyId: string
    username: string
    password: string
  }): Promise<AccesysOrdersProvider>
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncApiError('INVALID_REQUEST', `${label} invalido.`, 400)
  }
  return value as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, name: string) {
  const value = body[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new SyncApiError('INVALID_REQUEST', `Campo ${name} invalido.`, 400)
  }
  return value.trim()
}

function requiredUuid(body: Record<string, unknown>, name: string) {
  const value = requiredString(body, name)
  if (!UUID.test(value)) throw new SyncApiError('INVALID_REQUEST', `Campo ${name} invalido.`, 400)
  return value
}

function parseDate(body: Record<string, unknown>, name: string) {
  const value = requiredString(body, name)
  const match = DATE.exec(value)
  if (!match) throw new SyncApiError('INVALID_REQUEST', `Campo ${name} invalido.`, 400)
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new SyncApiError('INVALID_REQUEST', `Campo ${name} invalido.`, 400)
  }
  return { value, timestamp }
}

function safeExternalId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return null
}

function rawOrderIdentity(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { externalOrderId: null, externalStoreId: null, siteName: null }
  }
  const record = value as Record<string, unknown>
  const order = record.order && typeof record.order === 'object' && !Array.isArray(record.order)
    ? record.order as Record<string, unknown>
    : {}
  return {
    externalOrderId: safeExternalId(order.id),
    externalStoreId: safeExternalId(order.siteId),
    siteName: typeof order.siteName === 'string' ? order.siteName.trim().slice(0, 200) || null : null,
  }
}

function validatePage(value: unknown, expectedPage: number) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SyncApiError('PROVIDER_INVALID_RESPONSE', 'Estrutura global do provider invalida.', 502)
  }
  const page = value as Record<string, unknown>
  const pageNumber = page.page
  const pages = page.pages
  const records = page.records
  if (!Number.isInteger(pageNumber) || pageNumber !== expectedPage ||
      !Number.isInteger(pages) || (pages as number) < 1 || (pages as number) > MAX_PAGES ||
      expectedPage > (pages as number) ||
      !Number.isInteger(records) || (records as number) < 0 || !Array.isArray(page.items)) {
    throw new SyncApiError('PROVIDER_INVALID_RESPONSE', 'Paginacao ou estrutura global invalida.', 502)
  }
  return { pages: pages as number, items: page.items as unknown[] }
}

function sanitizedGlobalError(error: unknown) {
  if (error instanceof SyncApiError) return { code: error.code, message: error.message, status: error.status }
  const candidate = error as { code?: unknown; status?: unknown }
  const allowed = ['AUTHENTICATION_FAILED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']
  const code = typeof candidate?.code === 'string' && allowed.includes(candidate.code)
    ? candidate.code
    : 'INTERNAL_ERROR'
  const status = typeof candidate?.status === 'number' ? candidate.status : 500
  const messages: Record<string, string> = {
    AUTHENTICATION_FAILED: 'Autenticacao no provider falhou.',
    PROVIDER_TIMEOUT: 'O provider nao respondeu no prazo esperado.',
    PROVIDER_UNAVAILABLE: 'O provider esta indisponivel.',
    INTERNAL_ERROR: 'A sincronizacao nao pode ser concluida.',
  }
  return { code, message: messages[code], status }
}

const emptyCounters = (): RunCounters => ({
  pagesRead: 0, ordersRead: 0, ordersInserted: 0, ordersUpdated: 0,
  itemsProcessed: 0, paymentsProcessed: 0, skippedOrders: 0,
})

export async function executeSalesSync(userId: string, input: unknown, dependencies: SyncDependencies) {
  const body = asObject(input, 'Corpo da requisicao')
  const marketAccountId = requiredUuid(body, 'marketAccountId')
  const integrationId = requiredUuid(body, 'integrationId')
  const start = parseDate(body, 'startDate')
  const end = parseDate(body, 'endDate')
  const days = Math.floor((end.timestamp - start.timestamp) / 86_400_000) + 1
  if (days < 1 || days > 31) {
    throw new SyncApiError('INVALID_PERIOD', 'O periodo deve ter entre 1 e 31 dias.', 400)
  }
  if (!await dependencies.repository.isGlobalAdmin(userId)) {
    throw new SyncApiError('FORBIDDEN', 'Apenas o Admin global pode executar sincronizacoes.', 403)
  }
  if (!await dependencies.repository.marketAccountExists(marketAccountId)) {
    throw new SyncApiError('MARKET_ACCOUNT_NOT_FOUND', 'Conta Market nao encontrada ou indisponivel.', 404)
  }
  const integration = await dependencies.repository.getIntegration(marketAccountId, integrationId)
  if (!integration || integration.provider !== 'accesys' || integration.status !== 'active' ||
      !integration.external_company_id.trim()) {
    throw new SyncApiError('INTEGRATION_UNAVAILABLE', 'Integracao Accesys ativa nao encontrada.', 404)
  }
  let baseUrl: string
  try {
    baseUrl = dependencies.validateProviderUrl(integration.provider, integration.base_url)
  } catch {
    throw new SyncApiError('INTEGRATION_UNAVAILABLE', 'Configuracao do provider invalida.', 422)
  }
  const credential = await dependencies.repository.getCredential(marketAccountId, integrationId)
  if (!credential?.username.trim() || !credential.password_ciphertext) {
    throw new SyncApiError('CREDENTIALS_NOT_CONFIGURED', 'Credenciais nao configuradas.', 422)
  }
  let clearPassword: string
  try {
    clearPassword = await dependencies.decryptCredential(credential.password_ciphertext)
  } catch {
    throw new SyncApiError('CREDENTIALS_UNAVAILABLE', 'Credenciais nao puderam ser utilizadas.', 500)
  }

  const runId = await dependencies.repository.beginRun({
    marketAccountId, integrationId, startDate: start.value, endDate: end.value, requestedBy: userId,
  })
  const counters = emptyCounters()
  const errors: SyncErrorSummary[] = []
  const unmappedSites = new Map<string, string | null>()
  const summary = (status: SyncStatus): SyncSummary => ({
    syncRunId: runId,
    status,
    period: { startDate: start.value, endDate: end.value },
    ...counters,
    unmappedSites: Array.from(unmappedSites, ([externalStoreId, siteName]) => ({ externalStoreId, siteName }))
      .slice(0, MAX_RESPONSE_DETAILS),
    errors: errors.slice(0, MAX_RESPONSE_DETAILS),
  })

  try {
    const mappings = await dependencies.repository.getStoreMappings(marketAccountId, integrationId)
    const storeRefs = new Map(mappings.map((mapping) => [mapping.external_store_id, mapping.id]))
    const provider = await dependencies.createProvider({
      provider: integration.provider,
      baseUrl,
      externalCompanyId: integration.external_company_id,
      username: credential.username,
      password: clearPassword,
    })
    clearPassword = ''

    let currentPage = 1
    let expectedPages: number | null = null
    while (true) {
      const payload = await provider.fetchOrdersPage({
        startDate: start.value, endDate: end.value, page: currentPage, pageSize: PAGE_SIZE,
      })
      const page = validatePage(payload, currentPage)
      if (expectedPages === null) expectedPages = page.pages
      if (page.pages !== expectedPages) {
        throw new SyncApiError('PROVIDER_INVALID_RESPONSE', 'Quantidade de paginas mudou durante a consulta.', 502)
      }
      counters.pagesRead += 1

      for (const rawOrder of page.items) {
        counters.ordersRead += 1
        const identity = rawOrderIdentity(rawOrder)
        let stage: 'mapping' | 'persistence' = 'mapping'
        try {
          const mapped = mapAccesysOrder(rawOrder)
          const storeExternalRefId = storeRefs.get(mapped.sale.externalStoreId)
          if (!storeExternalRefId) {
            if (unmappedSites.size < MAX_RESPONSE_DETAILS) {
              unmappedSites.set(mapped.sale.externalStoreId, identity.siteName)
            }
            throw new SyncApiError('STORE_MAPPING_NOT_FOUND', 'Loja externa sem mapeamento configurado.', 422)
          }
          stage = 'persistence'
          const result = await dependencies.repository.upsertSale({
            marketAccountId,
            integrationId,
            storeExternalRefId,
            sale: mapped.sale,
            items: mapped.items,
            payments: mapped.payments,
          })
          if (result.inserted) counters.ordersInserted += 1
          else counters.ordersUpdated += 1
          counters.itemsProcessed += result.itemsProcessed
          counters.paymentsProcessed += result.paymentsProcessed
        } catch (error) {
          counters.skippedOrders += 1
          const code = error instanceof SyncApiError
            ? error.code
            : stage === 'mapping'
              ? 'ORDER_MAPPING_FAILED'
              : 'SALE_PERSISTENCE_FAILED'
          const message = code === 'STORE_MAPPING_NOT_FOUND'
            ? 'Loja externa sem mapeamento configurado.'
            : code === 'ORDER_MAPPING_FAILED'
              ? 'Pedido rejeitado durante a normalizacao.'
              : 'Pedido rejeitado durante a persistencia.'
          const detail = {
            externalOrderId: identity.externalOrderId,
            externalStoreId: identity.externalStoreId,
            code,
          }
          if (errors.length < MAX_RESPONSE_DETAILS) errors.push(detail)
          await dependencies.repository.recordOrderError({
            marketAccountId,
            runId,
            ...detail,
            message,
          })
        }
      }

      await dependencies.repository.heartbeatRun(runId, marketAccountId)

      if (currentPage >= expectedPages) break
      currentPage += 1
    }

    const status: SyncStatus = counters.skippedOrders > 0 ? 'partial' : 'completed'
    await dependencies.repository.finishRun(runId, marketAccountId, status, counters, null)
    return { summary: summary(status), httpStatus: 200 }
  } catch (error) {
    clearPassword = ''
    const failure = sanitizedGlobalError(error)
    try {
      await dependencies.repository.finishRun(runId, marketAccountId, 'failed', counters, failure.message)
    } catch {
      // Best effort: nao substitui nem expoe a falha global original.
    }
    return { summary: summary('failed'), httpStatus: failure.status }
  }
}
