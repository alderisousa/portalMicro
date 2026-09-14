import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const integration = '20000000-0000-4000-8000-000000000001'
const store = '30000000-0000-4000-8000-000000000001'
const warehouse = '30000000-0000-4000-8000-000000000002'
const startedStore = '30000000-0000-4000-8000-000000000003'
const futureStore = '30000000-0000-4000-8000-000000000004'
const legacyStore = '30000000-0000-4000-8000-000000000005'
const historicalStore = '30000000-0000-4000-8000-000000000006'
const cancelStore = '30000000-0000-4000-8000-000000000007'
const product = '40000000-0000-4000-8000-000000000001'
const unmappedProduct = '40000000-0000-4000-8000-000000000002'
const sale = '50000000-0000-4000-8000-000000000001'
const unmappedSale = '50000000-0000-4000-8000-000000000002'
const warehouseSale = '50000000-0000-4000-8000-000000000003'
const item = '60000000-0000-4000-8000-000000000001'
const unmappedItem = '60000000-0000-4000-8000-000000000002'
const warehouseItem = '60000000-0000-4000-8000-000000000003'
const historicalMappingSale = '50000000-0000-0000-0000-000000000007'
const historicalMappingItem = '60000000-0000-0000-0000-000000000007'
const preCutoffSale = '50000000-0000-0000-0000-000000000004'
const exactCutoffSale = '50000000-0000-0000-0000-000000000005'
const postCutoffSale = '50000000-0000-0000-0000-000000000006'
const preCutoffItem = '60000000-0000-0000-0000-000000000004'
const exactCutoffItem = '60000000-0000-0000-0000-000000000005'
const postCutoffItem = '60000000-0000-0000-0000-000000000006'
const legacyProduct = '40000000-0000-0000-0000-000000000003'
const initialSession = '70000000-0000-0000-0000-000000000001'
const cycleSession = '70000000-0000-0000-0000-000000000002'
const cancelledSession = '70000000-0000-0000-0000-000000000003'

await db.exec(`
  create role anon;
  create role authenticated;
  create table public.market_accounts(id uuid primary key, status text not null);
  create table public.market_integrations(
    id uuid primary key, market_account_id uuid not null, provider text not null,
    unique (id, market_account_id)
  );
  create table public.market_stores(
    id uuid primary key, market_account_id uuid not null, store_type text not null,
    updated_at timestamptz not null default now(),
    unique (id, market_account_id)
  );
  create table public.market_store_external_refs(
    id uuid primary key, market_account_id uuid not null, market_store_id uuid not null,
    integration_id uuid not null, external_store_id text not null
  );
  create table public.market_products(
    id uuid primary key, market_account_id uuid not null
  );
  create table public.market_inventory_sessions(
    id uuid primary key, market_account_id uuid not null, market_store_id uuid not null,
    inventory_type text not null, status text not null, completed_at timestamptz null
  );
  create table public.market_product_mappings(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null,
    integration_id uuid not null, source_system text not null,
    external_product_id text not null, product_id uuid not null
  );
  create table public.market_sales(
    id uuid primary key, market_account_id uuid not null, market_store_id uuid not null,
    integration_id uuid not null, source_type text not null, source_system text not null,
    sold_at timestamptz not null, is_refunded boolean not null default false
  );
  create table public.market_sale_items(
    id uuid primary key, market_account_id uuid not null, sale_id uuid not null,
    product_id uuid null, external_item_id text not null, external_product_id text not null,
    quantity numeric(14,3) not null,
    unique (market_account_id, sale_id, external_item_id)
  );
  create table public.market_stock_movements(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null,
    market_store_id uuid not null, product_id uuid not null, movement_type text not null,
    direction text not null, quantity numeric(14,3) not null, reference_type text null,
    reference_id uuid null, reference_item_id uuid null, notes text null,
    occurred_at timestamptz not null, created_by uuid null,
    created_at timestamptz not null default now()
  );
  create unique index ux_market_stock_movements_source_item
    on public.market_stock_movements(market_account_id, movement_type, reference_type, reference_id, reference_item_id)
    where reference_type is not null and reference_id is not null and reference_item_id is not null;
  create view public.market_stock_balance as
    select market_account_id, market_store_id, product_id,
      sum(case when direction = 'IN' then quantity else -quantity end) quantity_on_hand
    from public.market_stock_movements
    group by market_account_id, market_store_id, product_id;

  insert into public.market_accounts values ('${account}', 'active');
  insert into public.market_integrations values ('${integration}', '${account}', 'accesys');
  insert into public.market_stores values
    ('${store}', '${account}', 'store'), ('${warehouse}', '${account}', 'warehouse'),
    ('${startedStore}', '${account}', 'store'), ('${futureStore}', '${account}', 'store'),
    ('${legacyStore}', '${account}', 'store'), ('${historicalStore}', '${account}', 'store'),
    ('${cancelStore}', '${account}', 'store');
  insert into public.market_products values
    ('${product}', '${account}'), ('${unmappedProduct}', '${account}'), ('${legacyProduct}', '${account}');
  insert into public.market_product_mappings
    (market_account_id, integration_id, source_system, external_product_id, product_id)
    values ('${account}', '${integration}', 'accesys', 'external-1', '${product}');
  insert into public.market_stock_movements
    (market_account_id, market_store_id, product_id, movement_type, direction, quantity,
     reference_type, reference_id, reference_item_id, occurred_at, created_at)
    values ('${account}', '${legacyStore}', '${legacyProduct}', 'INVENTORY', 'IN', 4,
      'STOCK_INITIALIZATION', null, '${legacyProduct}', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
`)

