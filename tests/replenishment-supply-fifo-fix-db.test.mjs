// Teste focado da correcao do bloqueio indevido de FIFO no Abastecer
// (202609150005_fix_replenishment_supply_fifo.sql): quando ha saldo de
// Galpao suficiente para atender duas (ou mais) allocations do mesmo
// produto, a mais nova pode ser abastecida antes da mais antiga -- a fila
// (market_replenishment_supply_queue_internal) ja garante que isso nunca
// consome saldo acima do disponivel.
//
// 202609150003 e 202609150004 ja foram aplicadas em homologacao e sao
// imutaveis -- este teste empilha as duas tal como estao e por cima a
// 202609150005, exatamente como sera aplicado em producao.
//
// Reusa o fixture de replenishment-order-contract-db (schema + dados +
// generate/reject/contractTest) e as mesmas migrations que os demais testes
// de reposicao ja usam para ter compra + NF + abastecimento funcionando de
// ponta a ponta.
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const fixtureUrl = new URL('./replenishment-order-contract-db.test.mjs', import.meta.url)
let setup = readFileSync(fixtureUrl, 'utf8').split("\ntest('materializacao")[0]
setup = setup.replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href))
  .replace(/from '(\.\.[^']+)'/g, (_match, path) => `from '${new URL(path, fixtureUrl).href}'`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,account,warehouseA,warehouseB,storeA,storeB,storeC,productA,request,reject,contractTest};').toString('base64')}`)
const { db, query, generate, account, warehouseA, warehouseB, storeA, storeB, storeC, productA, request, reject, contractTest } = fixture

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
await db.exec(sqlFile('202609130002_replenishment_purchase_tracking.sql'))
await db.exec(sqlFile('202609130003_replenishment_atomic_store_supply.sql'))
await db.exec(sqlFile('202609130004_fix_replenishment_active_order_reuse.sql'))
await db.exec(sqlFile('202609140004_integrate_replenishment_purchase_progress.sql'))
await db.exec(`alter table market_purchase_items add column conversion_factor numeric,add column reviewed_at timestamptz,add column reviewed_by uuid,add column received_by uuid;
 alter table market_stock_movements add column notes text,add column created_by uuid;
 create unique index receipt_test_source on market_stock_movements(market_account_id,movement_type,reference_type,reference_id,reference_item_id)
 where reference_type is not null and reference_id is not null and reference_item_id is not null;
 create or replace function market_has_role(p_account uuid,p_roles text[]) returns boolean language sql as $$
 select exists(select 1 from market_account_members where market_account_id=p_account and user_id=auth.uid() and role=any(p_roles) and status='active') $$;
 create or replace function market_is_accesys_current_product(p_account uuid,p_product uuid) returns boolean language sql as $$
 select exists(select 1 from market_products where id=p_product and market_account_id=p_account and status='active') $$;`)
await db.exec(sqlFile('202609140005_replenishment_post_purchase.sql'))
await db.exec(sqlFile('202609150002_add_replenishment_order_history_rpc.sql'))
await db.exec(sqlFile('202609150003_replenishment_progressive_store_release.sql'))
await db.exec(sqlFile('202609150004_fix_replenishment_supply_source.sql'))
await db.exec(sqlFile('202609150005_fix_replenishment_supply_fifo.sql'))

const release = (orderId, storeId, req = request()) =>
  query('select market_release_replenishment_order_store($1,$2,$3,$4) id', [account, orderId, storeId, req]).then((rows) => rows[0].id)
const review = (orderId, allocationId, warehouse, purchase) =>
  query('select market_update_replenishment_allocation_review($1,$2,$3,$4,$5)', [account, orderId, allocationId, warehouse, purchase])
const allocationsOf = (orderId, storeId) => query(
  `select a.*,i.product_id,i.warehouse_stock_snapshot from market_replenishment_order_allocations a
   join market_replenishment_order_items i on i.id=a.order_item_id
   where i.order_id=$1 and a.store_id=$2 and a.status<>'cancelled' and i.status<>'cancelled'`,
  [orderId, storeId],
)
const supplyQueue = (orderId, productId) => query(
  'select * from market_replenishment_supply_queue_internal($1) q where q.order_id=$2 and q.product_id=$3',
  [account, orderId, productId],
)
const executeSupply = (orderId, allocationId, operationLineId, sourceStoreId, quantity, req = request()) =>
  query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data', [account, orderId, allocationId, operationLineId, sourceStoreId, quantity, req])
const warehouseBalance = (storeId, productId) => query(
  "select coalesce(sum(case when direction='IN' then quantity else -quantity end),0)::numeric bal from market_stock_movements where market_account_id=$1 and market_store_id=$2 and product_id=$3",
  [account, storeId, productId],
).then((rows) => Number(rows[0].bal))

contractTest('Galpao=10, Loja A liberada primeiro precisa 1, Loja B liberada depois precisa 1: Loja B pode ser abastecida antes da Loja A', async () => {
  const id = await generate()
  // Consolida o saldo fisico do produto em UM unico Galpao (warehouseA),
  // totalizando exatamente 10 -- cenario literal do smoke relatado.
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','IN',3)", [account, warehouseA, productA])

  const allocA = (await allocationsOf(id, storeA)).find((a) => a.product_id === productA) // fora do cenario
  const allocLojaA = (await allocationsOf(id, storeB)).find((a) => a.product_id === productA) // "Loja A": liberada primeiro
  const allocLojaB = (await allocationsOf(id, storeC)).find((a) => a.product_id === productA) // "Loja B": liberada depois

  await review(id, allocA.id, 0, 8)
  await review(id, allocLojaA.id, 1, 5) // necessidade 6, Do Galpao=1
  await review(id, allocLojaB.id, 1, 4) // necessidade 5, Do Galpao=1

  await release(id, storeB) // Loja A liberada primeiro
  await release(id, storeC) // Loja B liberada depois

  const queue = await supplyQueue(id, productA)
  const byStore = Object.fromEntries(queue.map((row) => [row.store_id, row]))
  assert.ok(byStore[storeB], 'Loja A (liberada primeiro) precisa aparecer como abastecivel')
  assert.ok(byStore[storeC], 'Loja B (liberada depois) tambem precisa aparecer como abastecivel -- bug real: fila via as duas, execucao bloqueava')
  assert.equal(Number(byStore[storeB].remaining), 1)
  assert.equal(Number(byStore[storeC].remaining), 1)

  const balanceBefore = await warehouseBalance(warehouseA, productA)
  assert.equal(balanceBefore, 10)

  // Executar Loja B (mais nova) PRIMEIRO precisa funcionar -- antes da
  // correcao, isso lancava REPLENISHMENT_SUPPLY_FIFO_BLOCKED.
  await executeSupply(id, allocLojaB.id, byStore[storeC].warehouse_line_id, warehouseA, 1)
  const lineLojaB = (await query('select confirmed_quantity,completed_at from market_replenishment_operation_lines where id=$1', [byStore[storeC].warehouse_line_id]))[0]
  assert.equal(Number(lineLojaB.confirmed_quantity), 1)
  assert.ok(lineLojaB.completed_at)

  // Depois, executar Loja A (mais antiga, ainda pendente) tambem precisa
  // funcionar normalmente.
  await executeSupply(id, allocLojaA.id, byStore[storeB].warehouse_line_id, warehouseA, 1)
  const lineLojaA = (await query('select confirmed_quantity,completed_at from market_replenishment_operation_lines where id=$1', [byStore[storeB].warehouse_line_id]))[0]
  assert.equal(Number(lineLojaA.confirmed_quantity), 1)
  assert.ok(lineLojaA.completed_at)

  // Saldo final = 10 - 1 - 1 = 8; nunca ficou negativo em nenhum momento.
  const balanceAfter = await warehouseBalance(warehouseA, productA)
  assert.equal(balanceAfter, 8)

  const queueAfter = await supplyQueue(id, productA)
  assert.equal(queueAfter.length, 0, 'ambas as allocations saem da fila apos totalmente abastecidas')
})

contractTest('saldo insuficiente para as duas allocations do produto continua bloqueando a que nao cabe', async () => {
  const id = await generate()
  // Drena o saldo fisico de productA para exatamente 1 unidade no total
  // (warehouseA e warehouseB), insuficiente para as duas necessidades de 1.
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','OUT',6)", [account, warehouseA, productA])
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','OUT',3)", [account, warehouseB, productA])
  assert.equal(await warehouseBalance(warehouseA, productA), 1)
  assert.equal(await warehouseBalance(warehouseB, productA), 0)

  const allocA = (await allocationsOf(id, storeA)).find((a) => a.product_id === productA)
  const allocB = (await allocationsOf(id, storeB)).find((a) => a.product_id === productA)
  const allocC = (await allocationsOf(id, storeC)).find((a) => a.product_id === productA)

  await review(id, allocA.id, 0, 8)
  await review(id, allocB.id, 1, 5)
  await review(id, allocC.id, 1, 4)
  await release(id, storeB)
  await release(id, storeC)

  const queue = await supplyQueue(id, productA)
  assert.equal(queue.length, 1, 'com saldo para so uma das duas, a fila so pode apresentar uma como pronta')
  const readyStoreId = queue[0].store_id
  const readyAlloc = readyStoreId === storeB ? allocB : allocC
  const blockedAlloc = readyStoreId === storeB ? allocC : allocB
  const warehouseLineOf = (allocationId) => query(
    "select id from market_replenishment_operation_lines where allocation_id=$1 and operation_type='warehouse'",
    [allocationId],
  ).then((rows) => rows[0]?.id ?? null)

  // A allocation que a fila NAO apresenta como pronta continua bloqueada
  // por chamada direta -- protecao contra consumir acima do disponivel.
  const blockedWarehouseLineId = await warehouseLineOf(blockedAlloc.id)
  await reject(() => executeSupply(id, blockedAlloc.id, blockedWarehouseLineId, warehouseA, 1), /REPLENISHMENT_SUPPLY_FIFO_BLOCKED/)

  // A que a fila apresenta como pronta continua funcionando normalmente.
  await executeSupply(id, readyAlloc.id, queue[0].warehouse_line_id, warehouseA, 1)
  assert.equal(await warehouseBalance(warehouseA, productA), 0, 'saldo nunca fica negativo')

  const queueAfter = await supplyQueue(id, productA)
  assert.equal(queueAfter.length, 0, 'sem saldo restante, a outra allocation continua fora da fila')
})
