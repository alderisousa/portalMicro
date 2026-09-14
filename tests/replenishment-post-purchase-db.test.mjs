import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const base=new URL('./replenishment-purchasing-db.test.mjs',import.meta.url)
// Load the existing database fixture and receipt RPC without running its suite.
let source=readFileSync(base,'utf8').split('\ncontractTest(')[0]
source=source.replaceAll(', import.meta.url)',`, ${JSON.stringify(base.href)})`)
// Preserve the replacement expression used by the nested fixture.
const fixture=await import(`data:text/javascript;base64,${Buffer.from(source+'\nexport {db,query,generate,approve,account,otherAccount,request,reject,contractTest,read,save,invoice};').toString('base64')}`)
const {db,query,generate,approve,account,otherAccount,request,reject,contractTest,read,save,invoice}=fixture
await db.exec(readFileSync(new URL('../supabase/migrations/202609140004_integrate_replenishment_purchase_progress.sql',import.meta.url),'utf8'))
await db.exec(`alter table market_purchase_items add column conversion_factor numeric,add column reviewed_at timestamptz,add column reviewed_by uuid,add column received_by uuid;
 alter table market_stock_movements add column notes text,add column created_by uuid;
 create unique index receipt_test_source on market_stock_movements(market_account_id,movement_type,reference_type,reference_id,reference_item_id)
 where reference_type is not null and reference_id is not null and reference_item_id is not null;
 create or replace function market_has_role(p_account uuid,p_roles text[]) returns boolean language sql as $$
 select exists(select 1 from market_account_members where market_account_id=p_account and user_id=auth.uid() and role=any(p_roles) and status='active') $$;
 create or replace function market_is_accesys_current_product(p_account uuid,p_product uuid) returns boolean language sql as $$
 select exists(select 1 from market_products where id=p_product and market_account_id=p_account and status='active') $$;`)
await db.exec(readFileSync(new URL('../supabase/migrations/202609140005_replenishment_post_purchase.sql',import.meta.url),'utf8'))

const stock=()=>query('select * from market_stock_movements order by id')
const events=id=>query('select * from market_replenishment_order_events where order_id=$1 order by sequence',[id])
const status=async id=>(await query('select status from market_replenishment_orders where id=$1',[id]))[0].status
const change=(l,q)=>({declarationId:l.id,version:l.version,quantity:q})
async function plan(amounts=[2,1,2],warehouse=false) {
 const id=await generate()
 const allocations=await query(`select a.*,i.product_id from market_replenishment_order_allocations a join market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 order by i.product_id,a.id`,[id])
 const product=allocations[0].product_id
 for(const a of allocations) await query('select market_update_replenishment_allocation_review($1,$2,$3,0,0)',[account,id,a.id])
 let index=0
 for(const a of allocations) {
   const amount=a.product_id===product?(amounts[index++]??0):0
   const mixed=warehouse==='mixed'?1:warehouse===2?2:null
   await query('select market_update_replenishment_allocation_review($1,$2,$3,$4,$5)',[account,id,a.id,mixed!==null?Math.min(mixed,amount):warehouse?amount:0,mixed!==null?Math.max(0,amount-mixed):warehouse?0:amount])
 }
 await approve(id)
 return {id,product,allocations:allocations.filter(a=>a.product_id===product).slice(0,amounts.length),lines:await read(id)}
}
async function buy(id,quantity) {
 const line=(await read(id))[0]
 await save(id,[change(line,quantity)])
 return (await read(id))[0]
}
async function receipt(product,quantity) {
 const nf=await invoice(product,quantity)
 await query('update market_purchase_items set conversion_factor=1,stock_unit_cost=2,reviewed_at=now(),reviewed_by=auth.uid() where id=$1',[nf.item])
 await query('select market_receive_purchase_items($1,$2)',[account,nf.purchase])
 return nf
}
const attributed=id=>query('select allocation_id,sum(quantity)::int quantity from market_replenishment_receipt_allocations where order_id=$1 group by allocation_id order by allocation_id',[id])

