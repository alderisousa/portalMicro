import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isValidGtin, mapAccesysProduct, normalizeGtinCandidate } from './productSync.ts'
import { fetchAccesysProductPage } from './providers.ts'

const migration = readFileSync(new URL('../../migrations/202609030003_add_resumable_market_product_sync.sql', import.meta.url), 'utf8')
const configuration = { provider: 'accesys', baseUrl: 'https://apigateway.accesyslab.com.br', externalCompanyId: '434', username: 'u', password: 'p' }

test('mapper usa item.id, aceita SKU inválido/ausente e preserva inatividade externa', () => {
  assert.deepEqual(mapAccesysProduct({ id: 42, sku: '7894900011517', description: ' Café ', unity: 'UN', isInactive: true }), {
    externalProductId: '42', externalSku: '7894900011517', validGtin: '7894900011517',
    description: 'Café', unit: 'UN', externalInactive: true,
  })
  assert.equal(mapAccesysProduct({ id: '43', sku: 'ABC-1' })?.validGtin, null)
  assert.equal(mapAccesysProduct({ id: '44' })?.externalSku, null)
  assert.equal(mapAccesysProduct({ description: 'sem id' }), null)
  assert.equal(normalizeGtinCandidate('78949.0001151-7'), '7894900011517')
  assert.equal(isValidGtin('7894900011517'), true)
  assert.equal(isValidGtin('7894900011518'), false)
})

test('provider exige contrato real records/page/pages/items e pagina desde 1', async () => {
  const calls: string[] = []
  const fetcher = async (input: string | URL | Request) => {
    calls.push(input.toString())
    return calls.length === 1 ? Response.json({ token: 'secret' }) : Response.json({ records: 5336, page: 2, pages: 54, items: [{ id: 9 }] })
  }
  const result = await fetchAccesysProductPage(configuration, 2, 100, fetcher as typeof fetch)
  assert.equal(result.catalog.page, 2); assert.equal(result.catalog.pages, 54); assert.equal(result.catalog.items[0].id, 9)
  const url = new URL(calls[1]); assert.equal(url.searchParams.get('page'), '2'); assert.equal(url.searchParams.get('pageSize'), '100')
})

test('migration garante identidade, isolamento, checkpoint, concorrência e ausência de efeitos operacionais', () => {
  assert.match(migration, /market_account_id, integration_id, external_product_id/)
  assert.match(migration, /ux_market_product_mappings_integration_product/)
  assert.match(migration, /p_page <> v_run\.current_page \+ 1/)
  assert.match(migration, /ux_market_product_sync_runs_one_running[\s\S]*where status = 'running'/)
  assert.match(migration, /interval '30 minutes'/)
  assert.match(migration, /where p\.market_account_id=v_run\.market_account_id and p\.ean=v_gtin/)
  assert.match(migration, /ean=coalesce\(p\.ean,v_promoted_gtin\)/)
  assert.match(migration, /p\.ean=v_promoted_gtin and p\.id<>v_product_id/)
  assert.match(migration, /external_is_inactive=v_inactive/)
  assert.doesNotMatch(migration, /delete from public\.market_products/)
  assert.doesNotMatch(migration, /market_store_products|market_product_store_data|market_stock|market_stock_movements/)
})

test('run preserva auditoria, tem grants server-side explícitos e estados coerentes', () => {
  const runTable = migration.slice(migration.indexOf('create table public.market_product_sync_runs'), migration.indexOf('create unique index ux_market_product_sync_runs_one_running'))
  assert.doesNotMatch(runTable, /references public\.market_integrations\(id, market_account_id\) on delete cascade/)
  assert.match(migration, /revoke all on table public\.market_product_sync_runs from public, anon, authenticated/)
  assert.match(migration, /grant all on public\.market_product_sync_runs to service_role/)
  assert.match(runTable, /status = 'running' and heartbeat_at is not null and finished_at is null/)
  assert.match(runTable, /status in \('completed','partial','failed','cancelled'\) and finished_at is not null/)
  assert.match(runTable, /finished_at is null or finished_at >= started_at/)
  assert.match(migration, /create trigger market_product_sync_runs_set_updated_at[\s\S]*execute function public\.set_updated_at\(\)/)
})

test('RPCs de produtos são exclusivas do service_role', () => {
  for (const signature of [
    'market_begin_product_sync\\(uuid,uuid,uuid,integer\\)',
    'market_apply_product_sync_page\\(uuid,uuid,integer,integer,integer,jsonb\\)',
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature} from public,anon,authenticated`))
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature} to service_role`))
  }
})

test('paginação rejeita limites inválidos e detecta mudança de pages ou records', () => {
  assert.match(migration, /p_total_pages < 1/)
  assert.match(migration, /p_page > p_total_pages/)
  assert.match(migration, /p_total_records < 0/)
  assert.match(migration, /v_run\.total_pages <> p_total_pages/)
  assert.match(migration, /v_run\.total_records <> p_total_records/)
  assert.match(migration, /PRODUCT_SYNC_PAGINATION_CHANGED/)
})

test('endurecimento de mappings preserva leitura e escrita histórica via RPC SECURITY DEFINER', () => {
  const importMigration = readFileSync(new URL('../../migrations/202608310006_confirm_market_sales_import.sql', import.meta.url), 'utf8')
  assert.match(migration, /revoke insert, update, delete on table public\.market_product_mappings from anon, authenticated/)
  assert.match(importMigration, /create or replace function public\.market_finalize_sales_import[\s\S]*security definer/)
  assert.match(importMigration, /insert into public\.market_product_mappings/)
})
