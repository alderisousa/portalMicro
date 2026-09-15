// Teste focado da correcao Galpao x Comprar do Abastecer
// (202609150004_fix_replenishment_supply_source.sql): o saldo existente no
// Galpao nao pode alterar automaticamente a origem (Do Galpao x Comprar)
// decidida pelo operador na revisao/liberacao.
//
// 202609150003_replenishment_progressive_store_release.sql ja foi aplicada
// em homologacao e e imutavel -- este teste empilha a 0003 tal como esta
// (sem nenhuma alteracao) e por cima a 0004, exatamente como sera aplicado
// em producao.
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
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,account,warehouseA,storeA,storeB,storeC,productA,request,reject,contractTest};').toString('base64')}`)
const { db, query, generate, account, warehouseA, storeA, storeB, storeC, productA, request, reject, contractTest } = fixture

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
const supplyQueue = (orderId) => query('select * from market_replenishment_supply_queue_internal($1) q where q.order_id=$2', [account, orderId])
const storeSupply = (orderId) => query('select market_get_replenishment_store_supply($1,$2,$3) data', [account, orderId, null]).then((rows) => rows[0].data)
const purchasingOf = (orderId) => query('select market_get_replenishment_purchasing($1,$2) data', [account, orderId]).then((rows) => rows[0].data)
const historySummary = () => query('select market_get_replenishment_order_history($1,$2,$3) data', [account, null, null]).then((rows) => rows[0].data)
const historyDetail = (orderId) => query('select market_get_replenishment_order_history($1,$2,$3) data', [account, orderId, null]).then((rows) => rows[0].data)
const executeSupply = (orderId, allocationId, operationLineId, sourceStoreId, quantity, req = request()) =>
  query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data', [account, orderId, allocationId, operationLineId, sourceStoreId, quantity, req])

contractTest('cenario 1: Galpao=0/Comprar=6 com saldo fisico de Galpao=20 -> nao aparece em Abastecer', async () => {
  const id = await generate()
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','IN',20)", [account, warehouseA, productA])

  const allocA = (await allocationsOf(id, storeA)).find((a) => a.product_id === productA) // necessidade 8
  const allocB = (await allocationsOf(id, storeB)).find((a) => a.product_id === productA) // necessidade 6
  const allocC = (await allocationsOf(id, storeC)).find((a) => a.product_id === productA) // necessidade 5

  await review(id, allocA.id, 0, 8) // cenario 1: Galpao=0/Comprar=8 (bug real da Vitality: necessidade 6/10, aqui 8)
  await review(id, allocB.id, 0, 6) // outro produto/loja com Galpao=0/Comprar=6 (exemplo literal do bug)
  await review(id, allocC.id, 0, 5)

  await release(id, storeA)
  await release(id, storeB)
  await release(id, storeC)

  const queue = await supplyQueue(id)
  assert.equal(queue.length, 0, 'nenhuma allocation com Do Galpao=0 pode aparecer na fila, mesmo com saldo fisico de 20 no Galpao')

  const supply = await storeSupply(id)
  assert.equal(supply.length, 0, 'tela Abastecer precisa ficar vazia')

  // Bypass direto da RPC tambem precisa continuar bloqueado.
  await reject(() => executeSupply(id, allocB.id, null, warehouseA, 6), /REPLENISHMENT_SUPPLY_FIFO_BLOCKED/)

  // Comprar continua reportando a necessidade normalmente.
  const purchasing = await purchasingOf(id)
  const line = purchasing.find((entry) => entry.productId === productA)
  const storeBEntry = line.stores.find((s) => s.storeId === storeB)
  assert.equal(Number(storeBEntry.targetQuantity), 6)
})

