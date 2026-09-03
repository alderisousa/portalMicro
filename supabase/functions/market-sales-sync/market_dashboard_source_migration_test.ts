import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../../migrations/202609030002_select_market_dashboard_sales_source.sql', import.meta.url),
  'utf8',
)

const syncedStart = migration.indexOf('create or replace function public.market_get_synced_commercial_dashboard')
const syncedEnd = migration.indexOf('revoke all on function public.market_get_synced_commercial_dashboard')
const syncedFunction = migration.slice(syncedStart, syncedEnd)
const wrapperStart = migration.indexOf('create or replace function public.market_get_commercial_dashboard', syncedEnd)
const wrapper = migration.slice(wrapperStart)

test('conta integrada usa exclusivamente tabelas sincronizadas', () => {
  assert.notEqual(syncedStart, -1)
  assert.match(syncedFunction, /public\.market_sales s/)
  assert.match(syncedFunction, /public\.market_sale_items i/)
  assert.match(syncedFunction, /s\.source_type = 'api'/)
  assert.match(syncedFunction, /s\.source_system = 'accesys'/)
  const sourceFilters = [...syncedFunction.matchAll(/s\.source_system = 'accesys'/g)]
  const integrationFilters = [...syncedFunction.matchAll(/s\.integration_id = v_integration_id/g)]
  assert.equal(integrationFilters.length, sourceFilters.length)
  assert.equal(sourceFilters.length, 8)
  assert.doesNotMatch(syncedFunction, /market_sales_imports|market_sales_import_rows/)
  assert.match(syncedFunction, /'source', 'sync'/)
})

test('dashboard exige exatamente uma integração Accesys ativa e falha deterministicamente em ambiguidade', () => {
  assert.match(syncedFunction, /select count\(\*\)::integer, \(array_agg\(i\.id order by i\.id\)\)\[1\]/)
  assert.match(syncedFunction, /i\.market_account_id = p_market_account_id/)
  assert.match(syncedFunction, /i\.provider = 'accesys'/)
  assert.match(syncedFunction, /i\.status = 'active'/)
  assert.match(syncedFunction, /if v_active_integration_count <> 1/)
  assert.match(syncedFunction, /DASHBOARD_INTEGRATION_AMBIGUOUS/)
})

test('wrapper escolhe uma unica fonte pelo estado da integracao Accesys', () => {
  assert.match(wrapper, /i\.provider = 'accesys'/)
  assert.match(wrapper, /i\.status = 'active'/)
  assert.ok(wrapper.indexOf("i.status = 'active'") < wrapper.indexOf('market_get_synced_commercial_dashboard'))
  assert.match(wrapper, /market_get_commercial_dashboard_all_locations/)
  assert.match(wrapper, /'source', 'import'/)
  assert.doesNotMatch(wrapper, /union\s+all/i)
})

test('periodo sincronizado vem de sold_at e custos ausentes nao viram zero', () => {
  assert.match(syncedFunction, /min\(s\.sold_at\)::date, max\(s\.sold_at\)::date/)
  assert.match(syncedFunction, /i\.total_cost_snapshot is null/)
  assert.match(syncedFunction, /'cost', case when v_cost_available then ct\.cost else null end/)
  assert.match(syncedFunction, /'costAvailable', v_cost_available/)
})

test('operator continua bloqueado e viewer permanece somente leitura comercial', () => {
  assert.match(wrapper, /array\['owner','admin','manager','viewer'\]/)
  assert.doesNotMatch(wrapper, /array\[[^\]]*'operator'/)
  assert.match(wrapper, /DASHBOARD_PERMISSION_DENIED/)
})

test('função interna não é pública e wrapper revoga explicitamente anon', () => {
  assert.match(migration, /revoke all on function public\.market_get_synced_commercial_dashboard\(uuid,uuid\)[\s\S]*from public, anon, authenticated/)
  assert.match(wrapper, /revoke all on function public\.market_get_commercial_dashboard\(uuid,uuid\) from public, anon/)
  assert.match(wrapper, /grant execute on function public\.market_get_commercial_dashboard\(uuid,uuid\) to authenticated/)
})
