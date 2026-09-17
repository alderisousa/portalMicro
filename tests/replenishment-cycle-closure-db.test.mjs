import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'

const base=new URL('./replenishment-supply-fifo-fix-db.test.mjs',import.meta.url)
let source=readFileSync(base,'utf8').split('\ncontractTest(')[0]
source=source.replaceAll(', import.meta.url)',`, ${JSON.stringify(base.href)})`)
const fixture=await import(`data:text/javascript;base64,${Buffer.from(source+'\nexport {db,query,generate,account,warehouseA,warehouseB,storeA,storeB,storeC,productA,request,reject,contractTest,release,review,allocationsOf,supplyQueue,executeSupply,warehouseBalance};').toString('base64')}`)
const {db,query,generate,account,warehouseA,warehouseB,storeA,storeB,storeC,productA,request,reject,contractTest,release,review,allocationsOf,supplyQueue,executeSupply,warehouseBalance}=fixture
const sqlFile=name=>readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8')
await db.exec(sqlFile('202609160001_release_received_purchase_to_supply.sql'))
await db.exec(sqlFile('202609160002_allow_replenishment_receipt_without_invoice_key.sql'))
await db.exec(sqlFile('202609160003_close_replenishment_cycle_and_bulk_supply.sql'))

// Fonte comercial minima para executar o batch REAL, sem substituir seu algoritmo.
await db.exec(`
 alter table market_replenishment_runs alter column id set default gen_random_uuid(),
 add column stores_processed integer default 0,add column products_analyzed integer default 0,
 add column products_triggered integer default 0,add column products_selected integer default 0,
 add column triggered_over_limit_count integer default 0,add column critical_count integer default 0,
 add column high_count integer default 0,add column medium_count integer default 0,add column low_count integer default 0,
 add column error_code text,add column error_message text;
 create table market_integrations(id uuid primary key,market_account_id uuid,provider text,status text);
 create table market_sales_sync_runs(id uuid primary key default gen_random_uuid(),market_account_id uuid,integration_id uuid,
 status text,source text,period_start date,period_end date,last_completed_day date,total_days integer,completed_days integer,finished_at timestamptz,skipped_orders integer default 0);
 create table market_sales_imports(id uuid primary key,market_account_id uuid,status text,period_start date,period_end date);
 create table market_sales_import_rows(import_id uuid,market_account_id uuid,market_store_id uuid,product_id uuid,sale_date date,quantity numeric);
 create table market_store_products(market_account_id uuid,market_store_id uuid,product_id uuid,minimum_stock numeric,is_essential boolean,status text);
 create table market_sales(id uuid primary key,market_account_id uuid,market_store_id uuid,integration_id uuid,source_type text,source_system text,status text,sold_at timestamptz);
 create table market_sale_items(sale_id uuid,market_account_id uuid,product_id uuid,external_product_id text,quantity numeric);
 create table market_product_mappings(market_account_id uuid,integration_id uuid,external_product_id text,product_id uuid,source_system text);
`)
await db.exec(sqlFile('202609100001_add_market_replenishment_settings.sql'))
await db.exec(sqlFile('202609100013_add_replenishment_acceleration_min_units.sql'))
await db.exec(sqlFile('202609100015_fix_replenishment_strong_acceleration_aggravator.sql'))
await db.exec(sqlFile('202609150001_fix_replenishment_materialize_unknown_quantity.sql'))
for (const name of [
 '202609170002_replenishment_safe_settings_and_list_limit.sql',
 '202609170003_allow_stale_draft_replenishment_closure.sql',
 '202609170004_allow_closed_unapproved_draft.sql',
 '202609170005_allow_closed_without_operation_lines.sql',
]) await db.exec(sqlFile(name))

