import assert from 'node:assert/strict'
import test from 'node:test'
import {
  executeSalesSync,
  getSalesSyncStatus,
  marketOperationalWindow,
  SyncApiError,
  type RunCounters,
  type SalesSyncRepository,
  type SyncStatus,
} from './core.ts'
import { createAccesysOrdersProvider, type AccesysOrdersProvider } from './provider.ts'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const STORE_REF_ID = '44444444-4444-4444-8444-444444444444'
const RUN_ID = '55555555-5555-4555-8555-555555555555'

function order(id = 100, siteId = 2511) {
  return {
    order: {
      id, siteId, siteName: `Site ${siteId}`, customerName: 'Pessoa Privada',
      customerDocument: '00000000000', itemsSumQuantity: 1,
      itemsTotalValue: 'R$ 10,00', discountsAmount: 'R$ 0,00',
      couponValue: 'R$ 0,00', totalValue: 'R$ 10,00', createdAt: '02-09-2026 10:00:00',
    },
    orderItems: [{
      id: id * 10, productId: 90, sku: '789', description: 'Item', quantity: 1,
      unitValue: 'R$ 10,00', salePrice: 'R$ 10,00', totalValue: 'R$ 10,00',
      discount: 'R$ 0,00', netValue: 'R$ 10,00',
    }],
    orderPayments: [{
      id: id * 100, description: 'PIX', amount: 'R$ 10,00', date: '02-09-2026 10:01:00',
      detailDescription: null, detailBrand: null, detailCardType: null, authorizationId: null,
    }],
    orderStatuses: [{ status: 'FINALIZED', refunded: false, error: false }],
  }
}

const request = () => ({
  marketAccountId: ACCOUNT_ID,
  integrationId: INTEGRATION_ID,
  startDate: '2026-09-01',
  endDate: '2026-09-02',
})

class MemoryRepository implements SalesSyncRepository {
  globalAdmin = true
  marketRole = false
  memberRole = 'viewer'
  memberActive = true
  accountExists = true
  integration = {
    id: INTEGRATION_ID, market_account_id: ACCOUNT_ID, provider: 'accesys',
    base_url: 'https://apigateway.accesyslab.com.br', external_company_id: '434', status: 'active',
  }
  credential = { username: 'sync@example.invalid', password_ciphertext: '\\x0102' }
  eligibleIntegrations = [this.integration]
  mappings = [{ id: STORE_REF_ID, external_store_id: '2511' }]
  errors: Array<Record<string, unknown>> = []
  finishes: Array<{ status: SyncStatus; counters: RunCounters; error: string | null }> = []
  heartbeats: string[] = []
  beginError: Error | null = null
  persisted = new Set<string>()
  rpcFailureIds = new Set<string>()
  credentialCalls = 0
  latestRun = null as Awaited<ReturnType<SalesSyncRepository['getLatestRun']>>

  async isGlobalAdmin() { return this.globalAdmin }
  async hasMarketRole(_marketAccountId: string, roles: string[]) {
    return this.marketRole && this.memberActive && roles.includes(this.memberRole)
  }
  async marketAccountExists() { return this.accountExists }
  async getIntegration() { return this.integration }
  async getEligibleIntegrations() { return this.eligibleIntegrations }
  async getCredential() { this.credentialCalls += 1; return this.credential }
  async getStoreMappings() { return this.mappings }
  async beginRun() {
    if (this.beginError) throw this.beginError
    return RUN_ID
  }
  async heartbeatRun(runId: string) { this.heartbeats.push(runId) }
  async finishRun(_runId: string, _accountId: string, status: SyncStatus, counters: RunCounters, error: string | null) {
    this.finishes.push({ status, counters: { ...counters }, error })
  }
  async recordOrderError(input: Record<string, unknown>) { this.errors.push(input) }
  async upsertSale(input: { sale: unknown; items: unknown[]; payments: unknown[] }) {
    const id = (input.sale as { externalOrderId: string }).externalOrderId
    if (this.rpcFailureIds.has(id)) throw new Error('raw SQL provider detail')
    const inserted = !this.persisted.has(id)
    this.persisted.add(id)
    return { saleId: id, inserted, itemsProcessed: input.items.length, paymentsProcessed: input.payments.length }
  }
  async getLatestRun() { return this.latestRun }
}

