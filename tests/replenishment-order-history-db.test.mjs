// Teste focado da nova RPC de Historico de Reposicao
// (market_get_replenishment_order_history, 202609150002): lista de
// ordens com resumo (total/processado/pendente/situacao) e, por ordem,
// detalhe por necessidade (produto x loja) com status pending/processed.
//
// Reusa o fixture de replenishment-order-contract-db (schema + dados +
// generate/approve/reject/contractTest) no mesmo padrao ja usado por
// replenishment-purchasing-db.test.mjs, e empilha por cima as mesmas
// migrations/colunas de teste que replenishment-post-purchase-db.test.mjs
// usa para ter compra + NF + abastecimento Galpao->Loja funcionando de
// ponta a ponta -- copiadas aqui (em vez de re-fatiar aqueles arquivos,
// que ja fazem sua propria fatiagem aninhada e nao compoe com uma terceira
// camada) para manter este teste independente e focado.
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const fixtureUrl = new URL('./replenishment-order-contract-db.test.mjs', import.meta.url)
let setup = readFileSync(fixtureUrl, 'utf8').split("\ntest('materializacao")[0]
setup = setup.replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href))
  .replace(/from '(\.\.[^']+)'/g, (_match, path) => `from '${new URL(path, fixtureUrl).href}'`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,approve,account,warehouseA,storeA,request,reject,contractTest};').toString('base64')}`)
const { db, query, generate, approve, account, warehouseA, storeA, request, reject, contractTest } = fixture

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

const read = async (id) => (await query('select market_get_replenishment_purchasing($1,$2) data', [account, id]))[0].data
const save = (id, changes, req = request()) => query('select market_set_replenishment_purchased($1,$2,$3,$4)', [account, id, JSON.stringify(changes), req])
const change = (l, q) => ({ declarationId: l.id, version: l.version, quantity: q })
async function invoice(product, amount, store = warehouseA) {
  const purchase = request(), item = request()
  await query("insert into market_purchases(id,market_account_id,destination_store_id,status,invoice_key,invoice_number) values($1::uuid,$2,$3,'ready',($1::uuid)::text,'123')", [purchase, account, store])
  await query("insert into market_purchase_items(id,market_account_id,market_purchase_id,line_number,market_product_id,stock_entry_status,stock_quantity,quantity,reconciliation_status,stock_unit) values($1,$2,$3,1,$4,'pending',$5,$5,'matched_manual','UN')", [item, account, purchase, product, amount])
  return { purchase, item }
}
async function receipt(product, quantity) {
  const nf = await invoice(product, quantity)
  await query('update market_purchase_items set conversion_factor=1,stock_unit_cost=2,reviewed_at=now(),reviewed_by=auth.uid() where id=$1', [nf.item])
  await query('select market_receive_purchase_items($1,$2)', [account, nf.purchase])
  return nf
}
async function buy(id, quantity) {
  const line = (await read(id))[0]
  await save(id, [change(line, quantity)])
  return (await read(id))[0]
}
async function plan(amounts = [2, 1, 2]) {
  const id = await generate()
  const allocations = await query('select a.*,i.product_id from market_replenishment_order_allocations a join market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 order by i.product_id,a.id', [id])
  const product = allocations[0].product_id
  for (const a of allocations) await query('select market_update_replenishment_allocation_review($1,$2,$3,0,0)', [account, id, a.id])
  let index = 0
  for (const a of allocations) {
    const amount = a.product_id === product ? (amounts[index++] ?? 0) : 0
    await query('select market_update_replenishment_allocation_review($1,$2,$3,0,$4)', [account, id, a.id, amount])
  }
  await approve(id)
  return { id, product, allocations: allocations.filter((a) => a.product_id === product).slice(0, amounts.length) }
}
async function ensureWarehouseStock(product, quantity = 999) {
  await query(
    "insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id) values($1,$2,$3,'PURCHASE','IN',$4,'PURCHASE',$5,$6)",
    [account, warehouseA, product, quantity, request(), request()],
  )
}
// A entrega Galpao->Loja segue FIFO por necessidade (born/order/allocation),
// homologado em market_execute_replenishment_store_supply -- nao da para
// escolher qual allocation entregar fora dessa ordem. Entrega sempre a
// proxima da fila e devolve qual allocation foi efetivamente atendida.
async function deliverNext(orderId, product) {
  await ensureWarehouseStock(product)
  const line = (await query('select market_get_replenishment_store_supply($1,$2,null) data', [account, orderId]))[0].data[0]
  assert.ok(line, 'deveria haver uma necessidade pronta para abastecimento')
  await query(
    'select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',
    [account, orderId, line.allocationId, line.operationLineId, line.sourceStoreId, line.remainingQuantity, request()],
  )
  return line.allocationId
}
async function fullyDeliver(orderId, product, quantity) {
  await buy(orderId, quantity)
  await receipt(product, quantity)
}

const history = (orderId = null, storeId = null) =>
  query('select public.market_get_replenishment_order_history($1,$2,$3) data', [account, orderId, storeId]).then((rows) => rows[0].data)

contractTest('historico: resume ordem por total/processado/pendente e detalha status pending/processed por loja', async () => {
  // productA tem 3 allocations (storeA/storeB/storeC), 100% compradas via plan([2,1,2]).
  const { id: orderId, product, allocations } = await plan([2, 1, 2])

  const beforeList = await history()
  const beforeOrder = beforeList.find((entry) => entry.id === orderId)
  assert.ok(beforeOrder, 'ordem recem aprovada com necessidade real precisa aparecer no historico')
  assert.equal(beforeOrder.totalItems, 3)
  assert.equal(beforeOrder.processedItems, 0)
  assert.equal(beforeOrder.pendingItems, 3)
  assert.equal(beforeOrder.situation, 'partial')

  const beforeDetail = await history(orderId)
  assert.equal(beforeDetail.length, 3)
  assert.ok(beforeDetail.every((item) => item.status === 'pending'))
  assert.ok(beforeDetail.every((item) => Number(item.deliveredQuantity) === 0))

  // Compra tudo e recebe via NF (evidencia fisica no Galpao), mas AINDA nao entrega a nenhuma loja:
  // por definicao funcional, "comprado" sozinho nao e suficiente para virar PROCESSADO.
  await fullyDeliver(orderId, product, 5)
  const afterBuyDetail = await history(orderId)
  assert.ok(afterBuyDetail.every((item) => item.status === 'pending'), 'comprado+recebido sem entrega a loja continua pendente')

  // Entrega apenas a primeira necessidade da fila (FIFO) Galpao->Loja.
  const firstDeliveredId = await deliverNext(orderId, product)

  const midList = await history()
  const midOrder = midList.find((entry) => entry.id === orderId)
  assert.equal(midOrder.totalItems, 3)
  assert.equal(midOrder.processedItems, 1)
  assert.equal(midOrder.pendingItems, 2)
  assert.equal(midOrder.situation, 'partial', 'nao pode virar concluida com necessidade fisica ainda pendente')

  const midDetail = await history(orderId)
  const delivered = midDetail.find((item) => item.allocationId === firstDeliveredId)
  assert.equal(delivered.status, 'processed')
  assert.equal(Number(delivered.deliveredQuantity), Number(delivered.targetQuantity))
  assert.equal(midDetail.filter((item) => item.status === 'pending').length, 2)

  // Entrega as duas necessidades restantes, sempre a proxima da fila: ordem deve ficar totalmente processada.
  await deliverNext(orderId, product)
  await deliverNext(orderId, product)
  const afterList = await history()
  const afterOrder = afterList.find((entry) => entry.id === orderId)
  assert.equal(afterOrder.processedItems, 3)
  assert.equal(afterOrder.pendingItems, 0)
  assert.equal(afterOrder.situation, 'completed')

  const afterDetail = await history(orderId)
  assert.ok(afterDetail.every((item) => item.status === 'processed'))

  // Escopo por loja: pedir so a loja da primeira entrega restringe o detalhe a 1 item.
  const scoped = await history(orderId, delivered.storeId)
  assert.equal(scoped.length, 1)
  assert.equal(scoped[0].storeId, delivered.storeId)
})

contractTest('historico ordena pendentes primeiro; ordem so fica concluida com necessidade fisica realmente entregue', async () => {
  // generate() reusa qualquer ordem ativa da conta (202609130004): para ter
  // duas ordens distintas no historico, a primeira precisa chegar a
  // 'completed' (comprada, recebida E entregue) antes de liberar a criacao
  // da segunda a partir de um novo run efetivo.
  const { id: completedOrderId, product: completedProduct } = await plan([1])
  await fullyDeliver(completedOrderId, completedProduct, 1)
  await deliverNext(completedOrderId, completedProduct)
  assert.equal((await query('select status from market_replenishment_orders where id=$1', [completedOrderId]))[0].status, 'completed')

  const newRun = request()
  const newProduct = request()
  await query("insert into market_products(id,market_account_id,name) values($1,$2,'Produto Historico 2')", [newProduct, account])
  await query(`insert into market_replenishment_runs(id,market_account_id,reference_date,algorithm_version,status,is_effective,started_at,finished_at)
    values($1,$2,'2026-09-16','v1','completed',true,'2026-09-16T06:00:00Z','2026-09-16T06:01:00Z')`, [newRun, account])
  await query(`insert into market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity)
    values($1,$2,$3,$4,'2026-09-16','high',1,4)`, [newRun, account, storeA, newProduct])
  const { id: pendingOrderId } = await plan([4])
  assert.notEqual(pendingOrderId, completedOrderId)

  const list = await history()
  const pendingIndex = list.findIndex((entry) => entry.id === pendingOrderId)
  const completedIndex = list.findIndex((entry) => entry.id === completedOrderId)
  assert.ok(pendingIndex !== -1 && completedIndex !== -1)
  assert.ok(pendingIndex < completedIndex, 'lista com pendencia precisa vir antes da lista concluida, mesmo sendo mais recente')
  assert.equal(list.find((entry) => entry.id === pendingOrderId).situation, 'partial')
  assert.equal(list.find((entry) => entry.id === completedOrderId).situation, 'completed')
})