await db.exec(sqlFile('202609140001_add_synced_sale_stock_movements.sql'))

const insertSale = async (id, storeId, soldAt = '2026-09-14T10:00:00Z') => db.query(`
  insert into public.market_sales
    (id, market_account_id, market_store_id, integration_id, source_type, source_system, sold_at)
    values ($1, $2, $3, $4, 'api', 'accesys', $5)
`, [id, account, storeId, integration, soldAt])

test('loja sem marco importa venda mas nao gera movimento', async () => {
  await insertSale(sale, store)
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-1', 'external-1', 2)`, [item, account, sale])
  const movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [sale])
  assert.equal(movements.rows[0].count, 0)
})

test('venda no marco ou depois baixa integralmente e permite saldo negativo', async () => {
  await db.query(`update public.market_stores set stock_control_started_at = '2026-09-14T10:00:00Z' where id = $1`, [startedStore])
  await insertSale(exactCutoffSale, startedStore, '2026-09-14T10:00:00Z')
  await insertSale(postCutoffSale, startedStore, '2026-09-14T10:00:01Z')
  await db.query(`insert into public.market_stock_movements
    (market_account_id, market_store_id, product_id, movement_type, direction, quantity, occurred_at)
    values ($1, $2, $3, 'INVENTORY', 'IN', 2, '2026-09-14T09:00:00Z')`, [account, startedStore, product])
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-4', 'external-1', 1)`, [exactCutoffItem, account, exactCutoffSale])
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-5', 'external-1', 2)`, [postCutoffItem, account, postCutoffSale])

  const balance = await db.query(`select quantity_on_hand from public.market_stock_balance where market_store_id = $1 and product_id = $2`, [startedStore, product])
  assert.equal(Number(balance.rows[0].quantity_on_hand), -1)
})

test('venda anterior ao marco nao baixa estoque', async () => {
  await db.query(`update public.market_stores set stock_control_started_at = '2026-09-14T10:00:00Z' where id = $1`, [historicalStore])
  await insertSale(preCutoffSale, historicalStore, '2026-09-14T09:59:59Z')
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-pre', 'external-1', 3)`, [preCutoffItem, account, preCutoffSale])
  const movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [preCutoffSale])
  assert.equal(movements.rows[0].count, 0)
})

test('ressincronizacao do mesmo item nao cria baixa duplicada', async () => {
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-4', 'external-1', 1)
    on conflict (market_account_id, sale_id, external_item_id) do update set quantity = excluded.quantity`, [exactCutoffItem, account, exactCutoffSale])
  const movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_type = 'SALE' and reference_id = $1`, [exactCutoffSale])
  assert.equal(movements.rows[0].count, 1)
})