class MemoryProvider implements AccesysOrdersProvider {
  calls: Array<{ page: number; pageSize: number }> = []
  readonly pages: unknown[]
  constructor(pages: unknown[]) { this.pages = pages }
  async fetchOrdersPage(input: { page: number; pageSize: number }) {
    this.calls.push({ page: input.page, pageSize: input.pageSize })
    const value = this.pages[input.page - 1]
    if (value instanceof Error) throw value
    return value
  }
}

function dependencies(repository: MemoryRepository, provider: MemoryProvider) {
  return {
    repository,
    decryptCredential: async () => 'clear-password-for-mock',
    validateProviderUrl: () => 'https://apigateway.accesyslab.com.br',
    createProvider: async () => provider,
  }
}

test('rejeita usuario que nao e Admin global antes de criar run', async () => {
  const repository = new MemoryRepository()
  repository.globalAdmin = false
  await assert.rejects(
    () => executeSalesSync(USER_ID, request(), dependencies(repository, new MemoryProvider([]))),
    (error: unknown) => error instanceof SyncApiError && error.code === 'FORBIDDEN',
  )
  assert.equal(repository.finishes.length, 0)
})

test('modo Admin global preserva integrationId e periodo manual', async () => {
  const repository = new MemoryRepository()
  const provider = new MemoryProvider([{ records: 0, page: 1, pages: 1, items: [] }])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.deepEqual(result.summary.period, { startDate: '2026-09-01', endDate: '2026-09-02' })
  assert.equal(result.summary.status, 'completed')
})

test('owner, admin e manager podem executar modo Market company-wide', async () => {
  for (const role of ['owner', 'admin', 'manager']) {
    const repository = new MemoryRepository()
    repository.globalAdmin = false
    repository.marketRole = true
    repository.memberRole = role
    const provider = new MemoryProvider([{ records: 0, page: 1, pages: 1, items: [] }])
    const result = await executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: ACCOUNT_ID }, {
      ...dependencies(repository, provider),
      now: () => new Date('2026-09-02T02:30:00Z'),
    })
    assert.equal(result.summary.status, 'completed', role)
    assert.equal(repository.eligibleIntegrations[0].id, INTEGRATION_ID)
  }
})

test('operator, viewer, invited e disabled sao negados antes de credenciais', async () => {
  for (const state of ['operator', 'viewer', 'invited', 'disabled']) {
    const repository = new MemoryRepository()
    repository.globalAdmin = false
    repository.marketRole = true
    repository.memberRole = state === 'operator' ? 'operator' : 'viewer'
    repository.memberActive = state !== 'invited' && state !== 'disabled'
    await assert.rejects(
      () => executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: ACCOUNT_ID },
        dependencies(repository, new MemoryProvider([]))),
      (error: unknown) => error instanceof SyncApiError && error.code === 'FORBIDDEN',
      state,
    )
    assert.equal(repository.credentialCalls, 0, state)
  }
})

test('modo Market rejeita campos administrativos explicitamente', async () => {
  const repository = new MemoryRepository()
  repository.globalAdmin = false
  repository.marketRole = true
  repository.memberRole = 'manager'
  for (const extra of [{ integrationId: INTEGRATION_ID }, { startDate: '2026-09-01' }, { endDate: '2026-09-02' }]) {
    await assert.rejects(
      () => executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: ACCOUNT_ID, ...extra },
        dependencies(repository, new MemoryProvider([]))),
      (error: unknown) => error instanceof SyncApiError && error.code === 'MARKET_ADMIN_FIELDS_NOT_ALLOWED',
    )
  }
  assert.equal(repository.credentialCalls, 0)
})

test('modo Market resolve uma integracao e rejeita zero ou multiplas', async () => {
  const repository = new MemoryRepository()
  repository.globalAdmin = false
  repository.marketRole = true
  repository.memberRole = 'manager'
  repository.eligibleIntegrations = []
  await assert.rejects(
    () => executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: ACCOUNT_ID }, dependencies(repository, new MemoryProvider([]))),
    (error: unknown) => error instanceof SyncApiError && error.code === 'SYNC_INTEGRATION_NOT_CONFIGURED',
  )
  repository.eligibleIntegrations = [repository.integration, { ...repository.integration, id: '66666666-6666-4666-8666-666666666666' }]
  await assert.rejects(
    () => executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: ACCOUNT_ID }, dependencies(repository, new MemoryProvider([]))),
    (error: unknown) => error instanceof SyncApiError && error.code === 'SYNC_INTEGRATION_AMBIGUOUS',
  )
})

