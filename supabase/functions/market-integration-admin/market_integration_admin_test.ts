import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { ApiError, executeAction, type Integration, type IntegrationRepository } from './core.ts'
import {
  bytesToPostgresBytea,
  decryptPassword,
  encryptPassword,
  postgresByteaToBytes,
} from './crypto.ts'
import { normalizeAndValidateProviderUrl, previewAccesysProducts, ProviderError, testAccesysConnection } from './providers.ts'
import type { ProductSyncRun } from './productSync.ts'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
const adminIntegrationSource = readFileSync(new URL('../../../src/pages/AdminMarketIntegration.tsx', import.meta.url), 'utf8')
const integrationServiceSource = readFileSync(new URL('../../../src/services/marketIntegration.ts', import.meta.url), 'utf8')
const integrationCoreSource = readFileSync(new URL('./core.ts', import.meta.url), 'utf8')

test('AES-256-GCM encrypts and decrypts without exposing cleartext in the envelope', async () => {
  const envelope = await encryptPassword('correct horse battery staple', KEY)
  assert.equal(new TextDecoder().decode(envelope).includes('correct horse'), false)
  assert.equal(await decryptPassword(envelope, KEY), 'correct horse battery staple')
  assert.deepEqual(postgresByteaToBytes(bytesToPostgresBytea(envelope)), envelope)
})

test('AES-256-GCM rejects a wrong key and malformed envelope', async () => {
  const envelope = await encryptPassword('secret', KEY)
  const wrongKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  await assert.rejects(() => decryptPassword(envelope, wrongKey), /Unable to decrypt/)
  await assert.rejects(
    () => decryptPassword(new TextEncoder().encode('{"v":1}'), KEY),
    /Invalid encrypted password envelope/,
  )
})

test('provider URL allowlist blocks invalid provider, HTTP, localhost and URL paths', () => {
  assert.equal(
    normalizeAndValidateProviderUrl('accesys', 'https://apigateway.accesyslab.com.br/'),
    'https://apigateway.accesyslab.com.br',
  )
  for (const [provider, url] of [
    ['other', 'https://apigateway.accesyslab.com.br'],
    ['accesys', 'http://apigateway.accesyslab.com.br'],
    ['accesys', 'https://127.0.0.1'],
    ['accesys', 'https://apigateway.accesyslab.com.br/evil'],
  ]) {
    assert.throws(() => normalizeAndValidateProviderUrl(provider, url), ProviderError)
  }
})

test('Accesys wrong password returns a sanitized authentication error', async () => {
  const fetcher = async () => new Response('{"internal":"sensitive provider body"}', { status: 401 })
  await assert.rejects(
    () => testAccesysConnection({
      provider: 'accesys',
      baseUrl: 'https://apigateway.accesyslab.com.br',
      externalCompanyId: '434',
      username: 'user@example.com',
      password: 'wrong-password',
    }, fetcher as typeof fetch),
    (error: unknown) => error instanceof ProviderError &&
      error.code === 'AUTHENTICATION_FAILED' &&
      !error.message.includes('sensitive provider body') &&
      !error.message.includes('wrong-password'),
  )
})

test('Accesys test authenticates and performs one minimal company-scoped read', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString()
    calls.push({ url, init })
    if (calls.length === 1) {
      return Response.json({ token: 'ephemeral-token' })
    }
    return Response.json({ content: [] })
  }
  await testAccesysConnection({
    provider: 'accesys',
    baseUrl: 'https://apigateway.accesyslab.com.br',
    externalCompanyId: 'company-xyz',
    username: 'user@example.com',
    password: 'secret',
  }, fetcher as typeof fetch)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.endsWith('/oar/users/login'), true)
  const validationUrl = new URL(calls[1].url)
  assert.equal(validationUrl.pathname, '/oar/sites/products/search')
  assert.equal(validationUrl.searchParams.get('companyId'), 'company-xyz')
  assert.equal(validationUrl.searchParams.get('pageSize'), '1')
  assert.equal(validationUrl.searchParams.get('page'), '1')
  assert.equal(new Headers(calls[1].init?.headers).get('Authorization'), 'Bearer ephemeral-token')
})

const integration = (): Integration => ({
  id: INTEGRATION_ID,
  market_account_id: ACCOUNT_ID,
  provider: 'accesys',
  base_url: 'https://apigateway.accesyslab.com.br',
  external_company_id: '434',
  status: 'inactive',
  last_test_at: null,
  last_test_succeeded: null,
  last_test_error: null,
})

