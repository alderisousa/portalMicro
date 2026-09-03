import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const inventory = readFileSync(new URL('../../../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
const adminIntegration = readFileSync(new URL('../../../src/pages/AdminMarketIntegration.tsx', import.meta.url), 'utf8')
const stockService = readFileSync(new URL('../../../src/services/marketStock.ts', import.meta.url), 'utf8')
const integrationCore = readFileSync(new URL('../market-integration-admin/core.ts', import.meta.url), 'utf8')

test('contexto inicial não conta produtos nem chama a RPC de catálogo', () => {
  const start = stockService.indexOf('export async function getMarketStockContext')
  const end = stockService.indexOf('export async function startMarketStockControl')
  const initialContext = stockService.slice(start, end)

  assert.doesNotMatch(initialContext, /countActiveProducts|count: 'exact'|head: true/)
  assert.doesNotMatch(initialContext, /listActiveProducts|market_get_stock_products/)
})

test('abertura mantém draft e deixa catálogo explícito para iniciar ou continuar', () => {
  const loadStart = inventory.indexOf('const load = useCallback')
  const loadEnd = inventory.indexOf('useEffect(() => { void load()')
  const openingFlow = inventory.slice(loadStart, loadEnd)

  assert.doesNotMatch(openingFlow, /listActiveProducts|market_get_stock_products/)
  assert.match(inventory, /getMarketInventoryDraft\(accountId, nextStoreId\)/)
  assert.match(inventory, /const startDraft = async[\s\S]*await listActiveProducts\(accountId\)/)
  assert.match(inventory, /const resumeDraft = async[\s\S]*await listActiveProducts\(accountId\)/)
})

test('estoque usa receivedCount do último completed e mantém o estado vazio', () => {
  assert.match(inventory, /setLastProductSync\(status\.lastCompletedRun\)/)
  assert.match(inventory, /lastProductSync\.receivedCount/)
  assert.match(inventory, /produtos sincronizados/)
  assert.match(inventory, /Nenhuma sincronização de produtos concluída\./)
  assert.doesNotMatch(inventory, /productCount|produtos ativos/)
  assert.match(adminIntegration, /setLastCompletedProductSyncRun\(productStatus\.lastCompletedRun\)/)
  assert.match(adminIntegration, /productSyncRun\.receivedCount/)
})

test('sincronização atualiza o card pelo status sem carregar catálogo', () => {
  const syncStart = inventory.indexOf('const syncProducts = async')
  const syncEnd = inventory.indexOf("if (loading && !context)")
  const syncFlow = inventory.slice(syncStart, syncEnd)

  assert.match(syncFlow, /getMarketProductSyncStatus\(accountId, productIntegrationId\)/)
  assert.match(syncFlow, /setLastProductSync\(status\.lastCompletedRun\)/)
  assert.match(syncFlow, /setProducts\(null\)/)
  assert.doesNotMatch(syncFlow, /listActiveProducts|market_get_stock_products|countActiveProducts/)
})

test('viewer só consulta status e operator continua autorizado a sincronizar', () => {
  assert.match(inventory, /context\.access\.role !== 'viewer'/)
  assert.match(integrationCore, /body\.mode === 'status'[\s\S]*\['owner', 'admin', 'manager', 'operator', 'viewer'\]/)
  assert.match(integrationCore, /:\s*\['owner', 'admin', 'manager', 'operator'\]/)
})
