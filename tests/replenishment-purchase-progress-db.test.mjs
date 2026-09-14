import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

// Existing isolated PGlite fixture, without running the older suites.
const fixtureUrl = new URL('./replenishment-purchasing-db.test.mjs', import.meta.url)
const setup = readFileSync(fixtureUrl, 'utf8').split('\ncontractTest(')[0]
  .replaceAll(', import.meta.url)', `, ${JSON.stringify(fixtureUrl.href)})`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,approve,account,otherAccount,request,reject,contractTest,read,save,link,invoice};').toString('base64')}`)
const { db, query, generate, approve, account, otherAccount, request, reject, contractTest, read, save, link, invoice } = fixture
const migration = readFileSync(new URL('../supabase/migrations/202609140004_integrate_replenishment_purchase_progress.sql', import.meta.url), 'utf8')
await db.exec(migration)

// Complete only the local fixture fields needed by the unchanged receipt RPC.
await db.exec(`
  alter table market_purchase_items add column conversion_factor numeric, add column reviewed_at timestamptz,
    add column reviewed_by uuid, add column received_by uuid;
  alter table market_stock_movements add column notes text, add column created_by uuid;
  create unique index if not exists ux_progress_receipt_source on market_stock_movements
    (market_account_id,movement_type,reference_type,reference_id,reference_item_id)
    where reference_type is not null and reference_id is not null and reference_item_id is not null;
  create or replace function market_has_role(p_account uuid,p_roles text[]) returns boolean language sql as $$
    select exists(select 1 from market_account_members where market_account_id=p_account
      and user_id=auth.uid() and role=any(p_roles) and status='active') $$;
  create or replace function market_is_accesys_current_product(p_account uuid,p_product uuid) returns boolean language sql as $$
    select exists(select 1 from market_products where market_account_id=p_account and id=p_product and status='active') $$;
`)
await db.exec(readFileSync(new URL('../supabase/migrations/202609070006_purchase_receiving_require_unit_cost.sql',import.meta.url),'utf8'))

async function ready(warehouse = true, smoke = false) {
  const id = await generate()
  const allocations = await query(`select a.id,a.warehouse_allocated_quantity,i.product_id from market_replenishment_order_allocations a
    join market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 order by i.product_id,a.id`, [id])
  const seen = new Map()
  for (const a of allocations) {
    const count = seen.get(a.product_id) ?? 0
    const quantity = smoke ? (count === 0 ? (seen.size === 0 ? 1 : 3) : 0) : count === 0 ? 2 : count === 1 ? 3 : 0
    seen.set(a.product_id,count+1)
    await query('select market_update_replenishment_allocation_review($1,$2,$3,$4,$5)', [account,id,a.id,warehouse ? a.warehouse_allocated_quantity : 0,quantity])
  }
  await approve(id)
  return { id, lines: await read(id) }
}
const operations = (id) => query(`select l.*,i.product_id from market_replenishment_operation_lines l
  join market_replenishment_order_allocations a on a.id=l.allocation_id
  join market_replenishment_order_items i on i.id=a.order_item_id
  where l.order_id=$1 and l.operation_type='purchase' order by l.id`, [id])
const events = (id) => query('select * from market_replenishment_order_events where order_id=$1 order by sequence', [id])
const status = async (id) => (await query('select status from market_replenishment_orders where id=$1', [id]))[0].status
const change = (line, quantity, version = line.version) => ({ declarationId: line.id, version, quantity })
const total = (rows) => rows.reduce((sum,row) => sum+Number(row.confirmed_quantity),0)

contractTest('first full purchase emits ordered events once; warehouse pending keeps order in_progress', async () => {
  const {id,lines} = await ready()
  const stock = await query('select * from market_stock_movements order by id')
  const req = request(), changes = lines.map(l=>change(l,l.targetQuantity))
  await save(id,changes,req)
  assert.equal(await status(id),'in_progress')
  assert.ok((await operations(id)).every(l=>Number(l.confirmed_quantity)===Number(l.target_quantity)))
  const first = await events(id)
  for (const kind of ['PURCHASE_STARTED','PURCHASE_COMPLETED']) assert.equal(first.filter(e=>e.event_type===kind).length,1)
  const emitted = first.filter(e=>e.request_id===req)
  assert.equal(emitted[0].event_type,'PURCHASE_DECLARATION_CHANGED')
  assert.deepEqual(emitted.map(e=>e.request_ordinal),emitted.map((_,i)=>i+1))
  const increments = emitted.filter(e=>e.event_type==='PURCHASE_QUANTITY_CONFIRMED')
  assert.equal(increments.length,(await operations(id)).length)
  assert.ok(increments.every(e=>e.operation_line_id && Number(e.quantity_delta)>0 && e.actor_user_id))
  await save(id,changes,req)
  assert.deepEqual(await events(id),first)
  await save(id,(await read(id)).map(l=>change(l,l.purchasedQuantity)))
  const again=await events(id)
  for (const kind of ['PURCHASE_STARTED','PURCHASE_COMPLETED','PURCHASE_QUANTITY_CONFIRMED']) {
    assert.equal(again.filter(e=>e.event_type===kind).length,first.filter(e=>e.event_type===kind).length)
  }
  assert.deepEqual(await query('select * from market_stock_movements order by id'),stock)
})