const data=async(sql,params)=>(await query(sql,params))[0].data
const preview=id=>data('select market_get_replenishment_closure_preview($1,$2) data',[account,id])
const close=(id,req=request(),reason=null)=>data('select market_close_replenishment_order($1,$2,$3,$4) data',[account,id,req,reason])
const batchPreview=id=>data('select market_get_replenishment_supply_batch_preview($1,$2) data',[account,id])
const batch=(id,items,req=request())=>data('select market_execute_replenishment_supply_batch($1,$2,$3,$4) data',[account,id,JSON.stringify(items),req])
const history=(id=null,store=null)=>data('select market_get_replenishment_order_history($1,$2,$3) data',[account,id,store])
const buy=async(id,quantity)=>{
 const d=(await query('select * from market_replenishment_purchase_declarations where order_id=$1 and product_id=$2',[id,productA]))[0]
 await query('select market_set_replenishment_purchased($1,$2,$3,$4)',[account,id,JSON.stringify([{declarationId:d.id,version:d.purchase_version,quantity}]),request()])
}
async function plan(parts=[[1,0],[1,0],[0,3]]) {
 const id=await generate()
 const all=await query('select a.*,i.product_id from market_replenishment_order_allocations a join market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 order by a.store_id,a.id',[id])
 for(const a of all) await review(id,a.id,0,0)
 const allocations=all.filter(a=>a.product_id===productA)
 for(let i=0;i<allocations.length;i++) await review(id,allocations[i].id,...(parts[i]??[0,0]))
 for(const a of allocations.filter((_,i)=>parts[i]?.some(q=>q>0))) await release(id,a.store_id)
 return {id,allocations}
}
async function receipt(quantity) {
 const p=request(),i=request()
 await query("insert into market_purchases(id,market_account_id,destination_store_id,status,invoice_number) values($1,$2,$3,'ready','123')",[p,account,warehouseA])
 await query(`insert into market_purchase_items(id,market_account_id,market_purchase_id,line_number,market_product_id,stock_entry_status,stock_quantity,quantity,reconciliation_status,stock_unit,conversion_factor,stock_unit_cost,reviewed_at,reviewed_by)
 values($1,$2,$3,1,$4,'pending',$5,$5,'matched_manual','UN',1,2,now(),auth.uid())`,[i,account,p,productA,quantity])
 await query('select market_receive_purchase_items($1,$2)',[account,p])
 return {p,i}
}

contractTest('preview puro, snapshot misto, fechamento idempotente e historico congelado',async()=>{
 const {id}=await plan([[2,0],[1,0],[0,3]])
 await buy(id,2)
 const q=await supplyQueue(id,productA)
 await executeSupply(id,q[0].allocation_id,q[0].warehouse_line_id,q[0].source_store_id,Number(q[0].remaining))
 const before=(await query('select count(*) n from market_replenishment_order_events'))[0].n
 const p=await preview(id)
 assert.equal(p.summary.totalNeeds,3)
 assert.equal(p.summary.processed,1)
 assert.equal(p.summary.readyToSupply,1)
 assert.equal(p.summary.awaitingReceiptUnits,2)
 assert.equal(p.summary.stillToBuyKnownUnits,1)
 assert.equal((await query('select count(*) n from market_replenishment_order_events'))[0].n,before)
 const req=request(),snapshot=await close(id,req,'fim do ciclo')
 assert.deepEqual(await close(id,req,'fim do ciclo'),snapshot)
 assert.deepEqual(await close(id),snapshot)
 assert.equal((await query('select status from market_replenishment_orders where id=$1',[id]))[0].status,'closed')
 assert.equal((await query("select count(*)::int n from market_replenishment_orders where status in ('draft','approved','in_progress')"))[0].n,0)
 assert.equal((await query("select count(*)::int n from market_replenishment_order_events where order_id=$1 and event_type='ORDER_CLOSED'",[id]))[0].n,1)
 const frozen=await history(id)
 await receipt(20)
 assert.deepEqual(await preview(id),snapshot)
 assert.deepEqual(await history(id),frozen)
 assert.equal((await history()).find(o=>o.id===id).situation,'closed_with_pending')
 assert.equal((await history(id,storeA)).length,1)
 await reject(()=>generate(),/REPLENISHMENT_FRESH_ANALYSIS_REQUIRED/)
 await reject(()=>close(id,req,'outro motivo'),/REQUEST_CONFLICT/)
})

