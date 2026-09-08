// PostgreSQL embarcado, mesmo padrao de tests/market-stock-counted-reason.test.mjs.
// Cobre a regra 5 (202609080004): reason_code precisa ser coerente com o
// sentido do ajuste (IN-only, OUT-only, BOTH). Nao repete a cobertura ja
// feita pelas regras 3/4 (202609080003) nem pela reconciliacao de saldo
// (202609080002) — so o que a regra 5 acrescenta.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const storeCycle = '20000000-0000-4000-8000-000000000001'       // ja com stock_control_started_at
const storeInitialReject = '20000000-0000-4000-8000-000000000002' // stock_control_started_at null, saldo ja existente (Galpao-style)
const storeInitialAccept = '20000000-0000-4000-8000-000000000003'
const actor = '40000000-0000-4000-8000-000000000001'
const p = (n) => `30000000-0000-4000-8000-00000000000${n}`
const pReject = p(1)      // reutilizado nas 5 tentativas de rejeicao (item substituido a cada save)
const pOutValid = p(2)    // saldo 30 / contagem 27 -> diferenca -3, EXPIRED_LOSS (OUT-only, sinal correto)
const pInValid = p(3)     // saldo 30 / contagem 33 -> diferenca +3, UNREGISTERED_PURCHASE (IN-only, sinal correto)
const pBothPos = p(4)     // saldo 30 / contagem 33 -> +3, PREVIOUS_COUNT_ERROR (BOTH)
const pBothNeg = p(5)     // saldo 30 / contagem 27 -> -3, UNREGISTERED_TRANSFER (BOTH)
const pOtherPos = p(6)    // saldo 30 / contagem 33 -> +3, OTHER com nota (BOTH)
const pZeroStale = p(7)   // saldo 30 / contagem 30 -> diferenca 0, reason_code incoerente (DAMAGE) mas nunca avaliado
const pOtherNoNote = p(8) // saldo 30 / contagem 33 -> +3, OTHER sem nota -> continua caindo na regra 4, nao na 5
const pGalak1 = '31000000-0000-4000-8000-000000000001' // storeInitialReject: saldo 64, contagem 70 (+6) DAMAGE -> rejeita
const pGalak2 = '31000000-0000-4000-8000-000000000002' // storeInitialAccept: saldo 64, contagem 60 (-4) DAMAGE -> aceita

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
    unit_cost numeric(14,4) null, reference_type text null, reference_id uuid null, reference_item_id uuid null, notes text null,
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
  insert into public.market_stores(id, market_account_id, name, stock_control_started_at) values
    ('${storeCycle}','${account}','Loja Cycle','2026-01-01'),
    ('${storeInitialReject}','${account}','Galpao Reject',null),
    ('${storeInitialAccept}','${account}','Galpao Accept',null);
  insert into public.market_products(id, market_account_id, name, unit) values
    ('${pReject}','${account}','Produto Reject','UN'),
    ('${pOutValid}','${account}','Produto Out Valido','UN'),
    ('${pInValid}','${account}','Produto In Valido','UN'),
    ('${pBothPos}','${account}','Produto Both Positivo','UN'),
    ('${pBothNeg}','${account}','Produto Both Negativo','UN'),
    ('${pOtherPos}','${account}','Produto Other Positivo','UN'),
    ('${pZeroStale}','${account}','Produto Zero Stale','UN'),
    ('${pOtherNoNote}','${account}','Produto Other Sem Nota','UN'),
    ('${pGalak1}','${account}','GALAK Reject','UN'),
    ('${pGalak2}','${account}','GALAK Accept','UN');

  -- Saldo operacional ja existente para todos os produtos da loja cycle (30) e
  -- dos dois galpoes (64, mesmo caso real Galpao/GALAK ja usado nos outros testes).
  insert into public.market_stock_movements (market_account_id, market_store_id, product_id, movement_type, direction, quantity, occurred_at)
  values
    ('${account}','${storeCycle}','${pReject}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pOutValid}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pInValid}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pBothPos}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pBothNeg}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pOtherPos}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pZeroStale}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pOtherNoNote}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeInitialReject}','${pGalak1}','PURCHASE','IN',64,'2026-01-01'),
    ('${account}','${storeInitialAccept}','${pGalak2}','PURCHASE','IN',64,'2026-01-01');