contractTest('partial 2 to 4 to 5 fills stable line IDs and emits only real deltas', async () => {
  const {id,lines} = await ready(), line=lines[0]
  assert.equal(Number(line.targetQuantity),5)
  for (const [version,quantity,delta] of [[0,2,2],[1,4,2],[2,5,1]]) {
    const req=request()
    await save(id,[change(line,quantity,version)],req)
    const rows=(await operations(id)).filter(l=>l.product_id===line.productId)
    let remaining=quantity
    for (const row of rows) {
      const expected=Math.min(remaining,Number(row.target_quantity))
      assert.equal(Number(row.confirmed_quantity),expected)
      assert.equal(row.completed_at!==null,expected===Number(row.target_quantity))
      remaining-=expected
    }
    const increments=(await events(id)).filter(e=>e.request_id===req && e.event_type==='PURCHASE_QUANTITY_CONFIRMED')
    assert.equal(increments.reduce((sum,e)=>sum+Number(e.quantity_delta),0),delta)
  }
  assert.equal((await events(id)).filter(e=>e.event_type==='PURCHASE_STARTED').length,1)
})

contractTest('excess is declaration only; reduction to confirmed allowed; below or unmark blocked atomically', async () => {
  const {id,lines}=await ready(), line=lines[0]
  await save(id,[change(line,8)])
  assert.equal(total((await operations(id)).filter(l=>l.product_id===line.productId)),5)
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).purchasedQuantity),8)
  await save(id,[change(line,5,1)])
  const before=await events(id)
  for (const quantity of [4,null]) await reject(()=>save(id,[change(line,quantity,2)]),/BELOW_CONFIRMED/)
  assert.deepEqual(await events(id),before)
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).purchasedQuantity),5)
  assert.equal(before.filter(e=>e.event_type==='PURCHASE_QUANTITY_CONFIRMED').reduce((sum,e)=>sum+Number(e.quantity_delta),0),5)
})

contractTest('partial can increase, cannot decrease, and same absolute quantity does not reconfirm', async () => {
  const {id,lines}=await ready(), line=lines[0]
  await save(id,[change(line,2)])
  await reject(()=>save(id,[change(line,1,1)]),/BELOW_CONFIRMED/)
  await save(id,[change(line,2,1)])
  assert.equal(total((await operations(id)).filter(l=>l.product_id===line.productId)),2)
  assert.equal((await events(id)).filter(e=>e.event_type==='PURCHASE_QUANTITY_CONFIRMED').reduce((sum,e)=>sum+Number(e.quantity_delta),0),2)
  await save(id,[change(line,4,2)])
})

contractTest('completion without NF; replay after completed and stale version/conflicting request stay safe', async () => {
  const {id,lines}=await ready(false), changes=lines.map(l=>change(l,l.targetQuantity)),req=request()
  await save(id,changes,req)
  assert.equal(await status(id),'completed')
  const before=await events(id)
  assert.equal(before.filter(e=>e.event_type==='ORDER_COMPLETED').length,1)
  assert.equal(before.at(-2).event_type,'PURCHASE_COMPLETED')
  assert.equal(before.at(-1).event_type,'ORDER_COMPLETED')
  await save(id,changes,req)
  assert.deepEqual(await events(id),before)
  await reject(()=>save(id,[change(lines[0],1)],req),/REQUEST_CONFLICT/)
  await reject(()=>save(id,changes),/NOT_APPROVED/)
  assert.equal((await query('select count(*)::int n from market_replenishment_purchase_nf_links where order_id=$1',[id]))[0].n,0)
})