contractTest('full and partial acquisition derive quantities, no NF stays waiting and no stock created',async()=>{
 const {id}=await plan([5]),before=await stock()
 let line=await buy(id,2)
 assert.equal(Number(line.remainingToBuy),3);assert.equal(Number(line.awaitingQuantity),2)
 line=await buy(id,5)
 assert.equal(Number(line.remainingToBuy),0);assert.equal(Number(line.awaitingQuantity),5)
 assert.equal((await attributed(id)).length,0)
 assert.deepEqual(await stock(),before)
})

contractTest('FIFO integral A2 B1 C2: receipt4 gives 2/1/0 then receipt1 completes C',async()=>{
 const {id,product}=await plan()
 await buy(id,5)
 const nf=await receipt(product,4)
 assert.deepEqual((await attributed(id)).map(r=>r.quantity),[2,1])
 const linked=await query('select sum(quantity)::int n from market_replenishment_purchase_nf_links where purchase_item_id=$1',[nf.item])
 assert.equal(linked[0].n,3)
 await receipt(product,1)
 assert.deepEqual((await attributed(id)).map(r=>r.quantity),[2,1,2])
 assert.equal(Number((await read(id))[0].awaitingQuantity),0)
 const before=await stock(), links=await attributed(id)
 await query('select market_reconcile_replenishment_receipts_internal($1,$2)',[account,[product]])
 assert.deepEqual(await attributed(id),links);assert.deepEqual(await stock(),before)
})

contractTest('multiple NFs accumulate evidence but no partial allocation; excess stays unlinked',async()=>{
 const {id,product}=await plan([5]);await buy(id,5)
 await receipt(product,2);assert.equal((await attributed(id)).length,0)
 await receipt(product,8);assert.deepEqual((await attributed(id)).map(r=>r.quantity),[5])
 assert.equal((await query('select sum(quantity)::int n from market_replenishment_purchase_nf_links where order_id=$1',[id]))[0].n,5)
})

contractTest('same ten units cannot prove A6 and B6; FIFO stops at B',async()=>{
 const {id,product}=await plan([6,6]);await buy(id,12);await receipt(product,10)
 assert.deepEqual((await attributed(id)).map(r=>r.quantity),[6])
 assert.equal(Number((await read(id))[0].awaitingQuantity),6)
})

contractTest('receipt before purchase marking is reconciled on acquisition, no screen action',async()=>{
 const {id,product}=await plan([3]);await receipt(product,3)
 assert.equal((await attributed(id)).length,0)
 await buy(id,3);assert.deepEqual((await attributed(id)).map(r=>r.quantity),[3])
})

contractTest('old receipt before approved revision is excluded even when stock exists',async()=>{
 const product=(await query('select id from market_products order by id limit 1'))[0].id
 await receipt(product,10)
 // Move fixture receipt to before approval, without modifying production functions.
 await query("update market_stock_movements set occurred_at=now()-interval '1 day' where movement_type='PURCHASE'")
 const {id}=await plan([3]);await buy(id,3)
 assert.equal((await attributed(id)).length,0)
 const supply=(await query('select market_get_replenishment_store_supply($1,null,null) data',[account]))[0].data
 assert.ok(supply.length>0,'old stock may supply but cannot prove current receipt')
})

contractTest('purchase-only completed allocation can supply, transfer pair is exact and replay is stable',async()=>{
 const {id,product}=await plan([3]);await buy(id,3);await receipt(product,3)
 assert.equal(await status(id),'completed')
 const line=(await query('select market_get_replenishment_store_supply($1,null,null) data',[account]))[0].data[0]
 assert.equal(line.operationLineId,null)
 const args=[account,id,line.allocationId,null,line.sourceStoreId,3,request()]
 const run=()=>query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7) data',args)
 const result=await run(),before=await stock()
 assert.deepEqual(await run(),result);assert.deepEqual(await stock(),before)
 assert.equal(await status(id),'completed')
 assert.deepEqual(before.filter(m=>m.reference_id===result[0].data.executionId).map(m=>[m.movement_type,Number(m.quantity)]).sort(),[['TRANSFER_IN',3],['TRANSFER_OUT',3]])
 assert.equal((await query('select market_get_replenishment_store_supply($1,null,null) data',[account]))[0].data.length,0)
 await reject(()=>buy(id,null),/PHYSICALLY_COMMITTED/)
})