test('conta adulterada ou nao operacional e negada antes de credenciais', async () => {
  const repository = new MemoryRepository()
  repository.globalAdmin = false
  repository.marketRole = false
  await assert.rejects(
    () => executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: '77777777-7777-4777-8777-777777777777' },
      dependencies(repository, new MemoryProvider([]))),
    (error: unknown) => error instanceof SyncApiError && error.code === 'FORBIDDEN',
  )
  repository.marketRole = true
  repository.memberRole = 'manager'
  repository.accountExists = false
  await assert.rejects(
    () => executeSalesSync(USER_ID, { action: 'refresh', marketAccountId: ACCOUNT_ID },
      dependencies(repository, new MemoryProvider([]))),
    (error: unknown) => error instanceof SyncApiError && error.code === 'MARKET_ACCOUNT_NOT_FOUND',
  )
  assert.equal(repository.credentialCalls, 0)
})

test('janela Market usa sete dias incluindo hoje em America/Sao_Paulo', () => {
  assert.deepEqual(marketOperationalWindow(new Date('2026-09-02T02:30:00Z')), {
    startDate: '2026-08-26', endDate: '2026-09-01',
  })
  assert.deepEqual(marketOperationalWindow(new Date('2026-09-02T03:30:00Z')), {
    startDate: '2026-08-27', endDate: '2026-09-02',
  })
})

test('status permite membership ativa, filtra por conta e retorna DTO sanitizado', async () => {
  for (const role of ['owner', 'admin', 'manager', 'operator', 'viewer']) {
    const repository = new MemoryRepository()
    repository.marketRole = true
    repository.memberRole = role
    repository.latestRun = {
      runId: RUN_ID, status: 'completed', periodStart: '2026-08-27', periodEnd: '2026-09-02',
      startedAt: '2026-09-02T10:00:00Z', heartbeatAt: '2026-09-02T10:01:00Z',
      finishedAt: '2026-09-02T10:01:01Z', ordersRead: 10, ordersInserted: 1,
      ordersUpdated: 9, itemsProcessed: 12, paymentsProcessed: 10, skippedOrders: 0,
      errorMessage: 'raw SQL detail that must not leave backend',
    }
    const result = await getSalesSyncStatus(USER_ID, { action: 'status', marketAccountId: ACCOUNT_ID }, repository)
    assert.equal(result.sync?.runId, RUN_ID, role)
    const serialized = JSON.stringify(result)
    for (const forbidden of ['integrationId', 'password', 'token', 'provider', 'sql', 'customer']) {
      assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, role)
    }
    assert.equal(result.sync?.errorMessage, 'A sincronizacao nao foi concluida.', role)
  }
})

test('status nega membership inativa ou conta errada e trata ausencia de run', async () => {
  const repository = new MemoryRepository()
  await assert.rejects(
    () => getSalesSyncStatus(USER_ID, { action: 'status', marketAccountId: ACCOUNT_ID }, repository),
    (error: unknown) => error instanceof SyncApiError && error.code === 'FORBIDDEN',
  )
  repository.marketRole = true
  repository.memberRole = 'viewer'
  repository.accountExists = false
  await assert.rejects(
    () => getSalesSyncStatus(USER_ID, { action: 'status', marketAccountId: ACCOUNT_ID }, repository),
    (error: unknown) => error instanceof SyncApiError && error.code === 'MARKET_ACCOUNT_NOT_FOUND',
  )
  repository.accountExists = true
  assert.deepEqual(
    await getSalesSyncStatus(USER_ID, { action: 'status', marketAccountId: ACCOUNT_ID }, repository),
    { sync: null },
  )
})

test('valida UUIDs, datas, ordem e limite inclusivo de 31 dias', async () => {
  const repository = new MemoryRepository()
  const deps = dependencies(repository, new MemoryProvider([]))
  await assert.rejects(() => executeSalesSync(USER_ID, { ...request(), integrationId: 'x' }, deps), /integrationId/)
  await assert.rejects(() => executeSalesSync(USER_ID, { ...request(), startDate: '2026-02-30' }, deps), /startDate/)
  await assert.rejects(() => executeSalesSync(USER_ID, { ...request(), startDate: '2026-09-03' }, deps), /1 e 31 dias/)
  await assert.rejects(() => executeSalesSync(USER_ID, { ...request(), startDate: '2026-07-01', endDate: '2026-08-01' }, deps), /1 e 31 dias/)
})