contractTest('warehouse already complete plus legacy acquired declarations: official resave completes without stock', async () => {
  const {id,lines}=await ready(true,true)
  assert.deepEqual(lines.map(l=>Number(l.targetQuantity)).sort((a,b)=>a-b),[1,3])
  // Arrange historical declarations by using the previous official RPC.
  const previous=readFileSync(new URL('../supabase/migrations/202609130002_replenishment_purchase_tracking.sql',import.meta.url),'utf8')
    .split('create function public.market_set_replenishment_purchased(')[1].split('create function public.market_link_replenishment_purchase_nf(')[0]
  await db.exec('create or replace function public.market_set_replenishment_purchased('+previous)
  await save(id,lines.map(l=>change(l,l.targetQuantity)))
  // Reinstall function inside this rollback-only test (omit migration transaction).
  await db.exec(migration.slice(migration.indexOf('create or replace function'),migration.lastIndexOf('commit;')))
  const warehouse=await query("select l.id,a.store_id from market_replenishment_operation_lines l join market_replenishment_order_allocations a on a.id=l.allocation_id where l.order_id=$1 and l.operation_type='warehouse'",[id])
  for (const row of warehouse) {
    const supply=(await query('select market_get_replenishment_store_supply($1,$2,$3) data',[account,id,row.store_id]))[0].data.find(l=>l.operationLineId===row.id)
    // Seed only the local fixture's warehouse balance; execute the official supply RPC.
    await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','IN',100)",[account,supply.sourceStoreId,supply.productId])
    await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',[account,id,supply.allocationId,row.id,supply.sourceStoreId,supply.targetQuantity,request()])
  }
  const before=await query('select * from market_stock_movements order by id')
  assert.equal(total(await operations(id)),0)
  await save(id,(await read(id)).map(l=>change(l,l.purchasedQuantity)))
  assert.equal(await status(id),'completed')
  assert.deepEqual(await query('select * from market_stock_movements order by id'),before)
})

contractTest('NF links and multiple received NFs do not confirm acquisition again; NF lock preserved', async () => {
  const {id,lines}=await ready(), line=lines[0]
  await save(id,[change(line,4)])
  const opBefore=await operations(id)
  for (let n=0;n<2;n++) {
    const nf=await invoice(line.productId,2)
    await link(id,line.id,nf.item,2)
    await query("update market_purchase_items set stock_entry_status='received' where id=$1",[nf.item])
    await query("update market_purchases set status='completed' where id=$1",[nf.purchase])
    await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id) select market_account_id,destination_store_id,$2,'PURCHASE','IN',2,'PURCHASE',id,$3 from market_purchases where id=$1",[nf.purchase,line.productId,nf.item])
  }
  const result=(await read(id)).find(l=>l.id===line.id)
  assert.equal(Number(result.coveredQuantity),4)
  assert.equal(Number(result.receivedQuantity),4)
  assert.deepEqual(await operations(id),opBefore)
  await reject(()=>save(id,[change(line,5,1)]),/NF_LOCKED/)
})

contractTest('version, tenant and batch atomicity guards remain', async () => {
  const {id,lines}=await ready()
  await save(id,[change(lines[0],2)])
  await reject(()=>save(id,[change(lines[0],4)]),/VERSION_CONFLICT/)
  await reject(()=>save(id,[change(lines[0],4,1)],request(),otherAccount),/PERMISSION_DENIED|NOT_FOUND/)
  const before=await operations(id), priorEvents=await events(id)
  await reject(()=>save(id,[change(lines[1],2),change(lines[0],1,1)]),/BELOW_CONFIRMED/)
  assert.deepEqual(await operations(id),before)
  assert.deepEqual(await events(id),priorEvents)
})

