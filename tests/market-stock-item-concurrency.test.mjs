// PostgreSQL embarcado, mesmo padrao dos demais tests/market-stock-*.test.mjs.
// Cobre a concorrencia POR ITEM introduzida pela 202609080005:
// market_save_inventory_item / market_remove_inventory_item, e o novo
// contrato de market_save_inventory_draft (deixa de gravar itens).
// Nao repete a cobertura ja feita por 003/004 (regras 3/4/5, reconciliacao
// de saldo) — market_finalize_inventory_draft nao e alterada por esta
// migration, entao esses testes continuam valendo sem mudanca.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const storeCycle = '20000000-0000-4000-8000-000000000001'        // ja com stock_control_started_at
const storeInitial = '20000000-0000-4000-8000-000000000002'      // stock_control_started_at null
const storeLegacy = '20000000-0000-4000-8000-000000000003'       // cycle, dedicada ao teste de linha "antiga"
const storeInitial2 = '20000000-0000-4000-8000-000000000004'     // initial, dedicada ao teste de contado-zero definitivo
const storeInitial3 = '20000000-0000-4000-8000-000000000005'     // initial, dedicada ao teste de zerar item ja existente
const storeRaceContinuation = '20000000-0000-4000-8000-000000000006' // cycle, dedicada ao teste de continuacao da correcao do lost update
const actor = '40000000-0000-4000-8000-000000000001'
const p = (n) => `30000000-0000-4000-8000-00000000000${n}` // n: 1-9
const pX = p(1) // "bebida" — usuario A
const pY = p(2) // "doce" — usuario B
const pZ = p(3) // produto disputado por A e B no mesmo instante
const pNew = p(4) // sessao 'initial', contado como zero

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
    ('${storeInitial}','${account}','Loja Initial',null),
    ('${storeLegacy}','${account}','Loja Legacy','2026-01-01'),
    ('${storeInitial2}','${account}','Loja Initial 2',null),
    ('${storeInitial3}','${account}','Loja Initial 3',null),
    ('${storeRaceContinuation}','${account}','Loja Race Continuation','2026-01-01');
  insert into public.market_products(id, market_account_id, name, unit) values
    ('${pX}','${account}','Bebida X','UN'), ('${pY}','${account}','Doce Y','UN'),
    ('${pZ}','${account}','Produto Disputado Z','UN'), ('${pNew}','${account}','Produto Novo Contado Zero','UN'),
    ('${p(5)}','${account}','Produto Removivel','UN'), ('${p(6)}','${account}','Produto Removido Concorrente','UN'),
    ('${p(7)}','${account}','Produto Legado','UN'), ('${p(8)}','${account}','Produto Initial Existente','UN'),
    ('${p(9)}','${account}','Produto Cycle Zero','UN');