test('valida conta, integracao ativa Accesys e credenciais', async () => {
  const repository = new MemoryRepository()
  repository.accountExists = false
  await assert.rejects(() => executeSalesSync(USER_ID, request(), dependencies(repository, new MemoryProvider([]))), /Conta Market/)
  repository.accountExists = true
  repository.integration.status = 'inactive'
  await assert.rejects(() => executeSalesSync(USER_ID, request(), dependencies(repository, new MemoryProvider([]))), /Integracao Accesys/)
  repository.integration.status = 'active'
  repository.credential = null as never
  await assert.rejects(() => executeSalesSync(USER_ID, request(), dependencies(repository, new MemoryProvider([]))), /Credenciais/)
})

test('processa uma pagina a partir de 1 com pageSize 100 e finaliza completed', async () => {
  const repository = new MemoryRepository()
  const provider = new MemoryProvider([{ records: 1, page: 1, pages: 1, items: [order()] }])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.equal(result.httpStatus, 200)
  assert.equal(result.summary.status, 'completed')
  assert.deepEqual(provider.calls, [{ page: 1, pageSize: 100 }])
  assert.equal(result.summary.ordersInserted, 1)
  assert.equal(result.summary.itemsProcessed, 1)
  assert.equal(result.summary.paymentsProcessed, 1)
  assert.equal(repository.finishes[0].status, 'completed')
  assert.deepEqual(repository.heartbeats, [RUN_ID])
})

test('percorre multiplas paginas e para na ultima', async () => {
  const repository = new MemoryRepository()
  const provider = new MemoryProvider([
    { records: 2, page: 1, pages: 2, items: [order(100)] },
    { records: 2, page: 2, pages: 2, items: [order(101)] },
  ])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.deepEqual(provider.calls.map((call) => call.page), [1, 2])
  assert.equal(result.summary.pagesRead, 2)
  assert.equal(result.summary.ordersInserted, 2)
  assert.deepEqual(repository.heartbeats, [RUN_ID, RUN_ID])
})

test('run concorrente e rejeitado antes de criar provider ou chamar Accesys', async () => {
  const repository = new MemoryRepository()
  repository.beginError = new SyncApiError(
    'SYNC_ALREADY_RUNNING',
    'Ja existe uma sincronizacao ativa para esta integracao.',
    409,
  )
  const provider = new MemoryProvider([])
  let providerCreations = 0
  const deps = {
    ...dependencies(repository, provider),
    createProvider: async () => {
      providerCreations += 1
      return provider
    },
  }
  await assert.rejects(
    () => executeSalesSync(USER_ID, request(), deps),
    (error: unknown) => error instanceof SyncApiError &&
      error.code === 'SYNC_ALREADY_RUNNING' && error.status === 409,
  )
  assert.equal(providerCreations, 0)
  assert.equal(provider.calls.length, 0)
  assert.equal(repository.finishes.length, 0)
})

test('loja nao mapeada gera erro por pedido e run partial', async () => {
  const repository = new MemoryRepository()
  const provider = new MemoryProvider([{ records: 1, page: 1, pages: 1, items: [order(100, 2607)] }])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.equal(result.summary.status, 'partial')
  assert.equal(result.summary.skippedOrders, 1)
  assert.deepEqual(result.summary.unmappedSites, [{ externalStoreId: '2607', siteName: 'Site 2607' }])
  assert.equal(repository.errors[0].code, 'STORE_MAPPING_NOT_FOUND')
})

test('erro do mapper nao aborta os demais pedidos', async () => {
  const repository = new MemoryRepository()
  const invalid = order(100)
  invalid.order.totalValue = 'valor invalido'
  const provider = new MemoryProvider([{ records: 2, page: 1, pages: 1, items: [invalid, order(101)] }])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.equal(result.summary.status, 'partial')
  assert.equal(result.summary.skippedOrders, 1)
  assert.equal(result.summary.ordersInserted, 1)
  assert.equal(repository.errors[0].code, 'ORDER_MAPPING_FAILED')
})

test('erro isolado da RPC nao aborta outro pedido nem expoe SQL', async () => {
  const repository = new MemoryRepository()
  repository.rpcFailureIds.add('100')
  const provider = new MemoryProvider([{ records: 2, page: 1, pages: 1, items: [order(100), order(101)] }])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.equal(result.summary.ordersInserted, 1)
  assert.equal(result.summary.skippedOrders, 1)
  assert.equal(repository.errors[0].code, 'SALE_PERSISTENCE_FAILED')
  assert.equal(JSON.stringify(result).includes('raw SQL'), false)
})

