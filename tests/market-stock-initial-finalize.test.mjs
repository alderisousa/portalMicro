// PostgreSQL embarcado, mesmo padrao de tests/purchase-review-db.test.mjs.
// Cobre o bug real confirmado em homologacao: finalizacao de inventario
// 'initial' duplicava o saldo de produtos que ja tinham movimento anterior
// (ex.: PURCHASE/IN de Compras) em vez de reconciliar a diferenca.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const store = '20000000-0000-4000-8000-000000000001'
const actor = '40000000-0000-4000-8000-000000000001'
const productWithBalance = (n) => `30000000-0000-4000-8000-00000000000${n}`
// Cenarios 1/2/3 do pedido: mesmo saldo anterior (64), contagens diferentes.
const pGalak = productWithBalance(1)   // saldo 64 / contagem 64 -> diferenca 0
const pDori = productWithBalance(2)    // saldo 64 / contagem 60 -> OUT 4
const pGalvani = productWithBalance(3) // saldo 64 / contagem 70 -> IN 6
const pNovo = productWithBalance(4)    // sem movimento anterior / contagem 10
const pZero = productWithBalance(5)    // saldo conhecido 0 (IN 20 - OUT 20) / contagem 5 -> IN 5

// Base minima (mesmo espirito de purchase-review-db.test.mjs: tabelas
// hand-built só com as colunas que as RPCs de Estoque realmente usam),
// seguida das migrations REAIS de Estoque, na ordem de producao, para
// exercitar o codigo de fato aplicado (nenhuma logica reescrita a mao aqui).
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;

  create table public.market_accounts(id uuid primary key, status text not null default 'active');
  create table public.market_account_members(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null, user_id uuid not null,
    role text not null, all_stores boolean not null default false, status text not null default 'active',
    created_at timestamptz not null default now()
  );
  create table public.market_stores(
    id uuid primary key, market_account_id uuid not null, name text not null,
    status text not null default 'active', stock_control_started_at timestamptz null,
    updated_at timestamptz not null default now(),
    unique (id, market_account_id)
  );
  create table public.market_member_stores(
    market_account_member_id uuid not null, market_store_id uuid not null,
    primary key (market_account_member_id, market_store_id)
  );
  create table public.market_products(
    id uuid primary key, market_account_id uuid not null, name text not null,
    ean text null, sku text null, unit text not null default 'UN', status text not null default 'active',
    unique (id, market_account_id)
  );
  create table public.market_stock_movements(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null, market_store_id uuid not null,
    product_id uuid not null,
    movement_type text not null check (movement_type in ('PURCHASE','SALE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT_IN','ADJUSTMENT_OUT','LOSS','INVENTORY')),
    direction text not null check (direction in ('IN','OUT')), quantity numeric(14,3) not null check (quantity > 0),
    unit_cost numeric(14,4) null, reference_type text null, reference_id uuid null, notes text null,
    occurred_at timestamptz not null default now(), created_by uuid null, created_at timestamptz not null default now()
  );
  create view public.market_stock_balance as
    select market_account_id, market_store_id, product_id,
      sum(case when direction='IN' then quantity else -quantity end)::numeric(14,4) as quantity_on_hand,
      max(occurred_at) as last_movement_at
    from public.market_stock_movements group by market_account_id, market_store_id, product_id;

  insert into public.market_accounts values ('${account}','active');
  insert into auth.users values ('${actor}');
  insert into public.market_account_members(id, market_account_id, user_id, role, all_stores, status)
    values ('50000000-0000-4000-8000-000000000001','${account}','${actor}','owner',true,'active');
  insert into public.market_stores(id, market_account_id, name) values ('${store}','${account}','Galpão Market');
  insert into public.market_products(id, market_account_id, name, ean, unit) values
    ('${pGalak}','${account}','GALAK 80G','7891000368626','UN'),
    ('${pDori}','${account}','GOMA DORI','7896058506099','UN'),
    ('${pGalvani}','${account}','DOCE GALVANI','7896732300159','UN'),
    ('${pNovo}','${account}','PRODUTO NOVO SEM HISTORICO',null,'UN'),
    ('${pZero}','${account}','PRODUTO SALDO CONHECIDO ZERO',null,'UN');

  -- Saldo operacional ja existente (equivalente a PURCHASE/IN de Compras),
  -- ANTES de qualquer inventario finalizado nesta loja — exatamente o caso
  -- real: stock_control_started_at continua null neste ponto.
  insert into public.market_stock_movements (market_account_id, market_store_id, product_id, movement_type, direction, quantity, reference_type, occurred_at)
  values
    ('${account}','${store}','${pGalak}','PURCHASE','IN',64,'PURCHASE','2026-01-01'),
    ('${account}','${store}','${pDori}','PURCHASE','IN',64,'PURCHASE','2026-01-01'),
    ('${account}','${store}','${pGalvani}','PURCHASE','IN',64,'PURCHASE','2026-01-01'),
    -- pZero: saldo CONHECIDO igual a zero (ha movimento, mas o net e 0) — nao
    -- pode se confundir com pNovo (nunca teve nenhum movimento).
    ('${account}','${store}','${pZero}','PURCHASE','IN',20,'PURCHASE','2026-01-01'),
    ('${account}','${store}','${pZero}','ADJUSTMENT_OUT','OUT',20,null,'2026-01-01');