class MemoryRepository implements IntegrationRepository {
  globalAdmin = true
  marketRole = false
  memberRole = 'viewer'
  accountExists = true
  integration = integration()
  credential: { username: string; password_ciphertext: string } | null = null
  passwordWrite: string | undefined
  writes = 0
  productRun: ProductSyncRun | null = null
  appliedProducts: unknown[] = []

  async isGlobalAdmin() { return this.globalAdmin }
  async hasMarketRole(_accountId: string, roles: string[]) { return this.marketRole && roles.includes(this.memberRole) }
  async marketAccountExists() { return this.accountExists }
  async getIntegration() { return this.integration }
  async createIntegration(input: Omit<Integration, 'id' | 'last_test_at' | 'last_test_succeeded' | 'last_test_error'>) {
    this.writes += 1
    this.integration = { ...integration(), ...input }
    return this.integration
  }
  async updateIntegration(_account: string, _id: string, input: Partial<Integration>) {
    this.writes += 1
    this.integration = { ...this.integration, ...input }
    return this.integration
  }
  async getCredential() { return this.credential }
  async saveCredential(input: { username: string; passwordCiphertext?: string }) {
    this.writes += 1
    this.passwordWrite = input.passwordCiphertext
    this.credential = {
      username: input.username,
      password_ciphertext: input.passwordCiphertext ?? this.credential!.password_ciphertext,
    }
  }
  async updateTestResult() { this.writes += 1 }
  async beginProductSync(marketAccountId: string, integrationId: string, _user: string | null, pageSize: number): Promise<ProductSyncRun> {
    return this.productRun = { id: '44444444-4444-4444-8444-444444444444', marketAccountId, integrationId,
      status: 'running', currentPage: 0, totalPages: null, pageSize, receivedCount: 0, createdCount: 0,
      updatedCount: 0, unchangedCount: 0, ignoredCount: 0, errorCode: null, errorMessage: null,
      startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), finishedAt: null }
  }
  async getProductSyncRun(): Promise<ProductSyncRun | null> { return this.productRun }
  async getLastCompletedProductSyncRun(): Promise<ProductSyncRun | null> { return this.productRun?.status === 'completed' ? this.productRun : null }
  async applyProductSyncPage(_id: string, _account: string, page: number, pages: number, _records: number, products: unknown[]): Promise<ProductSyncRun> {
    this.appliedProducts = products
    return this.productRun = { ...this.productRun!, currentPage: page, totalPages: pages,
      receivedCount: products.length, status: page >= pages ? 'completed' : 'running' }
  }
  async recordProductSyncError() {}
}

const productPreviewFetcher = (payload: unknown, status = 200) => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input.toString(), init })
    return calls.length === 1
      ? Response.json({ token: 'ephemeral-token' })
      : Response.json(payload, { status })
  }
  return { calls, fetcher: fetcher as typeof fetch }
}

test('authorization rejects a user who is not a global GiroMicro Admin', async () => {
  const repository = new MemoryRepository()
  repository.globalAdmin = false
  await assert.rejects(
    () => executeAction(USER_ID, {
      action: 'get', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID,
    }, { repository, encryptionKey: KEY }),
    (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN',
  )
})

test('global Admin cannot target an unavailable or unknown Market account', async () => {
  const repository = new MemoryRepository()
  repository.accountExists = false
  await assert.rejects(
    () => executeAction(USER_ID, {
      action: 'get', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID,
    }, { repository, encryptionKey: KEY }),
    (error: unknown) => error instanceof ApiError && error.code === 'MARKET_ACCOUNT_NOT_FOUND',
  )
})

test('get never returns password ciphertext or cleartext', async () => {
  const repository = new MemoryRepository()
  repository.credential = { username: 'user@example.com', password_ciphertext: '\\xdeadbeef' }
  const result = await executeAction(USER_ID, {
    action: 'get', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID,
  }, { repository, encryptionKey: KEY })
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('password'), false)
  assert.equal(serialized.includes('deadbeef'), false)
  assert.equal(serialized.includes('user@example.com'), true)
})

test('save without password preserves existing ciphertext', async () => {
  const repository = new MemoryRepository()
  repository.credential = { username: 'old@example.com', password_ciphertext: '\\x0102' }
  const result = await executeAction(USER_ID, {
    action: 'save',
    marketAccountId: ACCOUNT_ID,
    integrationId: INTEGRATION_ID,
    provider: 'accesys',
    baseUrl: 'https://apigateway.accesyslab.com.br',
    externalCompanyId: '434',
    username: 'new@example.com',
  }, { repository, encryptionKey: KEY })
  assert.equal(repository.passwordWrite, undefined)
  assert.equal(repository.credential.password_ciphertext, '\\x0102')
  assert.equal(JSON.stringify(result).includes('0102'), false)
})

