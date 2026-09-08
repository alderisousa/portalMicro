// PostgreSQL embarcado, mesmo padrao de tests/purchase-review-db.test.mjs e
// tests/market-stock-initial-finalize.test.mjs. Cobre "não contado" ≠ zero e
// motivo obrigatório de divergência (202609080003), sem tocar na regra de
// reconciliação de saldo já corrigida (202609080002).
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const storeCycle = '20000000-0000-4000-8000-000000000001' // já com stock_control_started_at (sessões nascem 'cycle')
const storeInitial = '20000000-0000-4000-8000-000000000002' // stock_control_started_at ainda null
const actor = '40000000-0000-4000-8000-000000000001'
const p = (n) => `30000000-0000-4000-8000-00000000000${n}`
const pB = p(1) // saldo 30 / contagem 30 -> diferença 0 (cenário B)
const pC = p(2) // saldo 30 / contagem 27 -> OUT 3 (cenário C)
const pD = p(3) // saldo 30 / contagem 33 -> IN 3 (cenário D)
const pE = p(4) // saldo 30 / contagem 0 -> OUT 30 (cenário E)
const pF = p(5) // saldo conhecido 0 / contagem 5 -> IN 5 (cenário F)
const pG = p(6) // saldo não registrado / contagem 10 (cenário G)
const pGalak = '31000000-0000-4000-8000-000000000001' // loja 'initial' com saldo já existente (Galpão-style)

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
    ('${storeInitial}','${account}','Galpão Market',null);
  insert into public.market_products(id, market_account_id, name, unit) values
    ('${pB}','${account}','Produto B','UN'), ('${pC}','${account}','Produto C','UN'),
    ('${pD}','${account}','Produto D','UN'), ('${pE}','${account}','Produto E','UN'),
    ('${pF}','${account}','Produto F','UN'), ('${pG}','${account}','Produto G novo','UN'),
    ('${pGalak}','${account}','GALAK 80G','UN');

  -- Saldo operacional já existente (Compras/movimentos anteriores):
  insert into public.market_stock_movements (market_account_id, market_store_id, product_id, movement_type, direction, quantity, occurred_at)
  values
    ('${account}','${storeCycle}','${pB}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pC}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pD}','PURCHASE','IN',30,'2026-01-01'),
    ('${account}','${storeCycle}','${pE}','PURCHASE','IN',30,'2026-01-01'),
    -- pF: saldo CONHECIDO igual a zero (movimento existe, net = 0).
    ('${account}','${storeCycle}','${pF}','PURCHASE','IN',20,'2026-01-01'),
    ('${account}','${storeCycle}','${pF}','ADJUSTMENT_OUT','OUT',20,'2026-01-01'),
    -- Galpão (sessão 'initial'): saldo já existente via Compras, mesmo caso real.
    ('${account}','${storeInitial}','${pGalak}','PURCHASE','IN',64,'2026-01-01');
