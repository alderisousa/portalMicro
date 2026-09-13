import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
function service(path, supabase) {
  const source = stripTypeScriptTypes(read(path))
    .replace(/^import[\s\S]*?from ['"][^'"]+['"]\s*/gm, '')
    .replace(/^export /gm, '')
  return runInNewContext(`${source}\n;({ ${path.endsWith('market.ts') ? 'updateMarketAccountName' : 'getMarketIntegration, saveMarketIntegration'} })`, { supabase, Response })
}

for (const value of [true, false]) {
  for (const legacy of [false, true]) {
    test(`checkbox loads persisted ${value}, legacy response=${legacy}`, async () => {
      const filters = []
      let reads = 0
      const api = service('src/services/marketIntegration.ts', {
        functions: { invoke: async () => ({ data: { integration: legacy ? {} : { automaticSyncEnabled: value } }, error: null }) },
        from(table) {
          assert.equal(table, 'market_integrations'); reads++
          return {
            select(column) { assert.equal(column, 'automatic_sync_enabled'); return this },
            eq(column, value) { filters.push([column, value]); return this },
            async single() { return { data: { automatic_sync_enabled: value }, error: null } },
          }
        },
      })
      const loaded = await api.getMarketIntegration('account-id', 'integration-id')
      assert.equal(loaded.automaticSyncEnabled, value)
      assert.equal(reads, legacy ? 1 : 0)
      if (legacy) assert.deepEqual(filters, [['market_account_id', 'account-id'], ['id', 'integration-id']])
      const ui = read('src/pages/AdminMarketIntegration.tsx')
      assert.match(ui, /automaticSyncEnabled: value\.automaticSyncEnabled/)
      assert.match(ui, /checked=\{form\.automaticSyncEnabled\}/)
    })
  }
  test(`save sends and returns automaticSyncEnabled=${value}`, async () => {
    const api = service('src/services/marketIntegration.ts', {
      functions: { invoke: async (_name, { body }) => {
        assert.equal(body.automaticSyncEnabled, value)
        return { data: { integration: { automaticSyncEnabled: value } }, error: null }
      } },
    })
    const saved = await api.saveMarketIntegration({ marketAccountId: 'a', integrationId: 'i', externalCompanyId: 'x', username: 'u', status: 'active', automaticSyncEnabled: value })
    assert.equal(saved.automaticSyncEnabled, value)
  })
}

test('legacy backend cannot report a successful automatic-sync save', async () => {
  const api = service('src/services/marketIntegration.ts', {
    functions: { invoke: async () => ({ data: { integration: {} }, error: null }) },
  })
  await assert.rejects(() => api.saveMarketIntegration({ externalCompanyId: 'x', username: 'u', automaticSyncEnabled: false }), /precisa ser atualizado/)
})

test('rename trims and updates only name, targeting unchanged tenant ID', async () => {
  const calls = []
  const api = service('src/services/market.ts', {
    from(table) {
      calls.push(table)
      return {
        update(payload) { calls.push(JSON.parse(JSON.stringify(payload))); return this },
        eq(column, value) { calls.push([column, value]); return this },
        select(column) { assert.equal(column, 'id'); return this },
        async single() { return { data: { id: 'tenant-id' }, error: null } },
      }
    },
  })
  await api.updateMarketAccountName('tenant-id', '  Novo nome  ')
  assert.deepEqual(calls, ['market_accounts', { name: 'Novo nome' }, ['id', 'tenant-id']])
  for (const name of ['', '   ', '\t\n']) await assert.rejects(() => api.updateMarketAccountName('tenant-id', name), /Informe o nome/)
  assert.equal(calls.length, 3)
})

test('rename propagates denied or missing-row errors instead of reporting success', async () => {
  const denied = new Error('Acesso negado')
  const query = { update() { return this }, eq() { return this }, select() { return this }, async single() { return { error: denied } } }
  const api = service('src/services/market.ts', { from: () => query })
  await assert.rejects(() => api.updateMarketAccountName('tenant-id', 'Novo nome'), /Acesso negado/)
  const schema = read('supabase/migrations/202608310001_create_market_multitenant_core.sql')
  assert.match(schema, /create policy market_accounts_admin_update[\s\S]*?using \(public\.market_is_platform_admin\(\)\)\s*with check \(public\.market_is_platform_admin\(\)\)/)
  const ui = read('src/pages/AdminMarketAccount.tsx')
  assert.match(ui, /setAccountName\(accountData\.name\)/)
  assert.match(ui, /updateMarketAccountName\(accountId, name\)/)
  assert.match(ui, /Nome do Market<input required/)
})