test('item sem mapping persiste sem movimento e pode ser resolvido em ressincronizacao', async () => {
  await db.query(`update public.market_stores set stock_control_started_at = '2026-09-14T00:00:00Z' where id = $1`, [store])
  await insertSale(unmappedSale, store)
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-2', 'external-missing', 3)`, [unmappedItem, account, unmappedSale])
  let movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [unmappedSale])
  assert.equal(movements.rows[0].count, 0)

  await db.query(`insert into public.market_product_mappings
    (market_account_id, integration_id, source_system, external_product_id, product_id)
    values ($1, $2, 'accesys', 'external-missing', $3)`, [account, integration, unmappedProduct])
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-2', 'external-missing', 3)
    on conflict (market_account_id, sale_id, external_item_id) do update set quantity = excluded.quantity`, [unmappedItem, account, unmappedSale])
  movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [unmappedSale])
  assert.equal(movements.rows[0].count, 1)
})

test('mapping posterior respeita o corte historico e baixa venda posterior uma vez', async () => {
  await insertSale(historicalMappingSale, historicalStore, '2026-09-13T10:00:00Z')
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-historical-map', 'external-late-historical', 2)`, [historicalMappingItem, account, historicalMappingSale])
  await db.query(`insert into public.market_product_mappings
    (market_account_id, integration_id, source_system, external_product_id, product_id)
    values ($1, $2, 'accesys', 'external-late-historical', $3)`, [account, integration, unmappedProduct])
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-historical-map', 'external-late-historical', 2)
    on conflict (market_account_id, sale_id, external_item_id) do update set quantity = excluded.quantity`, [historicalMappingItem, account, historicalMappingSale])
  let movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [historicalMappingSale])
  assert.equal(movements.rows[0].count, 0)

  const laterSale = '50000000-0000-0000-0000-000000000008'
  const laterItem = '60000000-0000-0000-0000-000000000008'
  await insertSale(laterSale, store, '2026-09-14T12:00:00Z')
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-later-map', 'external-late-historical', 3)`, [laterItem, account, laterSale])
  movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [laterSale])
  assert.equal(movements.rows[0].count, 1)
  await db.query(`insert into public.market_sale_items
    (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
    values ($1, $2, $3, null, 'item-later-map', 'external-late-historical', 3)
    on conflict (market_account_id, sale_id, external_item_id) do update set quantity = excluded.quantity`, [laterItem, account, laterSale])
  movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [laterSale])
  assert.equal(movements.rows[0].count, 1)
})

test('venda sincronizada para warehouse e rejeitada sem movimento', async () => {
  await insertSale(warehouseSale, warehouse)
  await assert.rejects(
    db.query(`insert into public.market_sale_items
      (id, market_account_id, sale_id, product_id, external_item_id, external_product_id, quantity)
      values ($1, $2, $3, null, 'item-3', 'external-1', 1)`, [warehouseItem, account, warehouseSale]),
    /SALES_WAREHOUSE_NOT_ALLOWED/,
  )
  const movements = await db.query(`select count(*)::integer as count from public.market_stock_movements where reference_id = $1`, [warehouseSale])
  assert.equal(movements.rows[0].count, 0)
})

test('backfill usa o primeiro movimento STOCK_INITIALIZATION e marco de initial e estavel', async () => {
  const legacy = await db.query(`select stock_control_started_at from public.market_stores where id = $1`, [legacyStore])
  assert.equal(legacy.rows[0].stock_control_started_at.toISOString(), '2026-01-02T00:00:00.000Z')

  await db.query(`insert into public.market_inventory_sessions
    (id, market_account_id, market_store_id, inventory_type, status, completed_at)
    values ($1, $2, $3, 'initial', 'draft', null)`, [initialSession, account, futureStore])
  await db.query(`update public.market_inventory_sessions set status = 'completed', completed_at = '2026-09-15T12:00:00Z' where id = $1`, [initialSession])
  let storeRow = await db.query(`select stock_control_started_at from public.market_stores where id = $1`, [futureStore])
  assert.equal(storeRow.rows[0].stock_control_started_at.toISOString(), '2026-09-15T12:00:00.000Z')

  await db.query(`insert into public.market_inventory_sessions
    (id, market_account_id, market_store_id, inventory_type, status, completed_at)
    values ($1, $2, $3, 'cycle', 'draft', null)`, [cycleSession, account, futureStore])
  await db.query(`update public.market_inventory_sessions set status = 'completed', completed_at = '2026-09-16T12:00:00Z' where id = $1`, [cycleSession])
  storeRow = await db.query(`select stock_control_started_at from public.market_stores where id = $1`, [futureStore])
  assert.equal(storeRow.rows[0].stock_control_started_at.toISOString(), '2026-09-15T12:00:00.000Z')
})

test('inventario draft ou cancelado nao preenche marco', async () => {
  await db.query(`insert into public.market_inventory_sessions
    (id, market_account_id, market_store_id, inventory_type, status, completed_at)
    values ($1, $2, $3, 'initial', 'draft', null)`, [cancelledSession, account, cancelStore])
  await db.query(`update public.market_inventory_sessions set status = 'cancelled' where id = $1`, [cancelledSession])
  const storeRow = await db.query(`select stock_control_started_at from public.market_stores where id = $1`, [cancelStore])
  assert.equal(storeRow.rows[0].stock_control_started_at, null)
})