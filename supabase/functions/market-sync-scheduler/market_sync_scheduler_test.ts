import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// .replace: normaliza CRLF->LF na leitura para que os regexes abaixo (que
// assumem \n literal) não fiquem sensíveis ao line-ending do checkout local
// (ex.: core.autocrlf=true no Windows), sem alterar o conteúdo real do arquivo.
const scheduler = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
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

// Abastecimento / Reposicao Inteligente pos-sync (task='sales'): so dispara
// market_run_replenishment_batch quando o sync termina 'completed', usando
// reference_date de run.period.startDate (o mesmo D-1 ja calculado por
// marketOperationalWindow dentro de market-sales-sync/core.ts, nunca
// recalculado aqui) e run_source='scheduled'. Nao ha harness Deno disponivel
// neste ambiente para invocar Deno.serve de verdade; estas sao as mesmas
// validacoes estruturais por regex ja usadas no resto deste arquivo.
test('sales: Reposicao Inteligente so dispara dentro do branch status===completed', () => {
  assert.match(scheduler, /if \(status === 'completed'\) \{[\s\S]*market_run_replenishment_batch/)
})

test('sales: reference_date vem de run.period.startDate (sem recalcular fuso/janela no scheduler)', () => {
  assert.match(scheduler, /run\.period\?\.startDate/)
  // Só verifica CHAMADA da funcao/valor hardcoded (nao a mencao em
  // comentario explicando de onde period.startDate ja vem calculado).
  assert.doesNotMatch(scheduler, /marketOperationalWindow\(|=\s*'America\/Sao_Paulo'/)
})

test('sales: chamada da RPC usa market_account_id da integracao atual e run_source scheduled', () => {
  assert.match(scheduler,
    /p_market_account_id: integration\.market_account_id[\s\S]*?p_reference_date: referenceDate[\s\S]*?p_run_source: 'scheduled'/)
})

test('sales: falha da Reposicao fica isolada em try/catch proprio, nunca no catch externo do loop', () => {
  assert.match(scheduler,
    /try \{[\s\S]*?client\.rpc\('market_run_replenishment_batch'[\s\S]*?\} catch \(cause\) \{[\s\S]*?replenishment = \{ attempted: true, status: 'failed', error: message \}/)
  const outerLoopCatch = scheduler.match(/\n {4}\} catch \(cause\) \{\n\s+const code = cause instanceof Error[\s\S]*?skipped_concurrency[\s\S]*?\n {4}\}/)
  assert.ok(outerLoopCatch, 'catch externo do loop nao encontrado')
  assert.doesNotMatch(outerLoopCatch[0], /market_run_replenishment_batch/)
})

test('summary distingue reposicao completed/failed por integracao, sem tocar market_sales_sync_runs', () => {
  assert.match(scheduler, /replenishmentCompleted: results\.filter\(\(item\) => item\.replenishment\?\.status === 'completed'\)/)
  assert.match(scheduler, /replenishmentFailed: results\.filter\(\(item\) => item\.replenishment\?\.status === 'failed'\)/)
  assert.doesNotMatch(scheduler, /market_sales_sync_runs/)
})