test('falha global apos criar run fecha como failed com finished-at pelo repositorio', async () => {
  const repository = new MemoryRepository()
  const provider = new MemoryProvider([new Error('provider body with secret')])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.equal(result.summary.status, 'failed')
  assert.equal(result.httpStatus, 500)
  assert.equal(repository.finishes[0].status, 'failed')
  assert.equal(repository.finishes[0].error, 'A sincronizacao nao pode ser concluida.')
  assert.equal(JSON.stringify(result).includes('provider body'), false)
})

test('mudanca de pages e pagina incorreta falham defensivamente sem loop', async () => {
  const repository = new MemoryRepository()
  const provider = new MemoryProvider([
    { records: 2, page: 1, pages: 2, items: [order(100)] },
    { records: 2, page: 2, pages: 3, items: [order(101)] },
  ])
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository, provider))
  assert.equal(result.summary.status, 'failed')
  assert.equal(provider.calls.length, 2)
  const invalidPage = new MemoryProvider([{ records: 0, page: 0, pages: 1, items: [] }])
  const second = await executeSalesSync(USER_ID, request(), dependencies(new MemoryRepository(), invalidPage))
  assert.equal(second.summary.status, 'failed')
})

test('reprocessamento da mesma venda usa autoridade idempotente da RPC', async () => {
  const repository = new MemoryRepository()
  const page = { records: 1, page: 1, pages: 1, items: [order()] }
  const first = await executeSalesSync(USER_ID, request(), dependencies(repository, new MemoryProvider([page])))
  const second = await executeSalesSync(USER_ID, request(), dependencies(repository, new MemoryProvider([page])))
  assert.equal(first.summary.ordersInserted, 1)
  assert.equal(second.summary.ordersInserted, 0)
  assert.equal(second.summary.ordersUpdated, 1)
})

test('resposta limita detalhes e nunca contem credenciais, token ou PII', async () => {
  const repository = new MemoryRepository()
  repository.mappings = []
  const orders = Array.from({ length: 55 }, (_, index) => order(index + 1, 3000 + index))
  const result = await executeSalesSync(USER_ID, request(), dependencies(repository,
    new MemoryProvider([{ records: 55, page: 1, pages: 1, items: orders }])))
  assert.equal(result.summary.errors.length, 50)
  assert.equal(result.summary.unmappedSites.length, 50)
  const serialized = JSON.stringify(result)
  for (const forbidden of ['clear-password-for-mock', '\\x0102', 'Pessoa Privada', '00000000000', 'customerDocument']) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test('cliente Accesys usa login e query company-wide segura', async () => {
  const calls: string[] = []
  const fetcher = async (input: string | URL | Request) => {
    const url = input.toString()
    calls.push(url)
    return calls.length === 1 ? Response.json({ token: 'memory-only-token' }) :
      Response.json({ records: 0, page: 1, pages: 1, items: [] })
  }
  const provider = await createAccesysOrdersProvider({
    provider: 'accesys', baseUrl: 'https://apigateway.accesyslab.com.br',
    externalCompanyId: '434', username: 'user@example.invalid', password: 'test-only-password',
  }, fetcher as typeof fetch)
  await provider.fetchOrdersPage({ startDate: '2026-09-01', endDate: '2026-09-02', page: 1, pageSize: 100 })
  const url = new URL(calls[1])
  assert.equal(url.pathname, '/oar/sites/orders/search/complete')
  assert.equal(url.searchParams.get('companyId'), '434')
  assert.equal(url.searchParams.get('page'), '1')
  assert.equal(url.searchParams.get('pageSize'), '100')
  assert.equal(url.searchParams.get('startDate'), '2026-09-01 00:00:00')
  assert.equal(url.searchParams.get('endDate'), '2026-09-02 23:59:59')
})

test('nenhuma dependencia ou saida de sincronizacao possui operacao de estoque', async () => {
  const source = `${executeSalesSync.toString()} ${JSON.stringify(request())}`.toLowerCase()
  assert.equal(source.includes('market_stock'), false)
  assert.equal(source.includes('sale_out'), false)
  assert.equal(source.includes('availablequantity'), false)
})