contractTest('warehouse normal uses same FIFO and cannot bypass or supply partial need',async()=>{
 const {id}=await plan([2,1],true)
 const lines=(await query('select market_get_replenishment_store_supply($1,null,null) data',[account]))[0].data
 const first=lines[0],second=lines[1]
 await reject(()=>query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',[account,id,second.allocationId,second.operationLineId,second.sourceStoreId,1,request()]),/FIFO_BLOCKED/)
 await reject(()=>query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',[account,id,first.allocationId,first.operationLineId,first.sourceStoreId,1,request()]),/FULL_NEED_REQUIRED/)
 for(const l of lines) await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',[account,id,l.allocationId,l.operationLineId,l.sourceStoreId,l.remainingQuantity,request()])
 assert.equal(await status(id),'completed')
})

contractTest('undo before receipt is audited and reopens commercial completion; partial commitment protects floor',async()=>{
 const {id,product}=await plan([2,3]);await buy(id,5)
 const before=await stock();await buy(id,null)
 assert.equal(await status(id),'in_progress')
 assert.equal(Number((await read(id))[0].remainingToBuy),5)
 assert.ok((await events(id)).some(e=>e.event_type==='PURCHASE_CORRECTED'))
 assert.deepEqual(await stock(),before)
 await buy(id,5);await receipt(product,2)
 await buy(id,2)
 assert.equal(Number((await read(id))[0].purchasedQuantity),2)
 await reject(()=>buy(id,null),/PHYSICALLY_COMMITTED/)
})

contractTest('independent new batch generates while previous completed order remains physically pending',async()=>{
 const {id,product,allocations}=await plan([3]);await buy(id,3)
 assert.equal(await status(id),'completed')
 const run=request(),otherProduct=(await query('select id from market_products where market_account_id=$1 and id<>$2 order by id limit 1',[account,product]))[0].id
 await query("insert into market_replenishment_runs(id,market_account_id,reference_date,algorithm_version,status,is_effective,started_at,finished_at) values($1,$2,'2026-09-15','v1','completed',true,now(),now())",[run,account])
 await query("insert into market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity,warehouse_stock) values($1,$2,$3,$4,'2026-09-15','high',1,2,0)",[run,account,allocations[0].store_id,otherProduct])
 const next=await generate()
 assert.notEqual(next,id)
 assert.equal((await query('select run_id from market_replenishment_orders where id=$1',[next]))[0].run_id,run)
 assert.equal(Number((await query('select remaining from market_replenishment_physical_needs_internal($1) where order_id=$2 and allocation_id=$3',[account,id,allocations[0].id]))[0].remaining),3)
})

contractTest('commercial FIFO ignores operation UUID: buy4 yields 2/1/1 and receipt4 yields 2/1/0',async()=>{
 const {id,product}=await plan([2,1,2])
 const lines=await query("select id from market_replenishment_operation_lines where order_id=$1 and operation_type='purchase' order by allocation_id",[id])
 // Deliberately reverse UUID order in this isolated fixture, before any line event.
 await db.exec('alter table market_replenishment_operation_lines disable trigger user')
 for(let i=0;i<lines.length;i++) await query('update market_replenishment_operation_lines set id=$1 where id=$2',[`ffffff00-0000-4000-8000-${String(3-i).padStart(12,'0')}`,lines[i].id])
 await db.exec('alter table market_replenishment_operation_lines enable trigger user')
 await buy(id,4)
 assert.deepEqual((await query("select confirmed_quantity from market_replenishment_operation_lines where order_id=$1 and operation_type='purchase' order by allocation_id",[id])).map(x=>Number(x.confirmed_quantity)),[2,1,1])
 await receipt(product,4)
 assert.deepEqual((await attributed(id)).map(x=>x.quantity),[2,1])
})

contractTest('receipt preserves previous cost requirement and all previous body except integration hooks',async()=>{
 const extract=sql=>sql.split('create or replace function public.market_receive_purchase_items(')[1].split('$$;')[0]
 const normalize=sql=>sql.replace(/--[^\n]*/g,'').replace(/\s+/g,' ').trim()
 const previous=extract(readFileSync(new URL('../supabase/migrations/202609070006_purchase_receiving_require_unit_cost.sql',import.meta.url),'utf8'))
 const current=extract(readFileSync(new URL('../supabase/migrations/202609140005_replenishment_post_purchase.sql',import.meta.url),'utf8'))
 const withoutHooks=current.replace(/  perform pg_advisory_xact_lock[^\n]*\n/,'').replace(/  perform public.market_reconcile_replenishment_receipts_internal\(p_market_account_id,\s*array\([^\n]+\n/,'')
 assert.equal(normalize(withoutHooks),normalize(previous))
 assert.match(previous,/and i\.stock_unit_cost is not null/)
})

contractTest('legacy mixed supply2 then purchase3 emits only SUPPLY_EXECUTED for later delivery',async()=>{
 const {id,product}=await plan([5],2)
 const extract=sql=>'create or replace function public.market_execute_replenishment_store_supply('+sql.split('create or replace function public.market_execute_replenishment_store_supply(')[1].split('$$;')[0]+'$$;'
 const line=(await query('select market_get_replenishment_store_supply($1,$2,null) data',[account,id]))[0].data[0]
 // Establish the already-delivered warehouse portion using the official pre-005 RPC.
 await db.exec(extract(readFileSync(new URL('../supabase/migrations/202609140004_integrate_replenishment_purchase_progress.sql',import.meta.url),'utf8')))
 await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,2,$6)',[account,id,line.allocationId,line.operationLineId,line.sourceStoreId,request()])
 await db.exec(extract(readFileSync(new URL('../supabase/migrations/202609140005_replenishment_post_purchase.sql',import.meta.url),'utf8')))
 await buy(id,3);await receipt(product,3)
 const req=request(),args=[account,id,line.allocationId,line.operationLineId,line.sourceStoreId,req]
 await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,3,$6)',args)
 await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,3,$6)',args)
 const emitted=(await events(id)).filter(e=>e.request_id===req)
 assert.deepEqual(emitted.map(e=>e.event_type),['SUPPLY_EXECUTED'])
 assert.equal(Number(emitted[0].quantity_delta),3)
 assert.equal(Number((await query('select confirmed_quantity from market_replenishment_operation_lines where id=$1',[line.operationLineId]))[0].confirmed_quantity),2)
 const execution=(await query('select id from market_replenishment_supply_executions where request_id=$1',[req]))[0].id
 assert.deepEqual((await stock()).filter(m=>m.reference_id===execution).map(m=>[m.movement_type,Number(m.quantity)]).sort(),[['TRANSFER_IN',3],['TRANSFER_OUT',3]])
})

contractTest('FIFO birth precedes ID across orders and accounts; later small need cannot bypass large head',async()=>{
 const a=await plan([6]);await buy(a.id,6)
 const run=request()
 await query("insert into market_replenishment_runs(id,market_account_id,reference_date,algorithm_version,status,is_effective,started_at,finished_at) values($1,$2,'2026-09-15','v1','completed',true,now(),now())",[run,account])
 await query("insert into market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity,warehouse_stock) values($1,$2,$3,$4,'2026-09-15','high',1,2,0)",[run,account,a.allocations[0].store_id,a.product])
 const b=(await query('select market_materialize_replenishment_order_draft_internal($1,$2) id',[account,run]))[0].id
 const allocation=(await query('select a.id from market_replenishment_order_allocations a join market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1',[b]))[0]
 await query('select market_update_replenishment_allocation_review($1,$2,$3,0,2)',[account,b,allocation.id])
 await approve(b);await buy(b,2)
 // Timestamp fixtures only: event creation normally occurs in different transactions.
 await db.exec('alter table market_replenishment_order_events disable trigger trg_market_replenishment_event_guard')
 await query("update market_replenishment_order_events set occurred_at=now()-interval '2 days' where order_id=$1 and event_type='ORDER_APPROVED'",[a.id])
 await query("update market_replenishment_order_events set occurred_at=now()-interval '1 day' where order_id=$1 and event_type='ORDER_APPROVED'",[b])
 await db.exec('alter table market_replenishment_order_events enable trigger trg_market_replenishment_event_guard')
 await receipt(a.product,4)
 assert.equal((await attributed(a.id)).length,0);assert.equal((await attributed(b)).length,0)
 await receipt(a.product,4)
 assert.deepEqual((await attributed(a.id)).map(x=>x.quantity),[6])
 assert.deepEqual((await attributed(b)).map(x=>x.quantity),[2])
 const before=await stock()
 await query('select market_reconcile_replenishment_receipts_internal($1,$2)',[otherAccount,[a.product]])
 assert.deepEqual(await stock(),before)
})

contractTest('acquisition and correction replay cannot duplicate links/events; permissions stay internal',async()=>{
 const {id,product}=await plan([3])
 await receipt(product,3)
 const l=(await read(id))[0], req=request(),changes=[change(l,3)]
 await save(id,changes,req)
 const before=await events(id),attrs=await attributed(id)
 await save(id,changes,req)
 assert.deepEqual(await events(id),before);assert.deepEqual(await attributed(id),attrs)
 const grants=(await query(`select has_function_privilege('authenticated','market_reconcile_replenishment_receipts_internal(uuid,uuid[])','execute') helper,
 has_function_privilege('authenticated','market_link_replenishment_purchase_nf(uuid,uuid,uuid,uuid,numeric,uuid)','execute') manual,
 has_table_privilege('authenticated','market_replenishment_receipt_allocations','insert') direct`))[0]
 assert.deepEqual(grants,{helper:false,manual:false,direct:false})
})

contractTest('LOW remains outside acquisition and supply queues',async()=>{
 const {id}=await plan([3])
 const candidate=(await query('select candidate_id from market_replenishment_order_allocations where order_item_id in (select id from market_replenishment_order_items where order_id=$1) and purchase_needed_quantity>0',[id]))[0].candidate_id
 // Fixture injects a legacy LOW candidate without changing generation rules.
 await query("update market_replenishment_candidates set priority_level='low' where id=$1",[candidate])
 assert.equal((await read(id)).length,0)
 assert.equal((await query('select market_get_replenishment_store_supply($1,$2,null) data',[account,id]))[0].data.length,0)
})

for (const purchaseFirst of [true,false]) contractTest(`commercial completion is independent of last front: purchaseFirst=${purchaseFirst}`,async()=>{
 const {id}=await plan([3],'mixed')
 const line=(await query('select market_get_replenishment_store_supply($1,$2,null) data',[account,id]))[0].data[0]
 const supply=()=>query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)',[account,id,line.allocationId,line.operationLineId,line.sourceStoreId,3,request()])
 if(purchaseFirst) await buy(id,2);else await supply()
 assert.equal(await status(id),'in_progress')
 if(purchaseFirst) await supply();else await buy(id,2)
 assert.equal(await status(id),'completed')
 assert.equal((await events(id)).filter(e=>e.event_type==='ORDER_COMPLETED').length,1)
})

contractTest('undo request replay preserves correction and reopened state exactly once',async()=>{
 const {id}=await plan([3]);await buy(id,3)
 const line=(await read(id))[0],changes=[change(line,null)],req=request()
 await save(id,changes,req)
 const before=await events(id)
 await save(id,changes,req)
 assert.deepEqual(await events(id),before)
 assert.equal(await status(id),'in_progress')
 assert.equal(before.filter(e=>e.event_type==='PURCHASE_CORRECTED').length,1)
})