contractTest('cenario 2: Galpao=6/Comprar=0 com saldo suficiente -> aparece em Abastecer com 6', async () => {
  const id = await generate()
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','IN',20)", [account, warehouseA, productA])

  const allocA = (await allocationsOf(id, storeA)).find((a) => a.product_id === productA)
  const allocB = (await allocationsOf(id, storeB)).find((a) => a.product_id === productA) // necessidade 6
  const allocC = (await allocationsOf(id, storeC)).find((a) => a.product_id === productA)

  // Zera primeiro as outras allocations do mesmo item (orcamento
  // compartilhado de warehouse_stock_snapshot=10) para depois poder setar
  // Galpao=6 em storeB sem esbarrar no split padrao da materializacao.
  await review(id, allocA.id, 0, 8)
  await review(id, allocC.id, 0, 5)
  await review(id, allocB.id, 6, 0) // cenario 2: Galpao=6/Comprar=0

  await release(id, storeA)
  await release(id, storeB)
  await release(id, storeC)

  const queue = await supplyQueue(id)
  assert.equal(queue.length, 1, 'so a allocation com decisao de Galpao entra na fila')
  assert.equal(queue[0].store_id, storeB)
  assert.equal(Number(queue[0].target), 6)
  assert.equal(Number(queue[0].remaining), 6)

  const supply = await storeSupply(id)
  assert.equal(supply.length, 1)
  assert.equal(supply[0].storeId, storeB)
  assert.equal(Number(supply[0].targetQuantity), 6)

  // Execucao completa funciona normalmente.
  await executeSupply(id, allocB.id, queue[0].warehouse_line_id, warehouseA, 6)
  const line = (await query('select confirmed_quantity,target_quantity,completed_at from market_replenishment_operation_lines where id=$1', [queue[0].warehouse_line_id]))[0]
  assert.equal(Number(line.confirmed_quantity), 6)
  assert.ok(line.completed_at)

  const queueAfter = await supplyQueue(id)
  assert.equal(queueAfter.length, 0, 'sai da fila apos totalmente abastecida')

  // Comprar continua existindo para o produto (storeA/storeC tem
  // purchase_needed>0), mas storeB (Galpao=6/Comprar=0) nao pode aparecer
  // nele -- o abastecimento da parte de Galpao nao interfere em Comprar.
  const purchasing = await purchasingOf(id)
  const purchasingLine = purchasing.find((entry) => entry.productId === productA)
  assert.ok(purchasingLine, 'productA continua em Comprar por causa de storeA/storeC')
  assert.equal(purchasingLine.stores.find((s) => s.storeId === storeB), undefined, 'storeB (Comprar=0) nao pode aparecer em Comprar')
})

contractTest('cenario 3: Historico continua enxergando a necessidade fisica TOTAL, nao so a parcela de Galpao', async () => {
  const id = await generate()

  const allocA = (await allocationsOf(id, storeA)).find((a) => a.product_id === productA) // necessidade 8
  const allocB = (await allocationsOf(id, storeB)).find((a) => a.product_id === productA) // necessidade 6
  const allocC = (await allocationsOf(id, storeC)).find((a) => a.product_id === productA) // necessidade 5

  // storeB fica com Galpao=0/Comprar=6 (necessidade total 6): mesmo sem
  // nenhuma warehouse operation_line, o Historico precisa continuar vendo
  // essa allocation como pendente com a necessidade TOTAL (6), nao com
  // warehouse_remaining=0 (que faria parecer "nada pendente").
  await review(id, allocA.id, 0, 8)
  await review(id, allocB.id, 0, 6)
  await review(id, allocC.id, 0, 5)

  await release(id, storeA)
  await release(id, storeB)
  await release(id, storeC)

  const summary = await historySummary()
  const orderSummary = summary.find((row) => row.id === id)
  assert.ok(orderSummary, 'ordem precisa aparecer no resumo do Historico')
  // A ordem tambem materializa productC/storeB (candidato independente do
  // fixture): totalItems=4 (3x productA + 1x productC), todos pendentes,
  // nenhum entregue ainda. O ponto deste teste e productA/storeB (abaixo).
  assert.equal(orderSummary.totalItems, 4)
  assert.equal(orderSummary.pendingItems, 4, 'nenhum foi entregue ainda')
  assert.equal(orderSummary.situation, 'partial')

  const detail = await historyDetail(id)
  const detailB = detail.find((row) => row.storeId === storeB)
  assert.equal(Number(detailB.targetQuantity), 6, 'detalhe do Historico continua com a necessidade TOTAL (6), nao com a parcela de Galpao (0)')
  assert.equal(detailB.status, 'pending')
})
