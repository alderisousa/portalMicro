import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migration = readFileSync(
  new URL('../../migrations/202609030001_harden_operator_commercial_access.sql', import.meta.url),
  'utf8',
)

const definition = (name: string, nextMarker: string) => {
  const start = migration.indexOf(`create or replace function public.${name}`)
  const end = migration.indexOf(nextMarker, start + 1)
  assert.notEqual(start, -1, `${name} precisa existir na migration`)
  assert.notEqual(end, -1, `${name} precisa ter limite identificavel`)
  return migration.slice(start, end)
}

test('dashboard comercial bloqueia operator e preserva viewer', () => {
  const sql = definition('market_get_commercial_dashboard', 'create or replace function public.market_begin_sales_import')
  assert.match(sql, /array\['owner','admin','manager','viewer'\]/)
  assert.doesNotMatch(sql, /array\[[^\]]*'operator'/)
  assert.match(sql, /DASHBOARD_PERMISSION_DENIED/)
  assert.ok(sql.indexOf('market_has_role') < sql.indexOf('market_get_commercial_dashboard_all_locations'))
})

test('todas as tres RPCs de importacao autorizam somente owner admin e manager', () => {
  const cases = [
    ['market_begin_sales_import', 'create or replace function public.market_append_sales_import_chunk'],
    ['market_append_sales_import_chunk', 'create or replace function public.market_finalize_sales_import'],
    ['market_finalize_sales_import', 'drop policy if exists market_sales_imports_select'],
  ] as const

  for (const [name, next] of cases) {
    const sql = definition(name, next)
    assert.match(sql, /array\['owner','admin','manager'\]/)
    assert.doesNotMatch(sql, /array\[[^\]]*'operator'/)
    assert.match(sql, /IMPORT_PERMISSION_DENIED/)
  }
})

test('policies comerciais removem operator sem regredir leitura do viewer', () => {
  for (const policy of [
    'market_sales_imports_select',
    'market_sales_import_rows_select',
    'market_sales_select',
    'market_sale_items_select',
    'market_sale_payments_select',
    'market_product_store_data_select',
  ]) {
    const marker = `create policy ${policy}`
    const start = migration.indexOf(marker)
    const end = migration.indexOf(';', start) + 1
    const sql = migration.slice(start, end)
    assert.notEqual(start, -1, `${policy} precisa ser recriada`)
    assert.match(sql, /array\['owner','admin','manager','viewer'\]/)
    assert.doesNotMatch(sql, /operator/)
  }

  for (const policy of ['market_sales_imports_write', 'market_sales_import_rows_write']) {
    const marker = `create policy ${policy}`
    const start = migration.indexOf(marker)
    const nextDrop = migration.indexOf('drop policy', start)
    const sql = migration.slice(start, nextDrop === -1 ? undefined : nextDrop)
    assert.match(sql, /array\['owner','admin','manager'\]/)
    assert.doesNotMatch(sql, /operator|viewer/)
  }
})
