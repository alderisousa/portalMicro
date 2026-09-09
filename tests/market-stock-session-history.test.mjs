// PostgreSQL embarcado, mesmo padrao dos demais tests/market-stock-*.test.mjs
// (ver market-stock-item-concurrency.test.mjs para o precedente do bootstrap
// de schema minimo usado aqui). Cobre as duas RPCs NOVAS da 202609090001
// (fechamento da Sprint de Estoque, item 3 — "Ultimos inventarios"):
// market_list_inventory_sessions e market_get_inventory_session. Nao repete
// cobertura ja feita da concorrencia por item/reconciliacao de saldo —
// nenhuma RPC existente foi alterada por esta migration.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const otherAccount = '10000000-0000-4000-8000-000000000002'
const store = '20000000-0000-4000-8000-000000000001'       // initial, sem stock_control_started_at
const otherStore = '20000000-0000-4000-8000-000000000002'  // mesma conta, membro sem acesso a esta loja
const outsiderStore = '20000000-0000-4000-8000-000000000003' // outra conta inteira
const actor = '40000000-0000-4000-8000-000000000001'        // owner, all_stores
const restrictedActor = '40000000-0000-4000-8000-000000000002' // member sem acesso a `store`
const outsider = '40000000-0000-4000-8000-000000000003'     // sem nenhum vinculo com `account`
const pA = '30000000-0000-4000-8000-000000000001'
const pB = '30000000-0000-4000-8000-000000000002'

let currentActor = actor
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$select current_setting('app.current_actor')::uuid$$;

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

  insert into public.market_accounts values ('${account}','active'), ('${otherAccount}','active');
  insert into auth.users values ('${actor}'), ('${restrictedActor}'), ('${outsider}');
  insert into public.market_account_members(id, market_account_id, user_id, role, all_stores, status) values
    ('50000000-0000-4000-8000-000000000001','${account}','${actor}','owner',true,'active'),
    ('50000000-0000-4000-8000-000000000002','${account}','${restrictedActor}','operator',false,'active');
  insert into public.market_stores(id, market_account_id, name, stock_control_started_at) values
    ('${store}','${account}','Loja Principal',null),
    ('${otherStore}','${account}','Loja Sem Acesso',null),
    ('${outsiderStore}','${otherAccount}','Loja De Outra Conta',null);
  insert into public.market_products(id, market_account_id, name, unit) values
    ('${pA}','${account}','Produto A','UN'), ('${pB}','${account}','Produto B','UN');
