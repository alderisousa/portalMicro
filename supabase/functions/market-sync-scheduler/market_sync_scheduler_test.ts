import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const scheduler = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../../migrations/202609030005_add_market_product_sync_source.sql', import.meta.url), 'utf8')
const inventory = readFileSync(new URL('../../../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
const service = readFileSync(new URL('../../../src/services/marketIntegration.ts', import.meta.url), 'utf8')
const repository = readFileSync(new URL('../market-integration-admin/index.ts', import.meta.url), 'utf8')
const salesSync = readFileSync(new URL('../market-sales-sync/index.ts', import.meta.url), 'utf8')
const functionConfig = readFileSync(new URL('../../config.toml', import.meta.url), 'utf8')

test('scheduler isola integracoes e reutiliza as Edge Functions existentes', () => {
  assert.match(scheduler, /for \(const integration of integrations\)/)
  assert.match(scheduler, /try \{[\s\S]*market-integration-admin[\s\S]*market-sales-sync[\s\S]*catch/)
  assert.match(scheduler, /integrationsFound[\s\S]*completed[\s\S]*failed[\s\S]*skipped/)
  assert.doesNotMatch(scheduler, /password_ciphertext|market_store_products|market_stock_movements|availableQuantity/)
})

test('scheduler exige Secret API Key moderna e segredo adicional sem expo-los', () => {
  assert.match(scheduler, /SUPABASE_SECRET_KEYS/)
  assert.match(scheduler, /apikey: secretApiKey/)
  assert.match(scheduler, /x-market-scheduler-secret/)
  assert.doesNotMatch(scheduler, /Authorization: `Bearer \$\{serviceRoleKey\}`/)
  assert.match(repository, /secretApiKeys\.includes\(providedApiKey\)/)
  assert.match(salesSync, /secretApiKeys\.includes\(providedApiKey\)/)
  for (const functionName of ['market-sync-scheduler', 'market-integration-admin', 'market-sales-sync']) {
    assert.match(functionConfig, new RegExp(`\\[functions\\.${functionName}\\]\\nverify_jwt = false`))
  }
  assert.doesNotMatch(inventory, /SERVICE_ROLE|SCHEDULER_SECRET|password_ciphertext/)
})

test('inventario exibe ultima completed, estados vazios e reutiliza helper de sync', () => {
  assert.match(inventory, /Última sincronização de produtos/)
  assert.match(inventory, /Nenhuma sincronização de produtos concluída/)
  assert.match(inventory, /context\.access\.role !== 'viewer'/)
  assert.match(inventory, /synchronizeMarketProducts\(accountId, productIntegrationId, 'inventory'/)
  assert.match(service, /while \(run\.status === 'running'\)/)
  assert.match(repository, /\.eq\('status', 'completed'\)/)
})

test('migration 0005 registra origem sem duplicar aquisicao e nao toca estoque', () => {
  assert.match(migration, /p_source not in \('admin','inventory','scheduled'\)/)
  assert.match(migration, /public\.market_begin_product_sync\([\s\S]*p_page_size[\s\S]*\);/)
  assert.match(migration, /set source = p_source/)
  assert.doesNotMatch(migration, /market_store_products|market_stock|inventory_sessions/)
})
