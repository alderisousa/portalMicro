import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError, executeAction, type Integration, type IntegrationRepository } from './core.ts'
import {
  bytesToPostgresBytea,
  decryptPassword,
  encryptPassword,
  postgresByteaToBytes,
} from './crypto.ts'
import { normalizeAndValidateProviderUrl, ProviderError, testAccesysConnection } from './providers.ts'

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111'
const INTEGRATION_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

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
  accountExists = true
  integration = integration()
  credential: { username: string; password_ciphertext: string } | null = null
  passwordWrite: string | undefined

  async isGlobalAdmin() { return this.globalAdmin }
  async marketAccountExists() { return this.accountExists }
  async getIntegration() { return this.integration }
  async createIntegration(input: Omit<Integration, 'id' | 'last_test_at' | 'last_test_succeeded' | 'last_test_error'>) {
    this.integration = { ...integration(), ...input }
    return this.integration
  }
  async updateIntegration(_account: string, _id: string, input: Partial<Integration>) {
    this.integration = { ...this.integration, ...input }
    return this.integration
  }
  async getCredential() { return this.credential }
  async saveCredential(input: { username: string; passwordCiphertext?: string }) {
    this.passwordWrite = input.passwordCiphertext
    this.credential = {
      username: input.username,
      password_ciphertext: input.passwordCiphertext ?? this.credential!.password_ciphertext,
    }
  }
  async updateTestResult() {}
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