contractTest('closed rejeita compra, revisao, liberacao, reopen, supply e escritas internas; NF tardia entra sem vinculo',async()=>{
 const {id,allocations}=await plan()
 await buy(id,3)
 const q=(await supplyQueue(id,productA))[0]
 await close(id)
 await reject(()=>buy(id,2),/NOT_APPROVED|CLOSED/)
 await reject(()=>review(id,allocations[0].id,1,0),/NOT_DRAFT|CLOSED/)
 await reject(()=>release(id,storeA),/NOT_DRAFT|CLOSED|INVALID/)
 await reject(()=>query('select market_reopen_replenishment_order($1,$2,$3)',[account,id,request()]),/CLOSED|NOT_APPROVED|INVALID|STARTED/)
 await reject(()=>executeSupply(id,q.allocation_id,q.warehouse_line_id,q.source_store_id,Number(q.remaining)),/ORDER_INVALID/)
 for(const table of ['market_replenishment_orders','market_replenishment_order_items','market_replenishment_operation_lines','market_replenishment_purchase_declarations','market_replenishment_order_store_releases']) {
  await reject(()=>query(`update ${table} set market_account_id=market_account_id where ${table==='market_replenishment_orders'?'id':'order_id'}=$1`,[id]),/CLOSED/)
 }
 const balance=await warehouseBalance(warehouseA,productA)
 const nf=await receipt(3)
 assert.equal(await warehouseBalance(warehouseA,productA),balance+3)
 assert.equal((await query("select count(*)::int n from market_stock_movements where reference_id=$1 and movement_type='PURCHASE' and direction='IN'",[nf.p]))[0].n,1)
 assert.equal((await query('select count(*)::int n from market_replenishment_purchase_nf_links where order_id=$1',[id]))[0].n,0)
 assert.equal((await query('select count(*)::int n from market_replenishment_receipt_allocations where order_id=$1',[id]))[0].n,0)
 assert.equal((await supplyQueue(id,productA)).length,0)
})

contractTest('lote usa apenas pronto, varias lojas, pares fisicos, excesso preservado, replay',async()=>{
 const {id}=await plan()
 await buy(id,3)
 await receipt(2) // comprado 3 recebido 2 continua aguardando integralmente
 const p=await batchPreview(id)
 assert.equal(p.storeCount,2);assert.equal(p.totalUnits,2)
 assert.equal((await preview(id)).summary.awaitingReceiptUnits,3)
 const balance=await warehouseBalance(warehouseA,productA),req=request()
 const result=await batch(id,p.items,req)
 assert.equal(result.length,2)
 assert.equal(await warehouseBalance(warehouseA,productA),balance-2)
 assert.equal((await query('select count(*)::int n from market_replenishment_supply_executions where replenishment_order_id=$1',[id]))[0].n,2)
 const movements=await query("select movement_type,direction,sum(quantity)::int n from market_stock_movements where reference_type='REPLENISHMENT_SUPPLY' group by movement_type,direction order by movement_type")
 assert.deepEqual(movements,[{movement_type:'TRANSFER_IN',direction:'IN',n:2},{movement_type:'TRANSFER_OUT',direction:'OUT',n:2}])
 assert.deepEqual(await batch(id,p.items,req),result)
 await reject(()=>batch(id,[],request()),/INVALID_INPUT/)
})