test('test action rejects missing credentials', async () => {
  const repository = new MemoryRepository()
  await assert.rejects(
    () => executeAction(USER_ID, {
      action: 'test', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID,
    }, { repository, encryptionKey: KEY }),
    (error: unknown) => error instanceof ApiError && error.code === 'CREDENTIALS_NOT_CONFIGURED',
  )
})

test('preview preserva campos reais limita amostra e nao expoe secrets', async () => {
  const provider = productPreviewFetcher({
    content: [
      { productId: 1, sku: '789', description: 'Produto 1', nested: { active: true }, token: 'provider-secret' },
      { productId: 2, sku: null, description: 'Produto 2' },
      { productId: 3, description: 'Produto 3' },
    ],
    page: 1,
    totalPages: 7,
    totalElements: 33,
  })
  const result = await previewAccesysProducts({
    provider: 'accesys', baseUrl: 'https://apigateway.accesyslab.com.br',
    externalCompanyId: 'company-xyz', username: 'user@example.com', password: 'clear-password',
  }, 1, 5, provider.fetcher)
  assert.equal(result.providerHttpStatus, 200)
  assert.deepEqual(result.rootKeys, ['content', 'page', 'totalPages', 'totalElements'])
  assert.equal(result.collectionKey, 'content')
  assert.equal(result.returnedCount, 3)
  assert.deepEqual(result.productKeys, ['productId', 'sku', 'description', 'nested', 'token'])
  assert.deepEqual(result.paginationMetadata, { page: 1, totalPages: 7, totalElements: 33 })
  assert.equal(result.products.length, 2)
  assert.equal((result.products[0] as Record<string, unknown>).token, '[redacted]')
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('ephemeral-token'), false)
  assert.equal(serialized.includes('clear-password'), false)
  assert.equal(provider.calls[1].url.includes('companyId=company-xyz'), true)
  assert.equal(provider.calls[1].url.includes('pageSize=5'), true)
  assert.equal(provider.calls[1].url.includes('page=1'), true)
})