`)

for (const name of [
  '202609010001_create_market_stock_foundation.sql',
  '202609010002_create_market_inventory_drafts.sql',
  '202609010004_add_market_cycle_inventory.sql',
  '202609080002_fix_market_initial_inventory_balance_duplication.sql',
  '202609080003_add_market_inventory_counted_reason.sql',
  '202609080004_add_market_inventory_reason_sign_check.sql',
]) await db.exec(sqlFile(name))

const query = async (sql, params = []) => (await db.query(sql, params)).rows
const item = (productId, quantity, over = {}) => ({ productId, quantity, isCounted: true, reasonCode: null, reasonNote: null, ...over })
const save = (store, sessionId, version, items) => query(
  'select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
  [store, sessionId, version, '2026-02-01T10:00:00Z', JSON.stringify(items)],
).then((r) => r[0].result)
const finalize = (sessionId, version) => query('select market_finalize_inventory_draft($1,$2) as result', [sessionId, version]).then((r) => r[0].result)

let sessionId, version

test('rejeita EXPIRED_LOSS em diferenca positiva (OUT-only com sinal IN)', async () => {
  const saved = await save(storeCycle, null, null, [item(pReject, 33, { reasonCode: 'EXPIRED_LOSS' })])
  sessionId = saved.id; version = saved.version
  await assert.rejects(finalize(sessionId, version), /INVENTORY_REASON_SIGN_MISMATCH/)
})

test('rejeita DAMAGE em diferenca positiva (o caso real do smoke Galpao/Alderi)', async () => {
  const saved = await save(storeCycle, sessionId, version, [item(pReject, 33, { reasonCode: 'DAMAGE' })])
  sessionId = saved.id; version = saved.version
  await assert.rejects(finalize(sessionId, version), /INVENTORY_REASON_SIGN_MISMATCH/)
})

test('rejeita THEFT_LOSS em diferenca positiva (OUT-only com sinal IN)', async () => {
  const saved = await save(storeCycle, sessionId, version, [item(pReject, 33, { reasonCode: 'THEFT_LOSS' })])
  sessionId = saved.id; version = saved.version
  await assert.rejects(finalize(sessionId, version), /INVENTORY_REASON_SIGN_MISMATCH/)
})

test('rejeita INTERNAL_USE em diferenca positiva (OUT-only com sinal IN)', async () => {
  const saved = await save(storeCycle, sessionId, version, [item(pReject, 33, { reasonCode: 'INTERNAL_USE' })])
  sessionId = saved.id; version = saved.version
  await assert.rejects(finalize(sessionId, version), /INVENTORY_REASON_SIGN_MISMATCH/)
})

test('rejeita UNREGISTERED_PURCHASE em diferenca negativa (IN-only com sinal OUT)', async () => {
  const saved = await save(storeCycle, sessionId, version, [item(pReject, 27, { reasonCode: 'UNREGISTERED_PURCHASE' })])
  sessionId = saved.id; version = saved.version
  await assert.rejects(finalize(sessionId, version), /INVENTORY_REASON_SIGN_MISMATCH/)
})

test('aceita OUT-only/IN-only com sinal correto, BOTH nos dois sentidos, e ignora reason_code incoerente quando diferenca=0', async () => {
  const saved = await save(storeCycle, sessionId, version, [
    item(pOutValid, 27, { reasonCode: 'EXPIRED_LOSS' }),          // -3, OUT-only com sinal OUT -> ok
    item(pInValid, 33, { reasonCode: 'UNREGISTERED_PURCHASE' }),  // +3, IN-only com sinal IN -> ok
    item(pBothPos, 33, { reasonCode: 'PREVIOUS_COUNT_ERROR' }),   // +3, BOTH -> ok
    item(pBothNeg, 27, { reasonCode: 'UNREGISTERED_TRANSFER' }),  // -3, BOTH -> ok
    item(pOtherPos, 33, { reasonCode: 'OTHER', reasonNote: 'Achado em outra prateleira' }), // +3, BOTH -> ok
    item(pZeroStale, 30, { reasonCode: 'DAMAGE' }),                // diferenca 0 -> regra 5 nunca avalia
  ])
  sessionId = saved.id; version = saved.version
  const result = await finalize(sessionId, version)
  assert.equal(result.inventoryType, 'cycle')

  const movements = await query(
    `select product_id, movement_type, direction, quantity from market_stock_movements
     where market_account_id=$1 and market_store_id=$2 and reference_type='INVENTORY_SESSION' and reference_id=$3
     order by product_id`,
    [account, storeCycle, sessionId],
  )
  const byProduct = Object.fromEntries(movements.map((m) => [m.product_id, m]))
  assert.equal(byProduct[pOutValid].movement_type, 'ADJUSTMENT_OUT'); assert.equal(Number(byProduct[pOutValid].quantity), 3)
  assert.equal(byProduct[pInValid].movement_type, 'ADJUSTMENT_IN'); assert.equal(Number(byProduct[pInValid].quantity), 3)
  assert.equal(byProduct[pBothPos].movement_type, 'ADJUSTMENT_IN'); assert.equal(Number(byProduct[pBothPos].quantity), 3)
  assert.equal(byProduct[pBothNeg].movement_type, 'ADJUSTMENT_OUT'); assert.equal(Number(byProduct[pBothNeg].quantity), 3)
  assert.equal(byProduct[pOtherPos].movement_type, 'ADJUSTMENT_IN'); assert.equal(Number(byProduct[pOtherPos].quantity), 3)
  assert.equal(byProduct[pZeroStale], undefined, 'diferenca 0 nao gera movimento, mesmo com reason_code incoerente gravado')
})

test('OTHER sem reason_note continua caindo na regra 4 (INVENTORY_REASON_REQUIRED), nao na regra 5', async () => {
  const saved = await save(storeCycle, null, null, [item(pOtherNoNote, 33, { reasonCode: 'OTHER', reasonNote: '   ' })])
  await assert.rejects(finalize(saved.id, saved.version), /INVENTORY_REASON_REQUIRED/)
})

test('initial: rejeita DAMAGE em diferenca positiva mesmo com saldo ja existente (Galpao-style)', async () => {
  const saved = await save(storeInitialReject, null, null, [item(pGalak1, 70, { reasonCode: 'DAMAGE' })]) // saldo 64, contagem 70 -> +6
  assert.equal(saved.inventoryType, 'initial')
  await assert.rejects(finalize(saved.id, saved.version), /INVENTORY_REASON_SIGN_MISMATCH/)
})

test('initial: aceita DAMAGE em diferenca negativa com saldo ja existente (Galpao-style)', async () => {
  const saved = await save(storeInitialAccept, null, null, [item(pGalak2, 60, { reasonCode: 'DAMAGE' })]) // saldo 64, contagem 60 -> -4
  assert.equal(saved.inventoryType, 'initial')
  const result = await finalize(saved.id, saved.version)
  assert.equal(result.inventoryType, 'initial')

  const movement = (await query(
    `select movement_type, direction, quantity from market_stock_movements
     where market_account_id=$1 and market_store_id=$2 and reference_type='INVENTORY_SESSION' and reference_id=$3`,
    [account, storeInitialAccept, saved.id],
  ))[0]
  assert.equal(movement.movement_type, 'ADJUSTMENT_OUT'); assert.equal(Number(movement.quantity), 4)

  const balance = (await query('select quantity_on_hand from market_stock_balance where market_account_id=$1 and market_store_id=$2 and product_id=$3', [account, storeInitialAccept, pGalak2]))[0]
  assert.equal(Number(balance.quantity_on_hand), 60)
  await db.close()
})