`)

for (const name of [
  '202609010001_create_market_stock_foundation.sql',
  '202609010002_create_market_inventory_drafts.sql',
  '202609010004_add_market_cycle_inventory.sql',
  '202609080002_fix_market_initial_inventory_balance_duplication.sql',
]) await db.exec(sqlFile(name))

const query = async (sql, params = []) => (await db.query(sql, params)).rows

test('setup: saldo anterior existe antes de qualquer inventário (caso real: Compras chegou antes do inventário inicial)', async () => {
  const balances = await query(
    'select product_id, quantity_on_hand from market_stock_balance where market_account_id=$1 and market_store_id=$2 order by product_id',
    [account, store],
  )
  const byProduct = Object.fromEntries(balances.map((r) => [r.product_id, Number(r.quantity_on_hand)]))
  assert.equal(byProduct[pGalak], 64)
  assert.equal(byProduct[pDori], 64)
  assert.equal(byProduct[pGalvani], 64)
  assert.equal(byProduct[pZero], 0)
  assert.equal(byProduct[pNovo], undefined, 'produto sem nenhum movimento não deve ter linha em market_stock_balance')
  const store0 = (await query('select stock_control_started_at from market_stores where id=$1', [store]))[0]
  assert.equal(store0.stock_control_started_at, null)
})

let sessionId, sessionVersion
test('draft inicial é salvo com as 5 contagens (mesma RPC/fluxo de sempre, sem mudança)', async () => {
  const items = [
    { productId: pGalak, quantity: 64 },   // cenário 1: saldo=contagem
    { productId: pDori, quantity: 60 },    // cenário 2: saldo > contagem
    { productId: pGalvani, quantity: 70 }, // cenário 3: saldo < contagem
    { productId: pNovo, quantity: 10 },    // cenário 4: sem saldo anterior
    { productId: pZero, quantity: 5 },     // cenário 5: saldo conhecido = 0
  ]
  const saved = (await query(
    'select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
    [store, null, null, '2026-02-01T10:00:00Z', JSON.stringify(items)],
  ))[0].result
  assert.equal(saved.inventoryType, 'initial')
  assert.equal(saved.items.length, 5)
  sessionId = saved.id; sessionVersion = saved.version
})

let finalizeResult
test('finalização: gera somente os movimentos de ajuste necessários (mesma lógica de diferença do cycle, sem duplicar o saldo já existente)', async () => {
  finalizeResult = (await query('select market_finalize_inventory_draft($1,$2) as result', [sessionId, sessionVersion]))[0].result
  assert.equal(finalizeResult.inventoryType, 'initial')
  assert.equal(finalizeResult.inventorySessionStatus, 'completed')

  const movements = await query(
    `select product_id, movement_type, direction, quantity from market_stock_movements
     where market_account_id=$1 and market_store_id=$2 and reference_type='INVENTORY_SESSION' and reference_id=$3
     order by product_id`,
    [account, store, sessionId],
  )
  const byProduct = Object.fromEntries(movements.map((m) => [m.product_id, m]))

  // Cenário 1 — saldo 64 / contagem 64 -> diferença 0 -> NENHUM movimento de ajuste (não duplica).
  assert.equal(byProduct[pGalak], undefined, 'saldo igual à contagem não pode gerar movimento algum')

  // Cenário 2 — saldo 64 / contagem 60 -> ADJUSTMENT_OUT / OUT / 4.
  assert.equal(byProduct[pDori].movement_type, 'ADJUSTMENT_OUT')
  assert.equal(byProduct[pDori].direction, 'OUT')
  assert.equal(Number(byProduct[pDori].quantity), 4)

  // Cenário 3 — saldo 64 / contagem 70 -> ADJUSTMENT_IN / IN / 6.
  assert.equal(byProduct[pGalvani].movement_type, 'ADJUSTMENT_IN')
  assert.equal(byProduct[pGalvani].direction, 'IN')
  assert.equal(Number(byProduct[pGalvani].quantity), 6)

  // Cenário 5 — saldo conhecido 0 / contagem 5 -> ADJUSTMENT_IN / IN / 5 (não confundido com "nunca teve referência").
  assert.equal(byProduct[pZero].movement_type, 'ADJUSTMENT_IN')
  assert.equal(byProduct[pZero].direction, 'IN')
  assert.equal(Number(byProduct[pZero].quantity), 5)

  // Cenário 4 — sem saldo anterior -> caminho original preservado: INVENTORY/IN
  // via market_start_stock_control, referência STOCK_INITIALIZATION (não INVENTORY_SESSION).
  const novoMovement = (await query(
    `select movement_type, direction, quantity, reference_type from market_stock_movements
     where market_account_id=$1 and market_store_id=$2 and product_id=$3`,
    [account, store, pNovo],
  ))[0]
  assert.equal(novoMovement.movement_type, 'INVENTORY')
  assert.equal(novoMovement.direction, 'IN')
  assert.equal(Number(novoMovement.quantity), 10)
  assert.equal(novoMovement.reference_type, 'STOCK_INITIALIZATION')
})

test('saldo final em market_stock_balance bate exatamente com os 5 cenários do pedido', async () => {
  const balances = await query(
    'select product_id, quantity_on_hand from market_stock_balance where market_account_id=$1 and market_store_id=$2',
    [account, store],
  )
  const byProduct = Object.fromEntries(balances.map((r) => [r.product_id, Number(r.quantity_on_hand)]))
  assert.equal(byProduct[pGalak], 64, 'cenário 1: saldo final permanece 64, sem duplicar')
  assert.equal(byProduct[pDori], 60, 'cenário 2: saldo final 60')
  assert.equal(byProduct[pGalvani], 70, 'cenário 3: saldo final 70')
  assert.equal(byProduct[pNovo], 10, 'cenário 4: saldo final 10')
  assert.equal(byProduct[pZero], 5, 'cenário 5: saldo final 5')
})

test('stock_control_started_at é gravado (marco formal), mesmo quando nenhum produto era "novo"', async () => {
  const storeRow = (await query('select stock_control_started_at from market_stores where id=$1', [store]))[0]
  assert.ok(storeRow.stock_control_started_at, 'marco de início do controle de estoque precisa ser preenchido')
})

test('próximo inventário desta loja já nasce cycle (transição initial -> controle iniciado -> cycle preservada)', async () => {
  const items = [{ productId: pGalak, quantity: 64 }]
  const saved = (await query(
    'select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
    [store, null, null, '2026-03-01T10:00:00Z', JSON.stringify(items)],
  ))[0].result
  assert.equal(saved.inventoryType, 'cycle')
})

test('reprocessar a mesma sessão já finalizada é bloqueado (sem duplicar movimentos)', async () => {
  await assert.rejects(
    query('select market_finalize_inventory_draft($1,$2) as result', [sessionId, finalizeResult.inventorySessionVersion]),
    /INVENTORY_DRAFT_UNAVAILABLE/,
  )
  const count = (await query(
    `select count(*)::int as n from market_stock_movements where reference_type='INVENTORY_SESSION' and reference_id=$1`,
    [sessionId],
  ))[0].n
  assert.equal(count, 3, 'continuam só os 3 ajustes originais (Dori, Galvani, Zero) — nenhuma duplicação')
  await db.close()
})
