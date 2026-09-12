// Teste focado da RPC que materializa a Lista de Compras da Reposicao
// Inteligente. Usa PostgreSQL local via PGlite, no mesmo padrao dos demais
// testes de migrations/RPCs do Market.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()
after(() => db.close())

const account = '10000000-0000-4000-8000-000000000001'
const otherAccount = '10000000-0000-4000-8000-000000000002'
const actor = '40000000-0000-4000-8000-000000000001'
const run = '50000000-0000-4000-8000-000000000001'
const oldRun = '50000000-0000-4000-8000-000000000002'
const storeA = '20000000-0000-4000-8000-000000000001'
const storeB = '20000000-0000-4000-8000-000000000002'
const storeC = '20000000-0000-4000-8000-000000000003'
const warehouseA = '20000000-0000-4000-8000-000000000010'
const warehouseB = '20000000-0000-4000-8000-000000000011'
const productA = '30000000-0000-4000-8000-000000000001'
const productB = '30000000-0000-4000-8000-000000000002'
const productC = '30000000-0000-4000-8000-000000000003'
const productD = '30000000-0000-4000-8000-000000000004'
const purchaseOld = '60000000-0000-4000-8000-000000000001'
const purchaseLatest = '60000000-0000-4000-8000-000000000002'
const purchaseIgnored = '60000000-0000-4000-8000-000000000003'
const purchaseNoDocument = '60000000-0000-4000-8000-000000000004'
const itemOld = '70000000-0000-4000-8000-000000000001'
const itemLatest = '70000000-0000-4000-8000-000000000002'
const itemIgnored = '70000000-0000-4000-8000-000000000003'
const itemNoDocument = '70000000-0000-4000-8000-000000000004'

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;

  create table public.market_accounts(
    id uuid primary key,
    status text not null
  );
  create table public.market_account_members(
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    user_id uuid not null,
    role text not null,
    all_stores boolean not null default false,
    status text not null default 'active',
    created_at timestamptz not null default now()
  );
  create table public.market_stores(
    id uuid primary key,
    market_account_id uuid not null,
    name text not null,
    store_type text not null,
    status text not null default 'active',
    unique(id, market_account_id)
  );
  create table public.market_products(
    id uuid primary key,
    market_account_id uuid not null,
    name text not null,
    sku text null,
    ean text null,
    unit text not null default 'UN',
    status text not null default 'active',
    unique(id, market_account_id)
  );
  create table public.market_stock_movements(
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    product_id uuid not null,
    movement_type text not null,
    direction text not null,
    quantity numeric(18,4) not null,
    unit_cost numeric(18,6) null,
    reference_type text null,
    reference_id uuid null,
    reference_item_id uuid null,
    occurred_at timestamptz not null default now()
  );
  create view public.market_stock_balance as
    select market_account_id, market_store_id, product_id,
      sum(case when direction = 'IN' then quantity else -quantity end)::numeric(18,4) as quantity_on_hand,
      max(occurred_at) as last_movement_at
    from public.market_stock_movements
    group by market_account_id, market_store_id, product_id;

  create table public.market_replenishment_runs(
    id uuid primary key,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    reference_date date not null,
    algorithm_version text not null,
    status text not null,
    run_source text not null default 'manual',
    is_effective boolean not null default false,
    started_at timestamptz not null default now(),
    finished_at timestamptz null,
    unique(id, market_account_id)
  );
  create table public.market_replenishment_candidates(
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    store_id uuid not null,
    product_id uuid not null,
    reference_date date not null,
    current_stock numeric(18,4) null,
    minimum_stock numeric(18,4) null,
    is_essential boolean not null default false,
    avg_daily_m7 numeric(18,6) null,
    avg_daily_m14 numeric(18,6) null,
    avg_daily_m30 numeric(18,6) null,
    reference_daily_demand numeric(18,6) null,
    coverage_days numeric(18,4) null,
    acceleration_pct numeric(12,4) null,
    days_since_last_sale integer null,
    trigger_reasons text[] not null default array['LOW_COVERAGE'],
    priority_score integer not null default 0,
    priority_level text not null,
    rank_position integer not null,
    suggested_quantity numeric(18,4) null,
    warehouse_stock numeric(18,4) null,
    unique(id, market_account_id),
    foreign key (run_id, market_account_id) references public.market_replenishment_runs(id, market_account_id) on delete cascade,
    foreign key (store_id, market_account_id) references public.market_stores(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id) references public.market_products(id, market_account_id) on delete cascade
  );
  create table public.market_replenishment_orders(
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    run_id uuid not null,
    status text not null default 'draft',
    created_at timestamptz not null default now(),
    created_by uuid null references auth.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    updated_by uuid null references auth.users(id) on delete set null,
    approved_at timestamptz null,
    approved_by uuid null references auth.users(id) on delete set null,
    completed_at timestamptz null,
    cancelled_at timestamptz null,
    unique(id, market_account_id),
    foreign key (run_id, market_account_id) references public.market_replenishment_runs(id, market_account_id) on delete restrict
  );
  create unique index uq_market_replenishment_orders_active_run
    on public.market_replenishment_orders(run_id)
    where status <> 'cancelled';
  create table public.market_replenishment_order_items(
    id uuid primary key default gen_random_uuid(),
    order_id uuid not null,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    product_id uuid not null,
    status text not null default 'pending',
    total_suggested_quantity numeric(18,4) not null default 0,
    warehouse_stock_snapshot numeric(18,4) null,
    suggested_purchase_quantity numeric(18,4) not null default 0,
    adjusted_purchase_quantity numeric(18,4) null,
    purchased_quantity numeric(18,4) not null default 0,
    warehouse_surplus_quantity numeric(18,4) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(order_id, product_id),
    unique(id, market_account_id),
    foreign key (order_id, market_account_id) references public.market_replenishment_orders(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id) references public.market_products(id, market_account_id) on delete restrict
  );
  create table public.market_replenishment_order_allocations(
    id uuid primary key default gen_random_uuid(),
    order_item_id uuid not null,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    store_id uuid not null,
    candidate_id uuid null,
    status text not null default 'pending',
    suggested_quantity numeric(18,4) not null default 0,
    adjusted_quantity numeric(18,4) null,
    allocated_quantity numeric(18,4) not null default 0,
    dispatched_quantity numeric(18,4) not null default 0,
    received_quantity numeric(18,4) not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    cancelled_at timestamptz null,
    cancellation_reason text null,
    unique(order_item_id, store_id),
    constraint market_replenishment_order_allocations_suggested_check check (suggested_quantity >= 0),
    foreign key (order_item_id, market_account_id) references public.market_replenishment_order_items(id, market_account_id) on delete cascade,
    foreign key (store_id, market_account_id) references public.market_stores(id, market_account_id) on delete restrict,
    foreign key (candidate_id, market_account_id) references public.market_replenishment_candidates(id, market_account_id) on delete set null (candidate_id)
  );
  create table public.market_purchases(
    id uuid primary key,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    destination_store_id uuid not null,
    supplier_name text null,
    supplier_document text null,
    invoice_number text null,
    invoice_series text null,
    invoice_key text null,
    issued_at timestamptz null,
    received_at timestamptz null,
    status text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(id, market_account_id),
    foreign key (destination_store_id, market_account_id) references public.market_stores(id, market_account_id)
  );
  create table public.market_purchase_items(
    id uuid primary key,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    market_purchase_id uuid not null,
    line_number integer not null,
    market_product_id uuid null,
    supplier_product_code text null,
    barcode_normalized text null,
    quantity numeric(18,4) not null,
    stock_quantity numeric(18,4) null,
    stock_unit text null,
    stock_unit_cost numeric(18,6) null,
    reconciliation_status text not null,
    stock_entry_status text not null,
    received_at timestamptz null,
    unique(id, market_account_id),
    foreign key (market_purchase_id, market_account_id) references public.market_purchases(id, market_account_id) on delete cascade,
    foreign key (market_product_id, market_account_id) references public.market_products(id, market_account_id)
  );

  insert into auth.users values ('${actor}');
  insert into public.market_accounts values ('${account}', 'active'), ('${otherAccount}', 'active');
  insert into public.market_account_members(market_account_id, user_id, role, all_stores, status)
    values ('${account}', '${actor}', 'manager', true, 'active');
  insert into public.market_stores(id, market_account_id, name, store_type)
    values
      ('${storeA}', '${account}', 'Loja A', 'store'),
      ('${storeB}', '${account}', 'Loja B', 'store'),
      ('${storeC}', '${account}', 'Loja C', 'store'),
      ('${warehouseA}', '${account}', 'Galpao A', 'warehouse'),
      ('${warehouseB}', '${account}', 'Galpao B', 'warehouse');
  insert into public.market_products(id, market_account_id, name)
    values
      ('${productA}', '${account}', 'Produto A'),
      ('${productB}', '${account}', 'Produto B'),
      ('${productC}', '${account}', 'Produto C'),
      ('${productD}', '${account}', 'Produto D');
  insert into public.market_stock_movements(market_account_id, market_store_id, product_id, movement_type, direction, quantity)
    values
      ('${account}', '${warehouseA}', '${productA}', 'INVENTORY', 'IN', 7),
      ('${account}', '${warehouseB}', '${productA}', 'INVENTORY', 'IN', 3),
      ('${account}', '${warehouseA}', '${productB}', 'INVENTORY', 'IN', 100);
  insert into public.market_replenishment_runs(id, market_account_id, reference_date, algorithm_version, status, is_effective, started_at, finished_at)
    values
      ('${oldRun}', '${account}', date '2026-09-09', 'v1', 'completed', true, timestamptz '2026-09-09 06:00:00+00', timestamptz '2026-09-09 06:01:00+00'),
      ('${run}', '${account}', date '2026-09-10', 'v1', 'completed', true, timestamptz '2026-09-10 06:00:00+00', timestamptz '2026-09-10 06:01:00+00');
  insert into public.market_replenishment_candidates(run_id, market_account_id, store_id, product_id, reference_date, priority_level, rank_position, suggested_quantity)
    values
      ('${oldRun}', '${account}', '${storeA}', '${productA}', date '2026-09-09', 'critical', 1, 99),
      ('${run}', '${account}', '${storeA}', '${productA}', date '2026-09-10', 'critical', 2, 8),
      ('${run}', '${account}', '${storeB}', '${productA}', date '2026-09-10', 'high', 1, 6),
      ('${run}', '${account}', '${storeC}', '${productA}', date '2026-09-10', 'critical', 1, 5),
      ('${run}', '${account}', '${storeA}', '${productB}', date '2026-09-10', 'medium', 1, null),
      ('${run}', '${account}', '${storeB}', '${productC}', date '2026-09-10', 'medium', 1, 1.429),
      ('${run}', '${account}', '${storeA}', '${productD}', date '2026-09-10', 'low', 1, 9),
      ('${run}', '${account}', '${storeC}', '${productC}', date '2026-09-10', 'low', 2, null);