contractTest('warehouse finishes last, helper waits for every line, transfer replay and completion are unique', async () => {
  const {id,lines}=await ready()
  const purchaseRequest=request(), changes=lines.map(l=>change(l,l.targetQuantity))
  await save(id,changes,purchaseRequest)
  const warehouse=await query("select l.id,a.store_id from market_replenishment_operation_lines l join market_replenishment_order_allocations a on a.id=l.allocation_id where l.order_id=$1 and l.operation_type='warehouse' order by l.id",[id])
  assert.ok(warehouse.length>1)
  for (const [index,row] of warehouse.entries()) {
    const supply=(await query('select market_get_replenishment_store_supply($1,$2,$3) data',[account,id,row.store_id]))[0].data.find(l=>l.operationLineId===row.id)
    await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','IN',100)",[account,supply.sourceStoreId,supply.productId])
    const req=request(),args=[account,id,supply.allocationId,row.id,supply.sourceStoreId,supply.targetQuantity,req]
    const run=()=>query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',args)
    const first=await run()
    assert.equal(await status(id),index===warehouse.length-1?'completed':'in_progress')
    const before=await query('select * from market_stock_movements order by id'), beforeEvents=await events(id)
    assert.deepEqual(await run(),first)
    assert.deepEqual(await query('select * from market_stock_movements order by id'),before)
    assert.deepEqual(await events(id),beforeEvents)
    const transfers=await query("select movement_type,quantity from market_stock_movements where reference_id in (select id from market_replenishment_supply_executions where request_id=$1) order by movement_type",[req])
    assert.deepEqual(transfers.map(m=>[m.movement_type,Number(m.quantity)]),[['TRANSFER_IN',Number(supply.targetQuantity)],['TRANSFER_OUT',Number(supply.targetQuantity)]])
  }
  const before=await events(id)
  assert.equal(before.filter(e=>e.event_type==='ORDER_COMPLETED').length,1)
  assert.equal(before.at(-2).event_type,'WAREHOUSE_QUANTITY_CONFIRMED')
  assert.equal(before.at(-1).request_id,before.at(-2).request_id)
  assert.equal(before.at(-1).request_ordinal,2)
  await save(id,changes,purchaseRequest)
  assert.deepEqual(await events(id),before)
})

contractTest('completed order accepts NF link and official later receipt; neither reconfirms or reopens order', async () => {
  const {id,lines}=await ready(false),line=lines[0]
  await save(id,lines.map(l=>change(l,l.targetQuantity)))
  const opBefore=await operations(id), beforeEvents=await events(id)
  const stockBefore=await query('select * from market_stock_movements order by id')
  const nf=await invoice(line.productId,line.targetQuantity), req=request()
  await link(id,line.id,nf.item,line.targetQuantity,req)
  await link(id,line.id,nf.item,line.targetQuantity,req)
  assert.equal(await status(id),'completed')
  assert.deepEqual(await operations(id),opBefore)
  assert.deepEqual(await query('select * from market_stock_movements order by id'),stockBefore)
  const linkedEvents=await events(id)
  assert.equal(linkedEvents.length,beforeEvents.length+1)
  assert.equal(linkedEvents.at(-1).event_type,'PURCHASE_NF_LINKED')
  const covered=(await read(id)).find(l=>l.id===line.id)
  assert.equal(Number(covered.coveredQuantity),Number(line.targetQuantity))
  assert.equal(Number(covered.receivedQuantity),0)
  await reject(()=>link(id,line.id,nf.item,1),/NF_EXCEEDED/)
  await reject(()=>save(id,[change(line,line.targetQuantity+1,1)]),/NOT_APPROVED/)
  await query('update market_purchase_items set conversion_factor=1,stock_unit_cost=2,reviewed_at=now(),reviewed_by=auth.uid() where id=$1',[nf.item])
  await query('select market_receive_purchase_items($1,$2)',[account,nf.purchase])
  const movements=await query('select * from market_stock_movements where reference_item_id=$1',[nf.item])
  assert.equal(movements.length,1)
  assert.equal(movements[0].movement_type,'PURCHASE')
  assert.equal(movements[0].direction,'IN')
  assert.equal(Number(movements[0].quantity),Number(line.targetQuantity))
  assert.equal(Number((await read(id)).find(l=>l.id===line.id).receivedQuantity),Number(line.targetQuantity))
  assert.deepEqual(await operations(id),opBefore)
  assert.deepEqual(await events(id),linkedEvents)
  assert.equal(await status(id),'completed')
  await reject(()=>query('select market_receive_purchase_items($1,$2)',[account,nf.purchase]),/PURCHASE_REVIEW_LOCKED/)
  assert.deepEqual(await query('select * from market_stock_movements where reference_item_id=$1',[nf.item]),movements)
})

test('completed UI keeps NF linking and verification while acquisition edits remain guarded', () => {
  const ui=readFileSync(new URL('../src/components/ReplenishmentPurchasing.tsx',import.meta.url),'utf8')
  assert.match(ui,/view === 'purchased' && editable && <>\s*<button[^\n]*Salvar quantidade/)
  assert.match(ui,/\(editable \|\| orderDetail.order.status === 'completed'\) && line.coveredQuantity/)
  assert.match(ui,/onClick=\{\(\) => void checkInvoices\(\)\}/)
  assert.match(ui,/const bought = \(await reload\(\)\)/)
})