contractTest('erro no segundo item desfaz primeira transferencia e todas as supply executions',async()=>{
 const {id}=await plan()
 const p=await batchPreview(id),balance=await warehouseBalance(warehouseA,productA)
 await db.exec(`create function test_fail_second_supply() returns trigger language plpgsql as $$begin
 if exists(select 1 from market_replenishment_supply_executions where replenishment_order_id=new.replenishment_order_id) then raise exception 'TEST_SECOND_ITEM_FAILURE'; end if; return new; end$$;
 create trigger test_fail_second before insert on market_replenishment_supply_executions for each row execute function test_fail_second_supply();`)
 await reject(()=>batch(id,p.items),/TEST_SECOND_ITEM_FAILURE/)
 assert.equal(await warehouseBalance(warehouseA,productA),balance)
 assert.equal((await query('select count(*)::int n from market_replenishment_supply_executions where replenishment_order_id=$1',[id]))[0].n,0)
 assert.equal((await query("select count(*)::int n from market_stock_movements where reference_type='REPLENISHMENT_SUPPLY'"))[0].n,0)
})

contractTest('preview desatualizado nao produz lote parcial',async()=>{
 const {id}=await plan(),p=await batchPreview(id)
 await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','OUT',7),($1,$4,$3,'INVENTORY','OUT',3)",[account,warehouseA,productA,warehouseB])
 await reject(()=>batch(id,p.items),/BATCH_CONFLICT/)
 assert.equal((await query('select count(*)::int n from market_replenishment_supply_executions'))[0].n,0)
})

contractTest('completed legado permanece no Historico e rejeita fechamento por RPC e transicao direta',async()=>{
 const {id}=await plan([[1,0],[1,0],[1,0]])
 await batch(id,(await batchPreview(id)).items)
 assert.equal((await query('select status from market_replenishment_orders where id=$1',[id]))[0].status,'completed')
 assert.equal((await history()).find(o=>o.id===id).situation,'completed')
 const completed=(await query('select completed_at from market_replenishment_orders where id=$1',[id]))[0].completed_at
 const before=await history(id)
 await reject(()=>preview(id),/REPLENISHMENT_CLOSURE_ORDER_INVALID/)
 await reject(()=>close(id),/REPLENISHMENT_CLOSURE_ORDER_INVALID/)
 await reject(()=>renew(id),/REPLENISHMENT_CLOSURE_ORDER_INVALID/)
 await reject(()=>query("update market_replenishment_orders set status='closed',closed_at=now(),closed_by=auth.uid(),closure_snapshot='{}' where id=$1",[id]),/REPLENISHMENT_ORDER_INVALID_TRANSITION/)
 assert.equal((await query('select status from market_replenishment_orders where id=$1',[id]))[0].status,'completed')
 assert.deepEqual(await history(id),before)
 assert.equal((await history()).find(o=>o.id===id).situation,'completed')
 assert.equal((await query("select count(*)::int n from market_replenishment_order_events where order_id=$1 and event_type='ORDER_CLOSED'",[id]))[0].n,0)
 assert.deepEqual((await query('select completed_at from market_replenishment_orders where id=$1',[id]))[0].completed_at,completed)
})

const renew=(id,req=request())=>data('select market_close_and_create_replenishment_order($1,$2,$3,null) data',[account,id,req])
async function sales(accesys=false) {
 const integration=request(),imp=request()
 await query('insert into market_replenishment_settings(market_account_id) values($1)',[account])
 if(accesys) {
  await query("insert into market_integrations values($1,$2,'accesys','active')",[integration,account])
  await query(`insert into market_sales_sync_runs(market_account_id,integration_id,status,source,period_start,period_end,last_completed_day,total_days,completed_days,finished_at)
   values($1,$2,'completed','market','2026-09-10','2026-09-12','2026-09-12',3,3,now()),
   ($1,$2,'failed','scheduled','2026-09-13','2026-09-15',null,3,0,now()),
   ($1,$2,'partial','admin','2026-09-13','2026-09-15','2026-09-15',3,3,now())`,[account,integration])
  await query("insert into market_sales values($1,$2,$3,$4,'api','accesys','completed','2026-09-12')",[imp,account,storeA,integration])
  await query('insert into market_sale_items values($1,$2,$3,null,14)',[imp,account,productA])
 } else {
  await query("insert into market_sales_imports values($1,$2,'completed','2026-09-10','2026-09-12')",[imp,account])
  await query("insert into market_sales_import_rows values($1,$2,$3,$4,'2026-09-12',14)",[imp,account,storeA,productA])
 }
 await query("insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','IN',1)",[account,storeA,productA])
 return integration
}