`)

await db.exec(sqlFile('202609100016_generate_replenishment_order_draft.sql'))
await db.exec(sqlFile('202609100017_read_replenishment_order_with_last_supplier.sql'))
await db.exec(sqlFile('202609100018_replenishment_order_review_backend.sql'))
await db.exec(sqlFile('202609110001_fix_replenishment_unknown_quantity_consolidation.sql'))
await db.exec(sqlFile('202609110002_round_replenishment_operational_quantities.sql'))
await db.exec(sqlFile('202609120001_filter_replenishment_draft_priorities.sql'))
await db.exec(sqlFile('202609120002_add_store_to_manual_replenishment_item.sql'))

const query = async (sql, params = []) => (await db.query(sql, params)).rows
let orderId

test('gera uma lista draft a partir do ultimo run efetivo', async () => {
  orderId = (await query('select public.market_generate_replenishment_order_draft($1) as id', [account]))[0].id
  assert.ok(orderId)
  const order = (await query('select * from public.market_replenishment_orders where id=$1', [orderId]))[0]
  assert.equal(order.run_id, run)
  assert.equal(order.status, 'draft')
})

test('draft inclui critical/high/medium e exclui LOW de itens e allocations sem alterar candidatos', async () => {
  const priorities = await query(`
    select distinct c.priority_level
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_candidates c on c.id = a.candidate_id
    join public.market_replenishment_order_items i on i.id = a.order_item_id
    where i.order_id = $1 order by c.priority_level
  `, [orderId])
  assert.deepEqual(priorities.map(row => row.priority_level), ['critical', 'high', 'medium'])
  assert.equal((await query('select count(*)::int as n from public.market_replenishment_order_items where order_id=$1 and product_id=$2', [orderId, productD]))[0].n, 0)
  assert.equal((await query("select count(*)::int as n from public.market_replenishment_candidates where run_id=$1 and priority_level='low'", [run]))[0].n, 2)
  const allocation = (await query(`
    select a.suggested_quantity, a.purchase_needed_quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id
    where i.order_id=$1 and i.product_id=$2
  `, [orderId, productC]))[0]
  assert.equal(Number(allocation.suggested_quantity), 2)
  assert.equal(Number(allocation.purchase_needed_quantity), 2)
  assert.equal(Number((await query('select suggested_quantity from public.market_replenishment_candidates where run_id=$1 and product_id=$2 and priority_level=$3', [run, productC, 'medium']))[0].suggested_quantity), 1.429)
})

test('consolida por produto e usa o saldo agregado dos warehouses uma unica vez', async () => {
  const items = await query(
    'select product_id,total_suggested_quantity,warehouse_stock_snapshot,suggested_purchase_quantity from public.market_replenishment_order_items where order_id=$1 order by product_id',
    [orderId],
  )
  const itemA = items.find((item) => item.product_id === productA)
  const itemB = items.find((item) => item.product_id === productB)
  const itemC = items.find((item) => item.product_id === productC)
  assert.equal(Number(itemA.total_suggested_quantity), 19)
  assert.equal(Number(itemA.warehouse_stock_snapshot), 10)
  assert.equal(Number(itemA.suggested_purchase_quantity), 9)
  assert.equal(itemB.total_suggested_quantity, null)
  assert.equal(Number(itemB.warehouse_stock_snapshot), 100)
  assert.equal(itemB.suggested_purchase_quantity, null)
  assert.equal(Number(itemC.total_suggested_quantity), 2)
  assert.equal(itemC.warehouse_stock_snapshot, null)
  assert.equal(Number(itemC.suggested_purchase_quantity), 2)
})

test('rateia warehouse por prioridade e rank, preservando candidate_id/store_id', async () => {
  const rows = await query(`
    select a.store_id, a.candidate_id, a.suggested_quantity, a.warehouse_allocated_quantity, a.purchase_needed_quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id = a.order_item_id
    where i.order_id = $1 and i.product_id = $2
    order by a.store_id
  `, [orderId, productA])
  const byStore = new Map(rows.map((row) => [row.store_id, row]))
  assert.equal(Number(byStore.get(storeC).warehouse_allocated_quantity), 5)
  assert.equal(Number(byStore.get(storeC).purchase_needed_quantity), 0)
  assert.equal(Number(byStore.get(storeA).warehouse_allocated_quantity), 5)
  assert.equal(Number(byStore.get(storeA).purchase_needed_quantity), 3)
  assert.equal(Number(byStore.get(storeB).warehouse_allocated_quantity), 0)
  assert.equal(Number(byStore.get(storeB).purchase_needed_quantity), 6)
  assert.ok(byStore.get(storeA).candidate_id)
})

test('suggested_quantity null vira pendencia sem compra automatica nem rateio inventado', async () => {
  const row = (await query(`
    select a.suggested_quantity, a.warehouse_allocated_quantity, a.purchase_needed_quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id = a.order_item_id
    where i.order_id = $1 and i.product_id = $2
  `, [orderId, productB]))[0]
  assert.equal(row.suggested_quantity, null)
  assert.equal(row.warehouse_allocated_quantity, null)
  assert.equal(row.purchase_needed_quantity, null)
})

test('RPC e idempotente para o mesmo run ativo', async () => {
  const second = (await query('select public.market_generate_replenishment_order_draft($1) as id', [account]))[0].id
  assert.equal(second, orderId)
  assert.equal((await query('select count(*)::int as n from public.market_replenishment_orders where run_id=$1', [run]))[0].n, 1)
  assert.equal((await query('select count(*)::int as n from public.market_replenishment_order_items where order_id=$1', [orderId]))[0].n, 3)
  assert.equal((await query(`
    select count(*)::int as n
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id = a.order_item_id
    where i.order_id = $1
  `, [orderId]))[0].n, 5)
})

test('leitura consolidada retorna ultimo fornecedor valido por produto sem N+1 nem historico duplicado', async () => {
  await db.exec(`
    insert into public.market_purchases(id, market_account_id, destination_store_id, supplier_name, supplier_document, invoice_number, invoice_series, issued_at, received_at, status)
      values
        ('${purchaseOld}', '${account}', '${warehouseA}', 'Fornecedor Antigo', '11111111000111', 'OLD-1', '1', timestamptz '2026-09-01 12:00:00+00', timestamptz '2026-09-02 12:00:00+00', 'completed'),
        ('${purchaseLatest}', '${account}', '${warehouseA}', 'Sendas Distribuidora S/A', '06057223000171', 'SEN-9', '2', timestamptz '2026-09-08 12:00:00+00', null, 'receiving'),
        ('${purchaseIgnored}', '${account}', '${warehouseA}', 'Fornecedor Ignorado', '99999999000199', 'IGN-1', '1', timestamptz '2026-09-09 12:00:00+00', null, 'ready'),
        ('${purchaseNoDocument}', '${account}', '${warehouseA}', 'Fornecedor Sem CNPJ', null, 'NOD-1', '1', timestamptz '2026-09-07 12:00:00+00', timestamptz '2026-09-07 13:00:00+00', 'completed');
    insert into public.market_purchase_items(id, market_account_id, market_purchase_id, line_number, market_product_id, supplier_product_code, quantity, stock_quantity, stock_unit, stock_unit_cost, reconciliation_status, stock_entry_status, received_at)
      values
        ('${itemOld}', '${account}', '${purchaseOld}', 1, '${productA}', 'A-old', 1, 1, 'UN', 1.230000, 'matched_manual', 'received', timestamptz '2026-09-02 12:00:00+00'),
        ('${itemLatest}', '${account}', '${purchaseLatest}', 1, '${productA}', 'A-new', 1, 1, 'UN', 4.560000, 'matched_manual', 'received', timestamptz '2026-09-08 13:00:00+00'),
        ('${itemIgnored}', '${account}', '${purchaseIgnored}', 1, '${productA}', 'A-ignore', 1, 1, 'UN', 9.990000, 'matched_manual', 'received', timestamptz '2026-09-09 13:00:00+00'),
        ('${itemNoDocument}', '${account}', '${purchaseNoDocument}', 1, '${productC}', 'C-new', 1, 1, 'UN', 7.890000, 'mapped', 'received', timestamptz '2026-09-07 13:00:00+00');
    insert into public.market_stock_movements(market_account_id, market_store_id, product_id, movement_type, direction, quantity, unit_cost, reference_type, reference_id, reference_item_id, occurred_at)
      values
        ('${account}', '${warehouseA}', '${productA}', 'PURCHASE', 'IN', 1, 1.230000, 'PURCHASE', '${purchaseOld}', '${itemOld}', timestamptz '2026-09-02 12:05:00+00'),
        ('${account}', '${warehouseA}', '${productA}', 'PURCHASE', 'IN', 1, 4.560000, 'PURCHASE', '${purchaseLatest}', '${itemLatest}', timestamptz '2026-09-08 13:05:00+00'),
        ('${account}', '${warehouseA}', '${productA}', 'PURCHASE', 'IN', 1, 9.990000, 'PURCHASE', '${purchaseIgnored}', '${itemIgnored}', timestamptz '2026-09-09 13:05:00+00'),
        ('${account}', '${warehouseA}', '${productC}', 'PURCHASE', 'IN', 1, 7.890000, 'PURCHASE', '${purchaseNoDocument}', '${itemNoDocument}', timestamptz '2026-09-07 13:05:00+00');
  `)

  const payload = (await query('select public.market_get_replenishment_order($1,$2) as result', [account, orderId]))[0].result
  assert.equal(payload.order.id, orderId)
  assert.equal(payload.items.length, 3)

  const byProduct = new Map(payload.items.map((item) => [item.productId, item]))
  const productAItem = byProduct.get(productA)
  assert.equal(productAItem.lastSupplier.supplierName, 'Sendas Distribuidora S/A')
  assert.equal(productAItem.lastSupplier.supplierDocument, '06057223000171')
  assert.equal(productAItem.lastSupplier.invoiceNumber, 'SEN-9')
  assert.equal(Number(productAItem.lastSupplier.unitCost), 4.56)
  assert.equal(productAItem.priority.criticalCount, 2)
  assert.equal(productAItem.allocations.length, 3)

  const productBItem = byProduct.get(productB)
  assert.equal(productBItem.lastSupplier, null)
  assert.equal(productBItem.totalSuggestedQuantity, null)

  const productCItem = byProduct.get(productC)
  assert.equal(productCItem.lastSupplier.supplierName, 'Fornecedor Sem CNPJ')
  assert.equal(productCItem.lastSupplier.supplierDocument, null)
  assert.equal(Number(productCItem.lastSupplier.unitCost), 7.89)
})

test('ajusta quantidade em draft preservando valores e origem do batch', async () => {
  const itemA = (await query(
    'select * from public.market_replenishment_order_items where order_id=$1 and product_id=$2',
    [orderId, productA],
  ))[0]

  const result = (await query(
    'select public.market_update_replenishment_order_item_quantity($1,$2,$3,$4) as id',
    [account, orderId, itemA.id, 12.5],
  ))[0]
  assert.equal(result.id, itemA.id)

  const updated = (await query(
    'select source,total_suggested_quantity,suggested_purchase_quantity,adjusted_purchase_quantity,status from public.market_replenishment_order_items where id=$1',
    [itemA.id],
  ))[0]
  assert.equal(updated.source, 'batch')
  assert.equal(updated.status, 'pending')
  assert.equal(Number(updated.total_suggested_quantity), 19)
  assert.equal(Number(updated.suggested_purchase_quantity), 9)
  assert.equal(Number(updated.adjusted_purchase_quantity), 13)

  const allocations = await query(
    'select count(*)::int as n from public.market_replenishment_order_allocations where order_item_id=$1',
    [itemA.id],
  )
  assert.equal(allocations[0].n, 3)

  const payload = (await query('select public.market_get_replenishment_order($1,$2) as result', [account, orderId]))[0].result
  const productAItem = payload.items.find((item) => item.productId === productA)
  assert.equal(productAItem.source, 'batch')
  assert.equal(Number(productAItem.effectivePurchaseQuantity), 13)
})

test('inclusao manual exige loja, cria allocation, divide Galpao/compra e preserva validacoes', async () => {
  orderId = (await query('select public.market_generate_replenishment_order_draft($1) as id', [account]))[0].id
  const add = (store, quantity = 6, product = productD) => query(
    'select public.market_add_replenishment_order_manual_item($1,$2,$3,$4,$5) as id',
    [account, orderId, product, quantity, store],
  )
  await assert.rejects(add(null), /REPLENISHMENT_ORDER_INVALID_INPUT/)
  await assert.rejects(query('select public.market_add_replenishment_order_manual_item($1,$2,$3,$4)', [account, orderId, productD, 6]), /does not exist/)
  await assert.rejects(add(warehouseA), /REPLENISHMENT_ORDER_STORE_UNAVAILABLE/)
  await assert.rejects(add(storeA, null), /REPLENISHMENT_ORDER_INVALID_QUANTITY/)
  await assert.rejects(add(storeA, 6, productA), /REPLENISHMENT_ORDER_DUPLICATE_PRODUCT/)

  for (const scenario of [
    { stock: 4, quantity: 6, need: 6, warehouse: 4, purchase: 2 },
    { stock: 10, quantity: 6, need: 6, warehouse: 6, purchase: 0 },
    { stock: null, quantity: 2.4833, need: 3, warehouse: 0, purchase: 3 },
    { stock: -2, quantity: 6, need: 6, warehouse: 0, purchase: 6 },
  ]) {
    await db.exec('begin')
    try {
      if (scenario.stock !== null) await query(`
        insert into public.market_stock_movements(market_account_id, market_store_id, product_id, movement_type, direction, quantity)
        values ($1,$2,$3,'INVENTORY','IN',$4)
      `, [account, warehouseA, productD, scenario.stock])
      const id = (await add(storeA, scenario.quantity))[0].id
      const row = (await query(`
        select i.source, i.total_suggested_quantity, i.warehouse_stock_snapshot,
          i.suggested_purchase_quantity, i.adjusted_purchase_quantity,
          a.store_id, a.candidate_id, a.suggested_quantity,
          a.warehouse_allocated_quantity, a.purchase_needed_quantity
        from public.market_replenishment_order_items i
        join public.market_replenishment_order_allocations a on a.order_item_id=i.id
        where i.id=$1 and a.market_account_id=$2
      `, [id, account]))[0]
      assert.equal(row.source, 'manual_review')
      assert.equal(row.store_id, storeA)
      assert.equal(row.candidate_id, null)
      assert.equal(Number(row.total_suggested_quantity), scenario.need)
      assert.equal(Number(row.suggested_quantity), scenario.need)
      assert.equal(row.warehouse_stock_snapshot === null ? null : Number(row.warehouse_stock_snapshot), scenario.stock)
      assert.equal(Number(row.warehouse_allocated_quantity), scenario.warehouse)
      assert.equal(Number(row.purchase_needed_quantity), scenario.purchase)
      assert.equal(Number(row.suggested_purchase_quantity), scenario.purchase)
      assert.equal(row.adjusted_purchase_quantity, null)
    } finally { await db.exec('rollback') }
  }
  await db.exec('begin')
  await query("update public.market_replenishment_orders set status='approved' where id=$1", [orderId])
  await assert.rejects(add(storeA), /REPLENISHMENT_ORDER_NOT_DRAFT/)
  await db.exec('rollback')

  await db.exec('begin')
  const foreignStore = '20000000-0000-4000-8000-000000000099'
  await query("insert into public.market_stores(id,market_account_id,name,store_type) values ($1,$2,'Outra loja','store')", [foreignStore, otherAccount])
  await assert.rejects(add(foreignStore), /REPLENISHMENT_ORDER_STORE_UNAVAILABLE/)
  await db.exec('rollback')

  const id = (await add(storeA, 4))[0].id
  await assert.rejects(add(storeA, 4), /REPLENISHMENT_ORDER_DUPLICATE_PRODUCT/)
  assert.equal((await query('select count(*)::int as n from public.market_replenishment_order_allocations where order_item_id=$1', [id]))[0].n, 1)
})

test('impede produto duplicado na mesma order', async () => {
  await assert.rejects(
    query('select public.market_add_replenishment_order_manual_item($1,$2,$3,$4,$5)', [account, orderId, productA, 1, storeA]),
    /REPLENISHMENT_ORDER_DUPLICATE_PRODUCT/,
  )
})

test('retirada na revisao faz cancelamento logico sem apagar rastreabilidade', async () => {
  const itemC = (await query(
    'select * from public.market_replenishment_order_items where order_id=$1 and product_id=$2',
    [orderId, productC],
  ))[0]

  const result = (await query(
    'select public.market_cancel_replenishment_order_item_review($1,$2,$3,$4) as id',
    [account, orderId, itemC.id, 'Comprado fora da lista'],
  ))[0]
  assert.equal(result.id, itemC.id)

  const cancelled = (await query(
    'select source,status,total_suggested_quantity,suggested_purchase_quantity,review_cancelled_at,review_cancelled_by,review_cancellation_reason from public.market_replenishment_order_items where id=$1',
    [itemC.id],
  ))[0]
  assert.equal(cancelled.source, 'batch')
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(Number(cancelled.total_suggested_quantity), 2)
  assert.equal(Number(cancelled.suggested_purchase_quantity), 2)
  assert.ok(cancelled.review_cancelled_at)
  assert.equal(cancelled.review_cancelled_by, actor)
  assert.equal(cancelled.review_cancellation_reason, 'Comprado fora da lista')

  const allocation = (await query(
    'select status,candidate_id,cancelled_at,cancellation_reason from public.market_replenishment_order_allocations where order_item_id=$1',
    [itemC.id],
  ))[0]
  assert.equal(allocation.status, 'cancelled')
  assert.ok(allocation.candidate_id)
  assert.ok(allocation.cancelled_at)
  assert.equal(allocation.cancellation_reason, 'Comprado fora da lista')
})

test('aprova lista draft e bloqueia alteracoes de revisao depois disso', async () => {
  const approvedId = (await query(
    'select public.market_approve_replenishment_order($1,$2) as id',
    [account, orderId],
  ))[0].id
  assert.equal(approvedId, orderId)

  const order = (await query('select status,approved_at,approved_by from public.market_replenishment_orders where id=$1', [orderId]))[0]
  assert.equal(order.status, 'approved')
  assert.ok(order.approved_at)
  assert.equal(order.approved_by, actor)

  const itemA = (await query(
    'select id from public.market_replenishment_order_items where order_id=$1 and product_id=$2',
    [orderId, productA],
  ))[0]
  await assert.rejects(
    query('select public.market_update_replenishment_order_item_quantity($1,$2,$3,$4)', [account, orderId, itemA.id, 10]),
    /REPLENISHMENT_ORDER_NOT_DRAFT/,
  )
  await assert.rejects(
    query('select public.market_add_replenishment_order_manual_item($1,$2,$3,$4,$5)', [account, orderId, productC, 1, storeA]),
    /REPLENISHMENT_ORDER_NOT_DRAFT/,
  )
  await assert.rejects(
    query('select public.market_cancel_replenishment_order_item_review($1,$2,$3,$4)', [account, orderId, itemA.id, 'nao revisar']),
    /REPLENISHMENT_ORDER_NOT_DRAFT/,
  )
})

test('perfil sem escopo total nao gera lista consolidada', async () => {
  await db.exec("update public.market_account_members set all_stores = false")
  await assert.rejects(
    query('select public.market_generate_replenishment_order_draft($1)', [account]),
    /REPLENISHMENT_ORDER_PERMISSION_DENIED/,
  )
  await assert.rejects(
    query('select public.market_get_replenishment_order($1,$2)', [account, orderId]),
    /REPLENISHMENT_ORDER_PERMISSION_DENIED/,
  )
  const itemA = (await query(
    'select id from public.market_replenishment_order_items where order_id=$1 and product_id=$2',
    [orderId, productA],
  ))[0]
  await assert.rejects(
    query('select public.market_update_replenishment_order_item_quantity($1,$2,$3,$4)', [account, orderId, itemA.id, 10]),
    /REPLENISHMENT_ORDER_PERMISSION_DENIED/,
  )
})