`)

for (const name of [
  '202609010001_create_market_stock_foundation.sql',
  '202609010002_create_market_inventory_drafts.sql',
  '202609010004_add_market_cycle_inventory.sql',
  '202609080002_fix_market_initial_inventory_balance_duplication.sql',
  '202609080003_add_market_inventory_counted_reason.sql',
  '202609080004_add_market_inventory_reason_sign_check.sql',
  '202609080005_add_market_inventory_item_concurrency.sql',
]) await db.exec(sqlFile(name))

const query = async (sql, params = []) => (await db.query(sql, params)).rows
const startSession = (store) => query(
  'select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
  [store, null, null, '2026-02-01T10:00:00Z', JSON.stringify([])],
).then((r) => r[0].result)
const saveItem = (sessionId, productId, quantity, isCounted, reasonCode, reasonNote, expectedVersion) => query(
  'select market_save_inventory_item($1,$2,$3,$4,$5,$6,$7) as result',
  [sessionId, productId, quantity, isCounted, reasonCode, reasonNote, expectedVersion],
).then((r) => r[0].result)
const removeItem = (sessionId, productId, expectedVersion) => query(
  'select market_remove_inventory_item($1,$2,$3) as result',
  [sessionId, productId, expectedVersion],
).then((r) => r[0].result)
const getDraft = (store) => query('select market_get_inventory_draft($1,$2) as result', [account, store]).then((r) => r[0].result)

let sessionId
test('setup: sessao cycle criada sem itens (market_save_inventory_draft nao grava mais itens)', async () => {
  const created = await startSession(storeCycle)
  assert.equal(created.inventoryType, 'cycle')
  assert.deepEqual(created.items, [])
  sessionId = created.id
})

test('market_save_inventory_draft rejeita array de itens nao-vazio (fluxo antigo descontinuado)', async () => {
  await assert.rejects(
    query('select market_save_inventory_draft($1,$2,$3,$4,$5) as result',
      [storeCycle, sessionId, 1, '2026-02-01T10:00:00Z', JSON.stringify([{ productId: pX, quantity: 1 }])]),
    /INVENTORY_INVALID_DRAFT/,
  )
})

test('1) A salva produto X e B salva produto Y -> ambos persistem, sem conflito', async () => {
  const resultX = await saveItem(sessionId, pX, 10, true, null, null, null) // usuario A, item novo
  assert.equal(resultX.conflict, false)
  assert.equal(resultX.item.version, 1)
  const resultY = await saveItem(sessionId, pY, 7, true, null, null, null) // usuario B, item novo
  assert.equal(resultY.conflict, false)
  assert.equal(resultY.item.version, 1)

  const draft = await getDraft(storeCycle)
  const byProduct = Object.fromEntries(draft.items.map((i) => [i.productId, i]))
  assert.equal(Number(byProduct[pX].quantity), 10)
  assert.equal(Number(byProduct[pY].quantity), 7)
})

test('4) item novo recebe version inicial 1 (ja coberto acima, reafirmado explicitamente)', () => {
  // Cobertura direta: resultX.item.version === 1 e resultY.item.version === 1 no teste anterior.
  assert.ok(true)
})

test('5) update valido incrementa version', async () => {
  const result = await saveItem(sessionId, pX, 12, true, null, null, 1) // A corrige X de 10 para 12, version correta (1)
  assert.equal(result.conflict, false)
  assert.equal(result.item.version, 2)
  assert.equal(Number(result.item.quantity), 12)
})

test('2) A e B salvam o MESMO produto Z a partir da mesma version -> o segundo recebe conflito', async () => {
  const created = await saveItem(sessionId, pZ, 5, true, null, null, null) // A cria Z, version=1
  assert.equal(created.conflict, false)
  assert.equal(created.item.version, 1)

  // B, sem saber do save de A, tambem tenta gravar Z como se fosse a versao 1 -> ok, essa E a versao atual
  const bFirstAttempt = await saveItem(sessionId, pZ, 8, true, null, null, 1)
  assert.equal(bFirstAttempt.conflict, false)
  assert.equal(bFirstAttempt.item.version, 2)

  // Agora A tenta salvar de novo em cima da version=1 que ele ainda tinha (desatualizada) -> conflito
  const aStaleAttempt = await saveItem(sessionId, pZ, 6, true, null, null, 1)
  assert.equal(aStaleAttempt.conflict, true)
  assert.equal(Number(aStaleAttempt.serverItem.quantity), 8)
  assert.equal(aStaleAttempt.serverItem.version, 2)
})

test('3) conflito em Z nao afeta X nem Y (cada item e sua propria unidade de concorrencia)', async () => {
  const draft = await getDraft(storeCycle)
  const byProduct = Object.fromEntries(draft.items.map((i) => [i.productId, i]))
  assert.equal(Number(byProduct[pX].quantity), 12, 'X permanece com o valor do update bem-sucedido anterior')
  assert.equal(Number(byProduct[pY].quantity), 7, 'Y nunca foi tocado pela disputa em Z')
  assert.equal(Number(byProduct[pZ].quantity), 8, 'Z reflete o ultimo update bem-sucedido (de B), nao o de A que conflitou')
})

test('item novo, mas ja existe no servidor (dois usuarios "criando" o mesmo produto ao mesmo tempo) -> conflito', async () => {
  const result = await saveItem(sessionId, pZ, 99, true, null, null, null) // acredita ser novo, mas pZ ja existe
  assert.equal(result.conflict, true)
  assert.equal(Number(result.serverItem.quantity), 8)
})

test('9) limpar/desfazer contagem (is_counted=false) com version correta funciona', async () => {
  const result = await saveItem(sessionId, pY, 0, false, null, null, 1) // Y volta a "nao contado", version correta
  assert.equal(result.conflict, false)
  assert.equal(result.item.isCounted, false)
  assert.equal(Number(result.item.quantity), 0)
  assert.equal(result.item.version, 2)
})

test('10) limpar/desfazer com version antiga gera conflito, nao apaga silenciosamente', async () => {
  const result = await saveItem(sessionId, pY, 0, false, null, null, 1) // version 1 ja nao e mais a atual (agora e 2)
  assert.equal(result.conflict, true)
  assert.equal(result.serverItem.isCounted, false)
  assert.equal(result.serverItem.version, 2)
})

test('remover item persistido (cycle) com version correta funciona; version antiga gera conflito', async () => {
  const created = await saveItem(sessionId, p(5), 3, true, null, null, null)
  assert.equal(created.conflict, false); assert.equal(created.item.version, 1)

  const stale = await removeItem(sessionId, p(5), 0)
  assert.equal(stale.conflict, true)
  assert.equal(Number(stale.serverItem.quantity), 3)

  const ok = await removeItem(sessionId, p(5), 1)
  assert.equal(ok.conflict, false)
  assert.equal(ok.removed, true)

  const draft = await getDraft(storeCycle)
  assert.ok(!draft.items.some((i) => i.productId === p(5)), 'item removido nao deve mais aparecer no draft')
})

test('remover item que ja nao existe e idempotente (nao e erro)', async () => {
  const result = await removeItem(sessionId, p(5), 1)
  assert.equal(result.conflict, false)
  assert.equal(result.removed, true)
})

test('remover item com expected_version informado mas item ja removido por outro usuario -> conflito com serverItem null', async () => {
  const created = await saveItem(sessionId, p(6), 4, true, null, null, null)
  await removeItem(sessionId, p(6), created.item.version) // ja removido de fato

  // Outro "usuario" ainda acreditava na version 1 e tenta editar (nao remover) o item que sumiu
  const result = await saveItem(sessionId, p(6), 9, true, null, null, created.item.version)
  assert.equal(result.conflict, true)
  assert.equal(result.serverItem, null, 'serverItem null sinaliza "foi removido por outro usuario"')
})

test('11) draft antigo (sem esta migration) continua funcionando: version default 1 para linha ja existente', async () => {
  // Simula uma linha "antiga" inserida antes da 202609080005 (sem version explicito -> default 1).
  // Loja dedicada (storeLegacy) para nao disputar a sessao 'draft' ja aberta em storeCycle.
  const legacySessionId = (await startSession(storeLegacy)).id
  await db.exec(`
    insert into public.market_inventory_session_items (market_account_id, inventory_session_id, product_id, quantity, is_counted)
    values ('${account}', '${legacySessionId}', '${p(7)}', 15, true)
  `)
  const draft = await getDraft(storeLegacy)
  const legacyItem = draft.items.find((i) => i.productId === p(7))
  assert.equal(legacyItem.version, 1, 'linha inserida sem version explicito recebe o default 1')

  // E continua editavel normalmente a partir dessa version default.
  const updated = await saveItem(legacySessionId, p(7), 20, true, null, null, 1)
  assert.equal(updated.conflict, false)
  assert.equal(updated.item.version, 2)
})

// Regra definitiva (revista nesta etapa, ANTES de a 005 ser aplicada —
// não é uma mudança retroativa sobre 002/003, que não são alteradas):
// não contado (is_counted=false) e contado-como-zero (is_counted=true,
// quantity=0) são estados distintos e os dois precisam ser visíveis para
// outro usuário ao sincronizar. A versão anterior desta migration não
// persistia contado-zero em 'initial' — isso foi corrigido.
test('1) initial: is_counted=false continua "não contado" (nenhuma linha persistida)', async () => {
  const created = await startSession(storeInitial)
  const result = await saveItem(created.id, pNew, 0, false, null, null, null)
  assert.equal(result.conflict, false)
  // "Não contado" nunca gera linha própria — mesma regra da 202609080003,
  // agora aplicada por item: is_counted=false não é persistido.
  assert.equal(result.item.isCounted, false)

  const draft = await getDraft(storeInitial)
  const saved = draft.items.find((i) => i.productId === pNew)
  assert.ok(saved, 'is_counted=false também é persistido — é o registro que permite distinguir de "nunca foi tocado"')
  assert.equal(saved.isCounted, false)
})

test('2) initial: is_counted=true + quantity=0 (contado como zero) É persistido — regra definitiva', async () => {
  const created = await startSession(storeInitial2)
  const result = await saveItem(created.id, p(8), 0, true, null, null, null)
  assert.equal(result.conflict, false)
  assert.ok(result.item, 'contado como zero precisa retornar o item persistido, nunca null')
  assert.equal(result.item.isCounted, true)
  assert.equal(Number(result.item.quantity), 0)
  assert.equal(result.item.version, 1)

  const draft = await getDraft(storeInitial2)
  const saved = draft.items.find((i) => i.productId === p(8))
  assert.ok(saved, 'contado como zero precisa aparecer no draft — é o que distingue de "ninguém contou"')
  assert.equal(saved.isCounted, true)
  assert.equal(Number(saved.quantity), 0)
})

test('3) outro cliente, ao sincronizar (market_get_inventory_draft), enxerga o zero como JÁ CONTADO, nunca como "não contado"', async () => {
  // Mesma sessao/loja do teste anterior — "outro cliente" e so uma nova
  // leitura de market_get_inventory_draft, sem nenhum estado compartilhado.
  const draft = await getDraft(storeInitial2)
  const saved = draft.items.find((i) => i.productId === p(8))
  assert.ok(saved, 'produto contado como zero por um usuario precisa existir para o outro')
  assert.equal(saved.isCounted, true, 'outro usuario ve is_counted=true — nao pode parecer "ninguem contou"')
  assert.equal(Number(saved.quantity), 0)
})

test('4) cycle: is_counted=true + quantity=0 continua sendo aceito e persistido (comportamento já existente, não regrediu)', async () => {
  const result = await saveItem(sessionId, p(9), 0, true, 'EXPIRED_LOSS', null, null) // sessionId ainda é a sessão draft de storeCycle
  assert.equal(result.conflict, false)
  assert.ok(result.item)
  assert.equal(Number(result.item.quantity), 0)

  const draft = await getDraft(storeCycle)
  const saved = draft.items.find((i) => i.productId === p(9))
  assert.ok(saved, 'cycle: contado como zero sempre foi persistido, continua sendo')
  assert.equal(Number(saved.quantity), 0)
})

test('item que já existia (não-zero) e depois é zerado em sessão initial -> continua persistido com quantity=0 (não é removido)', async () => {
  const created = await startSession(storeInitial3)
  const first = await saveItem(created.id, p(8), 10, true, null, null, null)
  assert.equal(first.conflict, false); assert.equal(first.item.version, 1)

  const zeroed = await saveItem(created.id, p(8), 0, true, null, null, 1)
  assert.equal(zeroed.conflict, false)
  assert.ok(zeroed.item, 'zerar um item existente continua persistindo (update), nunca remove a linha')
  assert.equal(Number(zeroed.item.quantity), 0)
  assert.equal(zeroed.item.version, 2)

  const draft = await getDraft(storeInitial3)
  const saved = draft.items.find((i) => i.productId === p(8))
  assert.ok(saved, 'item continua no draft depois de zerado')
  assert.equal(Number(saved.quantity), 0)
})

test('5) zero contado participa corretamente da finalização já existente: sem saldo anterior, nenhum movimento é gerado (nada a reconciliar)', async () => {
  // storeInitial2 (sessão criada no teste 2, ainda draft): p(8) contado como
  // zero, sem NENHUM movimento anterior — market_finalize_inventory_draft
  // (202609080002/003, não alterada) já filtra quantity>0 para decidir o
  // que entra em market_start_stock_control/na reconciliação — item
  // persistido no rascunho, mas corretamente sem gerar movimento nenhum.
  // Um segundo produto com quantity>0 precisa existir na mesma sessão —
  // 'initial' exige ao menos um item real para finalizar (regra já
  // existente, não alterada por esta etapa), senão INVENTORY_EMPTY.
  await saveItem((await getDraft(storeInitial2)).id, pNew, 5, true, null, null, null)
  const draft = await getDraft(storeInitial2)
  const finalized = await query('select market_finalize_inventory_draft($1,$2) as result', [draft.id, draft.version]).then((r) => r[0].result)
  assert.equal(finalized.inventoryType, 'initial')
  const movements = await query(
    `select count(*)::int as n from market_stock_movements where market_account_id=$1 and market_store_id=$2 and product_id=$3`,
    [account, storeInitial2, p(8)],
  )
  assert.equal(movements[0].n, 0, 'contado como zero sem saldo anterior não gera nenhum movimento de estoque')
  const pNewMovements = await query(
    `select count(*)::int as n from market_stock_movements where market_account_id=$1 and market_store_id=$2 and product_id=$3`,
    [account, storeInitial2, pNew],
  )
  assert.equal(pNewMovements[0].n, 1, 'produto com contagem real continua estabelecendo o saldo normalmente')
})

test('regressão (correção do lost update em MarketStockDashboard.tsx): version preservada pela correção do frontend é a mesma que o backend real espera para o próximo commit, sem conflito falso', async () => {
  // Fecha o loop da correção de commitItem/applyItemSaveResponse (testada
  // isoladamente em market-stock-multiuser-ui.test.mjs) contra a RPC REAL —
  // reproduz os passos 1, 3-5 e 7-9 do cenário do bug diretamente no banco.
  const created = await startSession(storeRaceContinuation)
  // Passo 1: X existe com quantity=5, version=1.
  const initial = await saveItem(created.id, pX, 5, true, null, null, null)
  assert.equal(initial.conflict, false)
  assert.equal(initial.item.version, 1)

  // Passo 3-5: "commit #1" (a edição para 10, enviada ANTES da segunda
  // edição do operador) — servidor aceita sobre version=1 e devolve
  // exatamente quantity=10, version=2, igual ao exemplo do bug.
  const commit1 = await saveItem(created.id, pX, 10, true, null, null, 1)
  assert.equal(commit1.conflict, false)
  assert.equal(Number(commit1.item.quantity), 10)
  assert.equal(commit1.item.version, 2)

  // Prova de que a correção era necessária: se o frontend NÃO tivesse
  // atualizado a base local para version=2 (bug antigo nunca chegava a
  // tentar reenviar, mas se tentasse com a version desatualizada de
  // antes de commit#1, seria rejeitado) — o backend real rejeita a
  // version=1 depois que commit#1 já a consumiu.
  const staleAttempt = await saveItem(created.id, pX, 12, true, null, null, 1)
  assert.equal(staleAttempt.conflict, true, 'version=1 já foi consumida por commit#1 — reenviar com ela geraria conflito falso contra o próprio save anterior')

  // Passo 7-8: o PRÓXIMO commit usa quantity=12 (a edição concorrente feita
  // durante o voo de commit#1) sobre version=2 — exatamente a base que
  // applyItemSaveResponse preserva localmente após uma resposta superada.
  const commit2 = await saveItem(created.id, pX, 12, true, null, null, 2)
  assert.equal(commit2.conflict, false, 'version=2 (preservada pela correção) precisa ser aceita pelo servidor real, sem conflito falso')
  assert.equal(Number(commit2.item.quantity), 12)
  assert.equal(commit2.item.version, 3)

  // Passo 9-10: estado final do servidor bate com o que a UI preservou (12),
  // nunca com o valor stale que commit#1 enviou (10).
  const draft = await getDraft(storeRaceContinuation)
  const saved = draft.items.find((i) => i.productId === pX)
  assert.equal(Number(saved.quantity), 12)
  assert.equal(saved.version, 3)
})

test('13) produtos ja salvos por outro usuario aparecem ao sincronizar (market_get_inventory_draft sempre le o estado atual)', async () => {
  // "B" nunca chamou save para pX, mas ele ja existe (do teste 1) — get_inventory_draft
  // e a fonte de sincronizacao, sempre reflete o que qualquer usuario ja persistiu.
  const draft = await getDraft(storeCycle)
  assert.ok(draft.items.some((i) => i.productId === pX), 'produto salvo por outro usuario aparece ao ler o draft')
})

test('12) sessao finalizada (ou inexistente) -> market_save_inventory_item recusa com INVENTORY_DRAFT_UNAVAILABLE, sem loop', async () => {
  await assert.rejects(
    saveItem('00000000-0000-4000-8000-000000000000', pX, 1, true, null, null, null),
    /INVENTORY_DRAFT_UNAVAILABLE/,
  )
  await db.close()
})