for(const accesys of [false,true]) contractTest(`fechar + nova analise real (${accesys?'Accesys checkpoint market':'importacao legada'}) usa estoque atual e novo run`,async()=>{
 const {id}=await plan()
 await sales(accesys)
 await receipt(5)
 const req=request(),result=await renew(id,req)
 assert.equal(result.referenceDate,'2026-09-12')
 assert.ok(result.analysisTimestamp)
 assert.notEqual(result.newOrderId,id)
 const order=(await query('select * from market_replenishment_orders where id=$1',[result.newOrderId]))[0]
 assert.equal(order.run_id,result.newRunId);assert.equal(order.status,'draft')
 const candidates=await query('select * from market_replenishment_candidates where run_id=$1',[result.newRunId])
 assert.equal(candidates.length,1)
 assert.equal(Number(candidates[0].warehouse_stock),15)
 assert.equal(Number(candidates[0].current_stock),1)
 assert.equal((await query('select count(*)::int n from market_replenishment_order_allocations a join market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1',[result.newOrderId]))[0].n,1)
 assert.deepEqual(await renew(id,req),result)
 assert.equal((await query("select count(*)::int n from market_replenishment_orders where status in ('draft','approved','in_progress')"))[0].n,1)
 const extraRun=request()
 await query("insert into market_replenishment_runs(id,market_account_id,reference_date,algorithm_version,status) values($1,$2,'2026-09-12','v1','completed')",[extraRun,account])
 await reject(async()=>{
  await query('insert into market_replenishment_orders(market_account_id,run_id) values($1,$2)',[account,extraRun])
  await db.exec('set constraints all immediate')
 },/ACTIVE_CONFLICT/)
})

contractTest('sem data confiavel, falha do batch, sem candidatos e erro de materializacao preservam ciclo antigo',async()=>{
 const {id}=await plan()
 const old=await preview(id),runsBefore=(await query('select count(*)::int n from market_replenishment_runs'))[0].n
 await reject(()=>renew(id),/RELIABLE_SALES_DATE_UNAVAILABLE/)
 await sales()
 await query('update market_replenishment_settings set is_active=false')
 await reject(()=>renew(id),/FRESH_ANALYSIS_FAILED/)
 await query('update market_replenishment_settings set is_active=true')
 await query('delete from market_sales_import_rows')
 await reject(()=>renew(id),/NO_CANDIDATES/)
 assert.equal((await query('select status from market_replenishment_orders where id=$1',[id]))[0].status,'approved')
 assert.deepEqual(await preview(id),old)
 assert.equal((await query('select count(*)::int n from market_replenishment_runs'))[0].n,runsBefore)
 await query("insert into market_sales_import_rows select id,market_account_id,$1,$2,'2026-09-12',14 from market_sales_imports",[storeA,productA])
 await db.exec(`create function test_fail_materialize() returns trigger language plpgsql as $$begin raise exception 'TEST_MATERIALIZE_FAILURE'; end$$;
 create trigger test_fail_materialize before insert on market_replenishment_order_items for each row execute function test_fail_materialize();`)
 await reject(()=>renew(id),/TEST_MATERIALIZE_FAILURE/)
 assert.equal((await query('select status from market_replenishment_orders where id=$1',[id]))[0].status,'approved')
 assert.equal((await query('select count(*)::int n from market_replenishment_runs'))[0].n,runsBefore)
 assert.equal((await query("select count(*)::int n from market_replenishment_order_events where event_type='ORDER_CLOSED'"))[0].n,0)
})