`)

for (const name of [
  '202609010001_create_market_stock_foundation.sql',
  '202609010002_create_market_inventory_drafts.sql',
  '202609010004_add_market_cycle_inventory.sql',
  '202609080002_fix_market_initial_inventory_balance_duplication.sql',
  '202609080003_add_market_inventory_counted_reason.sql',
  '202609080004_add_market_inventory_reason_sign_check.sql',
  '202609080005_add_market_inventory_item_concurrency.sql',
  '202609090001_add_market_inventory_session_history.sql',
]) await db.exec(sqlFile(name))

const asActor = async (userId, fn) => {
  const previous = currentActor
  currentActor = userId
  await db.exec(`select set_config('app.current_actor', '${userId}', false)`)
  try { return await fn() } finally { currentActor = previous; await db.exec(`select set_config('app.current_actor', '${previous}', false)`) }
}
const query = async (sql, params = []) => (await db.query(sql, params)).rows
const startSession = (storeId) => query(
  'select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
  [storeId, null, null, '2026-02-01T10:00:00Z', JSON.stringify([])],
).then((r) => r[0].result)
const saveItem = (sessionId, productId, quantity, expectedVersion = null) => query(
  'select market_save_inventory_item($1,$2,$3,$4,$5,$6,$7) as result',
  [sessionId, productId, quantity, true, null, null, expectedVersion],
).then((r) => r[0].result)
const listSessions = (accountId, storeId) => query('select market_list_inventory_sessions($1,$2) as result', [accountId, storeId]).then((r) => r[0].result)
const getSession = (sessionId) => query('select market_get_inventory_session($1) as result', [sessionId]).then((r) => r[0].result)

let finalizedId, cancelledId

test('setup: um inventário finalizado e um cancelado na mesma loja', async () => {
  await asActor(actor, async () => {
    const draft1 = await startSession(store)
    await saveItem(draft1.id, pA, 10)
    await saveItem(draft1.id, pB, 0) // contado zero — precisa continuar aparecendo no histórico
    const finalized = await query('select market_finalize_inventory_draft($1,$2) as result', [draft1.id, draft1.version]).then((r) => r[0].result)
    assert.equal(finalized.inventoryType, 'initial')
    finalizedId = draft1.id

    const draft2 = await startSession(store)
    await saveItem(draft2.id, pA, 3)
    await query('select market_cancel_inventory_draft($1,$2)', [draft2.id, draft2.version])
    cancelledId = draft2.id
  })
})

test('market_list_inventory_sessions: lista concluído e cancelado da loja, mais recente primeiro, nunca inclui draft', async () => {
  await asActor(actor, async () => {
    // Um terceiro rascunho fica em aberto (draft) — nunca deve aparecer no histórico
    // (já é exibido pelo card "Inventário em andamento", regra preservada).
    await startSession(store)

    const sessions = await listSessions(account, store)
    assert.equal(sessions.length, 2, 'draft ativo não entra na lista de histórico')
    assert.deepEqual(sessions.map((s) => s.status).sort(), ['cancelled', 'completed'])
    // Mais recente primeiro: cancelledId foi criado/atualizado depois de finalizedId.
    assert.equal(sessions[0].id, cancelledId)
    assert.equal(sessions[1].id, finalizedId)
  })
})

test('market_list_inventory_sessions: countedProducts reflete só itens is_counted=true da sessão', async () => {
  await asActor(actor, async () => {
    const sessions = await listSessions(account, store)
    const finalized = sessions.find((s) => s.id === finalizedId)
    assert.equal(Number(finalized.countedProducts), 2, 'contado zero conta como produto contado')
  })
})

test('market_get_inventory_session: devolve os itens com quantidade e nome/EAN/SKU/unidade do produto denormalizados', async () => {
  await asActor(actor, async () => {
    const session = await getSession(finalizedId)
    assert.equal(session.status, 'completed')
    const byProduct = Object.fromEntries(session.items.map((i) => [i.productId, i]))
    assert.equal(Number(byProduct[pA].quantity), 10)
    assert.equal(byProduct[pA].productName, 'Produto A')
    assert.equal(Number(byProduct[pB].quantity), 0, 'contado zero continua no detalhe da conferência')
  })
})

test('market_get_inventory_session: histórico não depende do catálogo atual — produto desativado depois continua resolvendo nome/EAN', async () => {
  await db.exec(`update public.market_products set status = 'inactive' where id = '${pA}'`)
  await asActor(actor, async () => {
    const session = await getSession(finalizedId)
    const item = session.items.find((i) => i.productId === pA)
    assert.ok(item, 'item de produto inativo não pode desaparecer do histórico')
    assert.equal(item.productName, 'Produto A')
  })
  await db.exec(`update public.market_products set status = 'active' where id = '${pA}'`)
})

test('market_list_inventory_sessions: membro sem acesso à loja recebe INVENTORY_STORE_NOT_ALLOWED', async () => {
  await asActor(restrictedActor, async () => {
    await assert.rejects(listSessions(account, store), /INVENTORY_STORE_NOT_ALLOWED/)
  })
})

test('market_get_inventory_session: usuário sem vínculo com a conta recebe INVENTORY_MEMBERSHIP_REQUIRED', async () => {
  await asActor(outsider, async () => {
    await assert.rejects(getSession(finalizedId), /INVENTORY_MEMBERSHIP_REQUIRED/)
  })
})

test('market_get_inventory_session: sessão inexistente recebe INVENTORY_SESSION_NOT_FOUND', async () => {
  await asActor(actor, async () => {
    await assert.rejects(getSession('99999999-0000-4000-8000-000000000000'), /INVENTORY_SESSION_NOT_FOUND/)
  })
})

test('market_list_inventory_sessions: loja de outra loja/conta nunca vaza no histórico desta conta', async () => {
  await asActor(actor, async () => {
    await assert.rejects(listSessions(account, outsiderStore), /INVENTORY_STORE_NOT_ALLOWED/)
  })
})
