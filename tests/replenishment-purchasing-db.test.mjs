import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

// Reuse only the existing local PostgreSQL fixture and applied migrations,
// without executing its test suite or copying its schema into another fixture.
const fixtureUrl = new URL('./replenishment-order-contract-db.test.mjs', import.meta.url)
let setup = readFileSync(fixtureUrl, 'utf8').split("\ntest('materializacao")[0]
setup = setup.replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href))
  .replace(/from '(\.\.[^']+)'/g, (_match, path) => `from '${new URL(path, fixtureUrl).href}'`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,approve,account,otherAccount,actor,warehouseA,storeA,storeB,storeC,request,reject,contractTest};').toString('base64')}`)
const { db, query, generate, approve, account, otherAccount, warehouseA, storeA, storeB, storeC, request, reject, contractTest } = fixture
const migration = readFileSync(new URL('../supabase/migrations/202609130002_replenishment_purchase_tracking.sql', import.meta.url), 'utf8')
await db.exec(migration)
const supplyMigration = readFileSync(new URL('../supabase/migrations/202609130003_replenishment_atomic_store_supply.sql', import.meta.url), 'utf8')
await db.exec(supplyMigration)
await db.exec(readFileSync(new URL('../supabase/migrations/202609130004_fix_replenishment_active_order_reuse.sql', import.meta.url), 'utf8'))
const read = async (id) => (await query('select market_get_replenishment_purchasing($1,$2) data',[account,id]))[0].data
const save = (id,changes,req=request(),tenant=account) => query('select market_set_replenishment_purchased($1,$2,$3,$4)',[tenant,id,JSON.stringify(changes),req])
const link = (id,line,item,amount,req=request()) => query('select market_link_replenishment_purchase_nf($1,$2,$3,$4,$5,$6)',[account,id,line,item,amount,req])
async function ready() { const id=await generate(); await approve(id); return {id,lines:await read(id)} }
async function invoice(product,amount,store=warehouseA) {
  const purchase=request(),item=request()
  await query("insert into market_purchases(id,market_account_id,destination_store_id,status,invoice_key,invoice_number) values($1::uuid,$2,$3,'ready',($1::uuid)::text,'123')",[purchase,account,store])
  await query("insert into market_purchase_items(id,market_account_id,market_purchase_id,line_number,market_product_id,stock_entry_status,stock_quantity,quantity,reconciliation_status,stock_unit) values($1,$2,$3,1,$4,'pending',$5,$5,'matched_manual','UN')",[item,account,purchase,product,amount])
  return {purchase,item}
}
async function warehouseSupplyLine(id) {
  return (await query("select l.id operation_line_id,a.id allocation_id,a.store_id,i.product_id,l.target_quantity from market_replenishment_operation_lines l join market_replenishment_order_allocations a on a.id=l.allocation_id join market_replenishment_order_items i on i.id=a.order_item_id where l.order_id=$1 and l.operation_type='warehouse' limit 1",[id]))[0]
}
async function addWarehouseStock(product,amount=28) {
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id) values($1,$2,$3,'PURCHASE','IN',$4,'PURCHASE',$5,$6)",[account,warehouseA,product,amount,request(),request()])
}

contractTest('active order with newer batch retains pending purchases and blocks supersede after supply', async () => {
  const { id, lines } = await ready()
  const supply = await warehouseSupplyLine(id)
  await addWarehouseStock(supply.product_id)
  await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',
    [account, id, supply.allocation_id, supply.operation_line_id, warehouseA, supply.target_quantity, request()])
  const latest = request()
  await query(`insert into market_replenishment_runs(id,market_account_id,reference_date,algorithm_version,status,is_effective,started_at,finished_at)
    values ($1,$2,'2026-09-14','v1','completed',true,'2026-09-14T10:00:00Z','2026-09-14T10:01:00Z')`, [latest, account])
  await query(`insert into market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity)
    values ($1,$2,$3,$4,'2026-09-14','high',1,3)`, [latest, account, storeA, lines[0].productId])
  const detail = (await query('select market_get_replenishment_order($1,$2) data', [account, id]))[0].data
  assert.equal(await generate(), id)
  assert.equal(detail.order.status, 'in_progress')
  assert.equal(detail.latestEligibleRunId, latest)
  assert.equal(detail.isStale, true)
  assert.equal(detail.canSupersede, false)
  assert.equal(detail.canReopen, false)
  assert.ok(detail.purchase.pendingLines > 0)
  assert.deepEqual(await read(id), lines)
  await reject(() => query('select market_supersede_replenishment_order($1,$2,$3)', [account, id, request()]), /CANNOT_SUPERSEDE/)
  await reject(() => query('select market_cancel_replenishment_order($1,$2,$3,$4)', [account, id, 'Nova análise', request()]), /CANNOT_CANCEL/)
})

contractTest('consolidated mark default, excess adjustment, undo and concurrency never create stock',async()=>{
  const {id,lines}=await ready(); const line=lines[0]
  const before=await query('select * from market_stock_movements order by id')
  const changes=[{declarationId:line.id,version:0,quantity:line.targetQuantity}], req=request()
  await save(id,changes,req); await save(id,changes,req)
  assert.equal((await read(id)).find(l=>l.id===line.id).version,1)
  await reject(()=>save(id,changes),/VERSION_CONFLICT/)
  await reject(()=>save(id,[{...changes[0],quantity:1}],req),/REQUEST_CONFLICT/)
  await save(id,[{declarationId:line.id,version:1,quantity:Number(line.targetQuantity)+3}])
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).purchasedQuantity),Number(line.targetQuantity)+3)
  await save(id,[{declarationId:line.id,version:2,quantity:null}])
  assert.equal((await read(id)).find(l=>l.id===line.id).purchasedQuantity,null)
  assert.deepEqual(await query('select * from market_stock_movements order by id'),before)
  assert.equal(Number((await query('select l.confirmed_quantity from market_replenishment_operation_lines l join market_replenishment_order_allocations a on a.id=l.allocation_id join market_replenishment_order_items i on i.id=a.order_item_id where l.order_id=$1 and i.product_id=$2 and l.operation_type=\'purchase\' limit 1',[id,line.productId]))[0].confirmed_quantity),0)
})

contractTest('consolidated quantity keeps allocations intact',async()=>{
  const {id,lines}=await ready(); const line=lines[0]
  const originalStores=line.stores.map(s=>[s.storeId,Number(s.targetQuantity)])
  assert.equal(originalStores.reduce((sum,entry)=>sum+entry[1],0),Number(line.targetQuantity))
  await reject(()=>save(id,[{declarationId:line.id,version:99,quantity:18}]),/VERSION_CONFLICT/)
  await save(id,[{declarationId:line.id,version:0,quantity:18}])
  let state=(await read(id)).find(l=>l.id===line.id)
  assert.equal(Number(state.purchasedQuantity),18)
  assert.deepEqual(state.stores.map(s=>[s.storeId,Number(s.targetQuantity)]),originalStores)
  await save(id,[{declarationId:line.id,version:1,quantity:24}])
  state=(await read(id)).find(l=>l.id===line.id)
  assert.equal(Number(state.purchasedQuantity),24)
  assert.deepEqual(state.stores.map(s=>[s.storeId,Number(s.targetQuantity)]),originalStores)
})

contractTest('reject draft, foreign tenant, unauthorized role and invalid quantities',async()=>{
  const id=await generate()
  await reject(()=>save(id,[]),/NOT_APPROVED/)
  await approve(id); const line=(await read(id))[0]
  for(const quantity of [0,-1,0.5,'NaN']) await reject(()=>save(id,[{declarationId:line.id,version:0,quantity}]),/INVALID_QUANTITY/)
  await reject(()=>save(id,[{declarationId:line.id,version:0,quantity:1}],request(),otherAccount),/PERMISSION_DENIED/)
  await query("update market_account_members set role='viewer' where market_account_id=$1",[account])
  await reject(()=>read(id),/PERMISSION_DENIED/)
  await reject(()=>save(id,[{declarationId:line.id,version:0,quantity:1}]),/PERMISSION_DENIED/)
})

contractTest('NF coverage is explicit, received only with PURCHASE/IN; links lock undo and cannot double allocate',async()=>{
  const {id,lines}=await ready(); const line=lines[0]
  await save(id,[{declarationId:line.id,version:0,quantity:4}])
  const nf=await invoice(line.productId,4)
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).coveredQuantity),0)
  const before=await query('select count(*)::int n from market_stock_movements')
  const req=request();await link(id,line.id,nf.item,4,req);await link(id,line.id,nf.item,4,req)
  let row=(await read(id)).find(l=>l.id===line.id)
  assert.equal(Number(row.coveredQuantity),4);assert.equal(Number(row.receivedQuantity),0)
  await reject(()=>save(id,[{declarationId:line.id,version:1,quantity:null}]),/NF_LOCKED/)
  await reject(()=>link(id,line.id,nf.item,1),/NF_EXCEEDED/)
  assert.deepEqual(await query('select count(*)::int n from market_stock_movements'),before)
  // Simulate the existing Compras receipt; the replenishment RPC never writes this.
  await query("update market_purchase_items set stock_entry_status='received' where id=$1",[nf.item])
  await query("update market_purchases set status='completed' where id=$1",[nf.purchase])
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).receivedQuantity),0)
  await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id) values($1,$2,$3,'PURCHASE','IN',4,'PURCHASE',$4,$5)",[account,warehouseA,line.productId,nf.purchase,nf.item])
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).receivedQuantity),4)
})

contractTest('NF destined to store or later invalidated cannot cover warehouse purchase',async()=>{
  const {id,lines}=await ready();const line=lines[0]
  await save(id,[{declarationId:line.id,version:0,quantity:2}])
  const storeNf=await invoice(line.productId,2,storeA)
  await reject(()=>link(id,line.id,storeNf.item,2),/NF_INVALID/)
  const nf=await invoice(line.productId,2)
  await link(id,line.id,nf.item,2)
  await query("update market_purchases set status='cancelled' where id=$1",[nf.purchase])
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).coveredQuantity),0)
})

contractTest('multiple NFs cover one consolidated acquisition without stock writes',async()=>{
  const {id,lines}=await ready(); const line=lines[0]
  await save(id,[{declarationId:line.id,version:0,quantity:4}])
  const first=await invoice(line.productId,2)
  const second=await invoice(line.productId,2)
  await link(id,line.id,first.item,2)
  await link(id,line.id,second.item,2)
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).coveredQuantity),4)
})

contractTest('atomic store supply uses real warehouse balance, supports excess and accumulates progress',async()=>{
  const {id}=await ready()
  const warehouseLine=await warehouseSupplyLine(id)
  await addWarehouseStock(warehouseLine.product_id)
  const before=await query('select count(*)::int n from market_stock_movements')
  const supplyRequest=request()
  const result=await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',[account,id,warehouseLine.allocation_id,warehouseLine.operation_line_id,warehouseA,18,supplyRequest])
  assert.equal(Number(result[0].data.executedQuantity),18)
  const target=Number((await query('select target_quantity from market_replenishment_operation_lines where id=$1',[warehouseLine.operation_line_id]))[0].target_quantity)
  assert.equal(Number(result[0].data.confirmedQuantity),Math.min(target,18))
  const movements=await query("select movement_type,direction,quantity,market_store_id,reference_id from market_stock_movements where reference_type='REPLENISHMENT_SUPPLY'")
  assert.deepEqual(movements.map(m=>[m.movement_type,m.direction,Number(m.quantity)]),[['TRANSFER_OUT','OUT',18],['TRANSFER_IN','IN',18]])
  const retry=await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',[account,id,warehouseLine.allocation_id,warehouseLine.operation_line_id,warehouseA,18,supplyRequest])
  assert.equal(retry[0].data.executionId,result[0].data.executionId)
  assert.equal(Number((await query('select count(*)::int n from market_stock_movements'))[0].n),Number(before[0].n)+2)
})

contractTest('supply rejects stale balance and invalid warehouse without partial movements',async()=>{
  const {id}=await ready(); const line=await warehouseSupplyLine(id); await addWarehouseStock(line.product_id,10)
    const before=Number((await query("select count(*)::int n from market_stock_movements"))[0].n)
    await reject(()=>query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',[account,id,line.allocation_id,line.operation_line_id,warehouseA,10000,request()]),/INSUFFICIENT_STOCK/)
  assert.equal(Number((await query("select count(*)::int n from market_stock_movements"))[0].n),before)
})

contractTest('multiple atomic executions accumulate real quantity but cap confirmed progress at target',async()=>{
  const {id}=await ready(); const line=await warehouseSupplyLine(id); await addWarehouseStock(line.product_id,10)
  await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',[account,id,line.allocation_id,line.operation_line_id,warehouseA,1,request()])
  await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',[account,id,line.allocation_id,line.operation_line_id,warehouseA,1,request()])
  const state=(await query('select market_get_replenishment_store_supply($1,$2,$3) data',[account,id,line.store_id]))[0].data.find(row=>row.operationLineId===line.operation_line_id)
  assert.equal(Number(state.executedQuantity),2)
  assert.equal(Number(state.confirmedQuantity),Math.min(Number(line.target_quantity),2))
})

test('new migration never inserts stock; UI uses pending/purchased and only checks NF receipt',()=>{
  assert.doesNotMatch(migration,/insert\s+into\s+(public\.)?market_stock_movements/i)
  assert.doesNotMatch(migration,/TRANSFER_OUT|TRANSFER_IN/)
  assert.match(supplyMigration,/store_type='warehouse'/)
  const ui=readFileSync(new URL('../src/components/ReplenishmentPurchasing.tsx',import.meta.url),'utf8')
  assert.match(ui,/line\.purchasedQuantity !== null/)
  assert.match(ui,/Lance primeiro a\(s\) nota\(s\)/)
  assert.match(ui,/Desfazer comprado/)
})