contractTest('data confiavel usa checkpoint anterior a falha, exclui rejeicoes e data corrente',async()=>{
 await sales(true)
 const date=()=>data('select market_replenishment_reliable_sales_date_internal($1)::text data',[account])
 assert.equal(await date(),'2026-09-12')
 await query("update market_sales_sync_runs set completed_days=1,last_completed_day='2026-09-13' where status='failed'")
 assert.equal(await date(),'2026-09-13')
 await query("update market_sales_sync_runs set skipped_orders=1 where status='failed'")
 assert.equal(await date(),'2026-09-12')
 await query("update market_sales_sync_runs set period_start=current_date,period_end=current_date,last_completed_day=current_date,total_days=1,completed_days=1 where status='completed'")
 await reject(()=>date(),/RELIABLE_SALES_DATE_UNAVAILABLE/)
})

contractTest('lote inclui compra integral recebida e nao excede parcelas planejadas',async()=>{
 const {id}=await plan([[1,0],[1,0],[0,3]])
 await buy(id,3);await receipt(8)
 const p=await batchPreview(id)
 assert.equal(p.totalUnits,5);assert.equal(p.storeCount,3)
 assert.equal((await preview(id)).summary.awaitingReceiptUnits,0)
 const balance=await warehouseBalance(warehouseA,productA)
 await batch(id,p.items)
 assert.equal(await warehouseBalance(warehouseA,productA),balance-5)
 assert.equal((await history()).find(o=>o.id===id).processedItems,3)
})

contractTest('permissao e isolamento por Market, helpers privados e snapshot inviolavel',async()=>{
 const {id}=await plan()
 await reject(()=>data('select market_get_replenishment_closure_preview($1,$2) data',['10000000-0000-4000-8000-000000000002',id]),/PERMISSION_DENIED|NOT_FOUND/)
 await close(id)
 await reject(()=>query("update market_replenishment_orders set closure_snapshot='{}' where id=$1",[id]),/CLOSED/)
 await reject(()=>query('delete from market_replenishment_orders where id=$1',[id]),/CLOSED/)
 await query("update market_account_members set role='viewer' where market_account_id=$1",[account])
 await reject(()=>preview(id),/PERMISSION_DENIED/)
 await reject(()=>close(id),/PERMISSION_DENIED/)
 await reject(()=>batchPreview(id),/PERMISSION_DENIED/)
 assert.equal(await data("select has_function_privilege('anon','market_close_replenishment_order(uuid,uuid,uuid,text)','EXECUTE') data"),false)
 assert.equal(await data("select has_function_privilege('authenticated','market_replenishment_reliable_sales_date_internal(uuid)','EXECUTE') data"),false)
})

contractTest('fatos vinculados e allocations tambem ficam imutaveis depois de closed',async()=>{
 const {id,allocations}=await plan()
 await buy(id,3);await receipt(3)
 const q=(await supplyQueue(id,productA))[0]
 await executeSupply(id,q.allocation_id,q.warehouse_line_id,q.source_store_id,Number(q.remaining))
 await close(id)
 for(const table of ['market_replenishment_purchase_nf_links','market_replenishment_receipt_allocations']) {
  assert.ok((await query(`select count(*)::int n from ${table} where order_id=$1`,[id]))[0].n>0)
  await reject(()=>query(`update ${table} set quantity=quantity where order_id=$1`,[id]),/CLOSED/)
  await reject(()=>query(`delete from ${table} where order_id=$1`,[id]),/CLOSED/)
 }
 await reject(()=>query('update market_replenishment_order_allocations set suggested_quantity=suggested_quantity where id=$1',[allocations[0].id]),/CLOSED/)
 await reject(()=>query('update market_replenishment_supply_executions set quantity=quantity where replenishment_order_id=$1',[id]),/CLOSED/)
 await query('select market_reconcile_replenishment_receipts_internal($1,$2)',[account,[productA]])
 assert.equal((await supplyQueue(id,productA)).length,0)
})