`)

for (const name of [
  '202609010001_create_market_stock_foundation.sql',
  '202609010002_create_market_inventory_drafts.sql',
  '202609010004_add_market_cycle_inventory.sql',
  '202609080002_fix_market_initial_inventory_balance_duplication.sql',
  '202609080003_add_market_inventory_counted_reason.sql',
]) await db.exec(sqlFile(name))

const query = async (sql, params = []) => (await db.query(sql, params)).rows
const item = (productId, quantity, over = {}) => ({ productId, quantity, isCounted: true, reasonCode: null, reasonNote: null, ...over })
const save = (store, sessionId, version, items) => query(
  'select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
  [store, sessionId, version, '2026-02-01T10:00:00Z', JSON.stringify(items)],
).then((r) => r[0].result)
const finalize = (sessionId, version) => query('select market_finalize_inventory_draft($1,$2) as result', [sessionId, version]).then((r) => r[0].result)
const getDraft = (store) => query('select market_get_inventory_draft($1,$2) as result', [account, store]).then((r) => r[0].result)

let sessionId, sessionVersion
test('cenário A: item is_counted=false bloqueia a finalização (regra 3, mesmo com outros itens válidos)', async () => {
  const saved = await save(storeCycle, null, null, [
    item(pB, 30), item(pC, 27, { reasonCode: 'DAMAGE' }), item(pD, 0, { isCounted: false }),
  ])
  sessionId = saved.id; sessionVersion = saved.version
  const uncounted = saved.items.find((i) => i.productId === pD)
  assert.equal(uncounted.isCounted, false)
  assert.equal(uncounted.quantity, 0) // quantity continua NOT NULL — nunca null
  await assert.rejects(finalize(sessionId, sessionVersion), /INVENTORY_UNCOUNTED_ITEMS/)
})

test('cenário J: item não contado sobrevive ao "salvar e sair" e à retomada', async () => {
  const draft = await getDraft(storeCycle)
  const uncounted = draft.items.find((i) => i.productId === pD)
  assert.ok(uncounted, 'item não contado deve continuar persistido no draft')
  assert.equal(uncounted.isCounted, false)
  const countedC = draft.items.find((i) => i.productId === pC)
  assert.equal(countedC.isCounted, true); assert.equal(Number(countedC.quantity), 27); assert.equal(countedC.reasonCode, 'DAMAGE')
})

test('cenários B/C/D/E/F/H/I: agora conto pD (o único ainda não contado) e cubro os demais motivos', async () => {
  const saved = await save(storeCycle, sessionId, sessionVersion, [
    item(pB, 30),                                                      // B: diferença 0
    item(pC, 27, { reasonCode: 'DAMAGE' }),                            // C: OUT 3, com motivo
    item(pD, 33, { reasonCode: 'UNREGISTERED_PURCHASE' }),             // D: IN 3, com motivo
    item(pE, 0, { reasonCode: 'EXPIRED_LOSS' }),                       // E: contado como zero, OUT 30, com motivo
    item(pF, 5, { reasonCode: 'OTHER', reasonNote: 'Achado em outra prateleira' }), // F: saldo conhecido 0, IN 5, OTHER com nota (I)
    item(pG, 10),                                                      // G: saldo não registrado, sem motivo
  ])
  sessionId = saved.id; sessionVersion = saved.version
  assert.equal(saved.items.length, 6)
})

test('cenário H: reason_code=OTHER sem reason_note bloqueia a finalização', async () => {
  const saved = await save(storeCycle, sessionId, sessionVersion, [
    item(pB, 30), item(pC, 27, { reasonCode: 'DAMAGE' }), item(pD, 33, { reasonCode: 'UNREGISTERED_PURCHASE' }),
    item(pE, 0, { reasonCode: 'EXPIRED_LOSS' }), item(pF, 5, { reasonCode: 'OTHER', reasonNote: '   ' }), item(pG, 10),
  ])
  sessionId = saved.id; sessionVersion = saved.version
  await assert.rejects(finalize(sessionId, sessionVersion), /INVENTORY_REASON_REQUIRED/)
})

test('B/C/D/E/F/G/I: finalização com motivo em todos os itens divergentes gera exatamente os movimentos esperados', async () => {
  const saved = await save(storeCycle, sessionId, sessionVersion, [
    item(pB, 30),
    item(pC, 27, { reasonCode: 'DAMAGE' }),
    item(pD, 33, { reasonCode: 'UNREGISTERED_PURCHASE' }),
    item(pE, 0, { reasonCode: 'EXPIRED_LOSS' }),
    item(pF, 5, { reasonCode: 'OTHER', reasonNote: 'Achado em outra prateleira' }),
    item(pG, 10),
  ])
  sessionId = saved.id; sessionVersion = saved.version
  const result = await finalize(sessionId, sessionVersion)
  assert.equal(result.inventoryType, 'cycle')

  const movements = await query(
    `select product_id, movement_type, direction, quantity, notes from market_stock_movements
     where market_account_id=$1 and market_store_id=$2 and reference_type='INVENTORY_SESSION' and reference_id=$3
     order by product_id`,
    [account, storeCycle, sessionId],
  )
  const byProduct = Object.fromEntries(movements.map((m) => [m.product_id, m]))

  assert.equal(byProduct[pB], undefined, 'cenário B: diferença 0 não gera movimento, não exige motivo')

  assert.equal(byProduct[pC].movement_type, 'ADJUSTMENT_OUT'); assert.equal(Number(byProduct[pC].quantity), 3)
  assert.match(byProduct[pC].notes, /quebra \/ avaria/i)

  assert.equal(byProduct[pD].movement_type, 'ADJUSTMENT_IN'); assert.equal(Number(byProduct[pD].quantity), 3)
  assert.match(byProduct[pD].notes, /compra \/ nota não registrada/i)

  assert.equal(byProduct[pE].movement_type, 'ADJUSTMENT_OUT'); assert.equal(Number(byProduct[pE].quantity), 30)
  assert.match(byProduct[pE].notes, /perda \/ produto vencido/i)

  assert.equal(byProduct[pF].movement_type, 'ADJUSTMENT_IN'); assert.equal(Number(byProduct[pF].quantity), 5)
  assert.match(byProduct[pF].notes, /outro — Achado em outra prateleira/)

  // cenário G, dentro de uma sessão 'cycle': a lógica de reconciliação já
  // homologada do cycle sempre usa ADJUSTMENT_IN/OUT (mesmo para produto sem
  // nenhum movimento anterior — LEFT JOIN + coalesce(0), regra pré-existente,
  // não tocada por esta tarefa). "INVENTORY" só se aplica ao sub-caminho de
  // produto novo dentro de uma sessão 'initial' (202609080002) — sem motivo,
  // que é justamente o ponto do cenário G: não exige motivo em nenhum dos dois casos.
  assert.equal(byProduct[pG].movement_type, 'ADJUSTMENT_IN')
  assert.equal(byProduct[pG].direction, 'IN'); assert.equal(Number(byProduct[pG].quantity), 10)
  assert.doesNotMatch(byProduct[pG].notes, /Inventário:/, 'sem motivo — notes permanece o texto padrão do ajuste, sem rótulo de motivo')

  const balances = await query('select product_id, quantity_on_hand from market_stock_balance where market_account_id=$1 and market_store_id=$2', [account, storeCycle])
  const balanceByProduct = Object.fromEntries(balances.map((r) => [r.product_id, Number(r.quantity_on_hand)]))
  assert.equal(balanceByProduct[pB], 30); assert.equal(balanceByProduct[pC], 27); assert.equal(balanceByProduct[pD], 33)
  assert.equal(balanceByProduct[pE], 0); assert.equal(balanceByProduct[pF], 5); assert.equal(balanceByProduct[pG], 10)
})

test('Galpão (sessão "initial" com saldo já existente): motivo também é exigido — nunca decidido por inventoryType', async () => {
  const saved = await save(storeInitial, null, null, [item(pGalak, 60)]) // saldo 64, contagem 60 -> diferença -4
  assert.equal(saved.inventoryType, 'initial')
  await assert.rejects(finalize(saved.id, saved.version), /INVENTORY_REASON_REQUIRED/, 'initial com saldo conhecido divergente também exige motivo')

  const withReason = await save(storeInitial, saved.id, saved.version, [item(pGalak, 60, { reasonCode: 'PREVIOUS_COUNT_ERROR' })])
  const result = await finalize(withReason.id, withReason.version)
  assert.equal(result.inventoryType, 'initial')

  const movement = (await query(
    `select movement_type, direction, quantity, notes from market_stock_movements
     where market_account_id=$1 and market_store_id=$2 and reference_type='INVENTORY_SESSION' and reference_id=$3`,
    [account, storeInitial, withReason.id],
  ))[0]
  assert.equal(movement.movement_type, 'ADJUSTMENT_OUT'); assert.equal(Number(movement.quantity), 4)
  assert.match(movement.notes, /contagem anterior incorreta/i)

  const balance = (await query('select quantity_on_hand from market_stock_balance where market_account_id=$1 and market_store_id=$2 and product_id=$3', [account, storeInitial, pGalak]))[0]
  assert.equal(Number(balance.quantity_on_hand), 60) // não duplicou (202609080002 continua valendo)

  const storeRow = (await query('select stock_control_started_at from market_stores where id=$1', [storeInitial]))[0]
  assert.ok(storeRow.stock_control_started_at)
  await db.close()
})