test('sync-products preview exige Admin integracao ativa e nunca persiste produtos', async () => {
  const repository = new MemoryRepository()
  repository.integration.status = 'active'
  repository.credential = { username: 'user@example.com', password_ciphertext: bytesToPostgresBytea(await encryptPassword('secret', KEY)) }
  const provider = productPreviewFetcher({ items: [{ exactField: 'preserved' }], page: 1 })
  const input = { action: 'sync-products', mode: 'preview', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID }
  repository.globalAdmin = false
  await assert.rejects(() => executeAction(USER_ID, input, { repository, encryptionKey: KEY, fetcher: provider.fetcher }),
    (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN')
  repository.globalAdmin = true
  const result = await executeAction(USER_ID, input, { repository, encryptionKey: KEY, fetcher: provider.fetcher })
  assert.equal(result.mode, 'preview')
  assert.equal(result.persisted, false)
  assert.equal(result.preview.requestedPage, 1)
  assert.equal(result.preview.pageSize, 5)
  assert.equal(repository.writes, 0)

  repository.integration.status = 'inactive'
  await assert.rejects(() => executeAction(USER_ID, input, { repository, encryptionKey: KEY, fetcher: provider.fetcher }),
    (error: unknown) => error instanceof ApiError && error.code === 'INTEGRATION_UNAVAILABLE')
  repository.integration = null as never
  await assert.rejects(() => executeAction(USER_ID, input, { repository, encryptionKey: KEY, fetcher: provider.fetcher }),
    (error: unknown) => error instanceof ApiError && error.code === 'INTEGRATION_NOT_FOUND')
})

test('product sync manual permite owner admin manager operator e bloqueia viewer', async () => {
  for (const role of ['owner', 'admin', 'manager', 'operator']) {
    const repository = new MemoryRepository()
    repository.globalAdmin = false; repository.marketRole = true; repository.memberRole = role
    repository.integration.status = 'active'
    repository.credential = { username: 'u', password_ciphertext: bytesToPostgresBytea(await encryptPassword('p', KEY)) }
    const provider = productPreviewFetcher({ records: 0, page: 1, pages: 1, items: [] })
    const result = await executeAction(USER_ID, { action: 'sync-products', mode: 'sync', marketAccountId: ACCOUNT_ID,
      integrationId: INTEGRATION_ID }, { repository, encryptionKey: KEY, fetcher: provider.fetcher }, { productSource: 'inventory' })
    assert.equal(result.mode, 'sync', role)
  }
  const viewer = new MemoryRepository()
  viewer.globalAdmin = false; viewer.marketRole = true; viewer.memberRole = 'viewer'
  await assert.rejects(() => executeAction(USER_ID, { action: 'sync-products', mode: 'sync', marketAccountId: ACCOUNT_ID,
    integrationId: INTEGRATION_ID }, { repository: viewer, encryptionKey: KEY }),
  (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN')
})

test('viewer pode consultar ultima sincronizacao mas nao iniciar product sync', async () => {
  const repository = new MemoryRepository()
  repository.globalAdmin = false; repository.marketRole = true; repository.memberRole = 'viewer'
  const status = await executeAction(USER_ID, { action: 'sync-products', mode: 'status',
    marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID }, { repository, encryptionKey: KEY })
  assert.equal(status.mode, 'status')
  await assert.rejects(() => executeAction(USER_ID, { action: 'sync-products', mode: 'sync',
    marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID }, { repository, encryptionKey: KEY }),
  (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN')
})

test('sync-products aceita pagina controlada e rejeita pageSize acima de cinco', async () => {
  const repository = new MemoryRepository()
  repository.integration.status = 'active'
  repository.credential = { username: 'user@example.com', password_ciphertext: bytesToPostgresBytea(await encryptPassword('secret', KEY)) }
  const provider = productPreviewFetcher({ content: [] })
  const base = { action: 'sync-products', mode: 'preview', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID }
  await assert.rejects(() => executeAction(USER_ID, { ...base, pageSize: 6 }, { repository, encryptionKey: KEY, fetcher: provider.fetcher }), /tamanho de página/)
  const result = await executeAction(USER_ID, { ...base, page: 2, pageSize: 2 }, { repository, encryptionKey: KEY, fetcher: provider.fetcher })
  assert.equal(result.preview.requestedPage, 2)
  assert.equal(result.preview.pageSize, 2)
})

test('sync-products sanitiza erro do provider', async () => {
  const repository = new MemoryRepository()
  repository.integration.status = 'active'
  repository.credential = { username: 'user@example.com', password_ciphertext: bytesToPostgresBytea(await encryptPassword('secret', KEY)) }
  const fetcher = async () => new Response('{"password":"raw-provider-error"}', { status: 401 })
  await assert.rejects(
    () => executeAction(USER_ID, { action: 'sync-products', mode: 'preview', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID }, { repository, encryptionKey: KEY, fetcher: fetcher as typeof fetch }),
    (error: unknown) => error instanceof ApiError && error.code === 'AUTHENTICATION_FAILED' && !error.message.includes('raw-provider-error'),
  )
})

test('sync-products real processa uma página por chamada e mapeia o contrato confirmado', async () => {
  const repository = new MemoryRepository(); repository.integration.status = 'active'
  repository.credential = { username: 'user@example.com', password_ciphertext: bytesToPostgresBytea(await encryptPassword('secret', KEY)) }
  const provider = productPreviewFetcher({ records: 2, page: 1, pages: 1, items: [
    { id: 81, sku: '7894900011517', description: 'Produto real', availableQuantity: 99, costPrice: 10 },
    { sku: 'sem-id', description: 'ignorado' },
  ] })
  const result = await executeAction(USER_ID, { action: 'sync-products', mode: 'sync', marketAccountId: ACCOUNT_ID, integrationId: INTEGRATION_ID }, { repository, encryptionKey: KEY, fetcher: provider.fetcher })
  assert.equal(result.run.status, 'completed'); assert.equal(result.run.currentPage, 1)
  assert.deepEqual(repository.appliedProducts[0], { externalProductId: '81', externalSku: '7894900011517', validGtin: '7894900011517', description: 'Produto real', unit: null, externalInactive: false })
  assert.equal(repository.appliedProducts[1], null)
  assert.equal(JSON.stringify(repository.appliedProducts).includes('availableQuantity'), false)
  assert.equal(JSON.stringify(repository.appliedProducts).includes('costPrice'), false)
})

test('Admin mantém preview e expõe sincronização resumível de catálogo', () => {
  assert.match(adminIntegrationSource, /'Sincronizar produtos'/)
  assert.match(adminIntegrationSource, /Ver preview/)
  assert.match(adminIntegrationSource, /productPreview\.products/)
  assert.match(integrationServiceSource, /action: 'sync-products', mode: 'preview'/)
  assert.match(integrationServiceSource, /action: 'sync-products', mode: 'sync'/)
  assert.doesNotMatch(integrationCoreSource, /market_product_store_data|market_store_products/)
})