contractTest('draft stale pode ser substituido; CLOSED sem aprovacao nem operation_lines passa constraints diferidas',async()=>{
 const id=await generate()
 await sales()
 const latest=await data("select market_run_replenishment_batch($1,'2026-09-12','manual') data",[account])
 const detail=await data('select market_get_replenishment_order($1,$2) data',[account,id])
 assert.equal(detail.isStale,true)
 assert.notEqual(detail.order.runId,latest)
 assert.equal(detail.order.status,'draft')
 await preview(id)
 const req=request(),result=await renew(id,req)
 assert.deepEqual(await renew(id,req),result)
 const old=(await query('select status,approved_at,approval_revision from market_replenishment_orders where id=$1',[id]))[0]
 assert.deepEqual(old,{status:'closed',approved_at:null,approval_revision:0})
 assert.equal((await query('select count(*)::int n from market_replenishment_operation_lines where order_id=$1',[id]))[0].n,0)
 const next=(await query('select status,run_id from market_replenishment_orders where id=$1',[result.newOrderId]))[0]
 assert.equal(next.status,'draft');assert.equal(next.run_id,result.newRunId)
 assert.notEqual(result.newOrderId,id)
 await db.exec('set constraints all immediate')
 await reject(()=>query("update market_replenishment_orders set status='approved' where id=$1",[id]),/CLOSED|INVALID_TRANSITION/)
})

contractTest('falha na nova analise preserva draft e nao fabrica aprovacao',async()=>{
 const id=await generate()
 await reject(()=>renew(id),/RELIABLE_SALES_DATE_UNAVAILABLE/)
 const old=(await query('select status,approved_at,approval_revision from market_replenishment_orders where id=$1',[id]))[0]
 assert.deepEqual(old,{status:'draft',approved_at:null,approval_revision:0})
})

for(const [limit,critical,expected] of [[20,0,20],[100,0,100],[150,0,150],[100,120,120],[100,230,200]]) {
 contractTest(`batch real: limite normal ${limit}, criticos ${critical}, selecionados ${expected} por loja`,async()=>{
  await sales()
  await query('update market_replenishment_settings set normal_list_limit=$1,demand_method=\'m7\',acceleration_threshold_pct=100',[limit])
  await query('delete from market_sales_import_rows')
  await query(`insert into market_products(id,market_account_id,name)
   select ('a0000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid,$1,'Teste limite '||g from generate_series(1,230) g`,[account])
  await query(`insert into market_sales_import_rows(import_id,market_account_id,market_store_id,product_id,sale_date,quantity)
   select i.id,$1,s,p.id,'2026-09-12',14 from market_sales_imports i
   cross join unnest($2::uuid[]) s cross join market_products p where p.name like 'Teste limite %'`,[account,[storeA,storeB]])
  await query(`insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity)
   select $1,s,p.id,'INVENTORY','IN',case when right(p.id::text,12)::int <= $3 then 0 else 8 end
   from market_products p cross join unnest($2::uuid[]) s where p.name like 'Teste limite %'`,[account,[storeA,storeB],critical])
  const run=await data("select market_run_replenishment_batch($1,'2026-09-12','manual') data",[account])
  const summary=(await query('select status,products_selected,critical_count from market_replenishment_runs where id=$1',[run]))[0]
  assert.equal(summary.status,'completed')
  const counts=await query(`select store_id,count(*)::int n,count(*) filter(where priority_level='critical')::int critical
   from market_replenishment_candidates where run_id=$1 group by store_id order by store_id`,[run])
  assert.equal(counts.length,2)
  for(const row of counts){assert.equal(row.n,expected);assert.equal(row.critical,Math.min(critical,200))}
  assert.equal(summary.products_selected,expected*2)
  assert.equal(summary.critical_count,Math.min(critical,200)*2)
 })
}
