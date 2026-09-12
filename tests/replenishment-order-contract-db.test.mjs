// Teste focado do contrato estrutural de status/eventos da Reposicao
// Inteligente. Usa PostgreSQL local via PGlite, no mesmo padrao dos demais
// testes de migrations/RPCs do Market.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()
after(() => db.close())

const account = '10000000-0000-4000-8000-000000000001'
const otherAccount = '10000000-0000-4000-8000-000000000002'
const actor = '40000000-0000-4000-8000-000000000001'
const run = '50000000-0000-4000-8000-000000000001'
const oldRun = '50000000-0000-4000-8000-000000000002'
const storeA = '20000000-0000-4000-8000-000000000001'
const storeB = '20000000-0000-4000-8000-000000000002'
const storeC = '20000000-0000-4000-8000-000000000003'
const warehouseA = '20000000-0000-4000-8000-000000000010'
const warehouseB = '20000000-0000-4000-8000-000000000011'
const productA = '30000000-0000-4000-8000-000000000001'
const productB = '30000000-0000-4000-8000-000000000002'
const productC = '30000000-0000-4000-8000-000000000003'
const productD = '30000000-0000-4000-8000-000000000004'
const purchaseOld = '60000000-0000-4000-8000-000000000001'
const purchaseLatest = '60000000-0000-4000-8000-000000000002'
const purchaseIgnored = '60000000-0000-4000-8000-000000000003'
const purchaseNoDocument = '60000000-0000-4000-8000-000000000004'
const itemOld = '70000000-0000-4000-8000-000000000001'
const itemLatest = '70000000-0000-4000-8000-000000000002'
const itemIgnored = '70000000-0000-4000-8000-000000000003'
const itemNoDocument = '70000000-0000-4000-8000-000000000004'

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;

  create table public.market_accounts(
    id uuid primary key,
    status text not null
  );
  create table public.market_account_members(
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    user_id uuid not null,
    role text not null,
    all_stores boolean not null default false,
    status text not null default 'active',
    created_at timestamptz not null default now()
  );
  create table public.market_stores(
    id uuid primary key,
    market_account_id uuid not null,
    name text not null,
    store_type text not null,
    status text not null default 'active',
    unique(id, market_account_id)
  );
  create table public.market_products(
    id uuid primary key,
    market_account_id uuid not null,
    name text not null,
    sku text null,
    ean text null,
    unit text not null default 'UN',
    status text not null default 'active',
    unique(id, market_account_id)
  );
  create table public.market_stock_movements(
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    product_id uuid not null,
    movement_type text not null,
    direction text not null,
    quantity numeric(18,4) not null,
    unit_cost numeric(18,6) null,
    reference_type text null,
    reference_id uuid null,
    reference_item_id uuid null,
    occurred_at timestamptz not null default now()
  );
  create view public.market_stock_balance as
    select market_account_id, market_store_id, product_id,
      sum(case when direction = 'IN' then quantity else -quantity end)::numeric(18,4) as quantity_on_hand,
      max(occurred_at) as last_movement_at
    from public.market_stock_movements
    group by market_account_id, market_store_id, product_id;

  create table public.market_replenishment_runs(
    id uuid primary key,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    reference_date date not null,
    algorithm_version text not null,
    status text not null,
    run_source text not null default 'manual',
    is_effective boolean not null default false,
    started_at timestamptz not null default now(),
    finished_at timestamptz null,
    unique(id, market_account_id)
  );
  create table public.market_replenishment_candidates(
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    store_id uuid not null,
    product_id uuid not null,
    reference_date date not null,
    current_stock numeric(18,4) null,
    minimum_stock numeric(18,4) null,
    is_essential boolean not null default false,
    avg_daily_m7 numeric(18,6) null,
    avg_daily_m14 numeric(18,6) null,
    avg_daily_m30 numeric(18,6) null,
    reference_daily_demand numeric(18,6) null,
    coverage_days numeric(18,4) null,
    acceleration_pct numeric(12,4) null,
    days_since_last_sale integer null,
    trigger_reasons text[] not null default array['LOW_COVERAGE'],
    priority_score integer not null default 0,
    priority_level text not null,
    rank_position integer not null,
    suggested_quantity numeric(18,4) null,
    warehouse_stock numeric(18,4) null,
    unique(id, market_account_id),
    foreign key (run_id, market_account_id) references public.market_replenishment_runs(id, market_account_id) on delete cascade,
    foreign key (store_id, market_account_id) references public.market_stores(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id) references public.market_products(id, market_account_id) on delete cascade
  );
  create function public.market_is_member(uuid) returns boolean language sql as $$select exists(select 1 from public.market_account_members where market_account_id=$1 and user_id=auth.uid() and status='active')$$;
  create function public.market_can_access_store(uuid) returns boolean language sql as $$select exists(select 1 from public.market_stores where id=$1 and public.market_is_member(market_account_id))$$;
  ${sqlFile('202609100004_add_market_replenishment_orders.sql')}
  ${sqlFile('202609100005_add_market_replenishment_order_items.sql')}
  ${sqlFile('202609100006_add_market_replenishment_order_allocations.sql')}
  create table public.market_purchases(
    id uuid primary key,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    destination_store_id uuid not null,
    supplier_name text null,
    supplier_document text null,
    invoice_number text null,
    invoice_series text null,
    invoice_key text null,
    issued_at timestamptz null,
    received_at timestamptz null,
    status text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(id, market_account_id),
    foreign key (destination_store_id, market_account_id) references public.market_stores(id, market_account_id)
  );
  create table public.market_purchase_items(
    id uuid primary key,
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    market_purchase_id uuid not null,
    line_number integer not null,
    market_product_id uuid null,
    supplier_product_code text null,
    barcode_normalized text null,
    quantity numeric(18,4) not null,
    stock_quantity numeric(18,4) null,
    stock_unit text null,
    stock_unit_cost numeric(18,6) null,
    reconciliation_status text not null,
    stock_entry_status text not null,
    received_at timestamptz null,
    unique(id, market_account_id),
    foreign key (market_purchase_id, market_account_id) references public.market_purchases(id, market_account_id) on delete cascade,
    foreign key (market_product_id, market_account_id) references public.market_products(id, market_account_id)
  );

  insert into auth.users values ('${actor}');
  insert into public.market_accounts values ('${account}', 'active'), ('${otherAccount}', 'active');
  insert into public.market_account_members(market_account_id, user_id, role, all_stores, status)
    values ('${account}', '${actor}', 'manager', true, 'active');
  insert into public.market_stores(id, market_account_id, name, store_type)
    values
      ('${storeA}', '${account}', 'Loja A', 'store'),
      ('${storeB}', '${account}', 'Loja B', 'store'),
      ('${storeC}', '${account}', 'Loja C', 'store'),
      ('${warehouseA}', '${account}', 'Galpao A', 'warehouse'),
      ('${warehouseB}', '${account}', 'Galpao B', 'warehouse');
  insert into public.market_products(id, market_account_id, name)
    values
      ('${productA}', '${account}', 'Produto A'),
      ('${productB}', '${account}', 'Produto B'),
      ('${productC}', '${account}', 'Produto C'),
      ('${productD}', '${account}', 'Produto D');
  insert into public.market_stock_movements(market_account_id, market_store_id, product_id, movement_type, direction, quantity)
    values
      ('${account}', '${warehouseA}', '${productA}', 'INVENTORY', 'IN', 7),
      ('${account}', '${warehouseB}', '${productA}', 'INVENTORY', 'IN', 3),
      ('${account}', '${warehouseA}', '${productB}', 'INVENTORY', 'IN', 100);
  insert into public.market_replenishment_runs(id, market_account_id, reference_date, algorithm_version, status, is_effective, started_at, finished_at)
    values
      ('${oldRun}', '${account}', date '2026-09-09', 'v1', 'completed', true, timestamptz '2026-09-09 06:00:00+00', timestamptz '2026-09-09 06:01:00+00'),
      ('${run}', '${account}', date '2026-09-10', 'v1', 'completed', true, timestamptz '2026-09-10 06:00:00+00', timestamptz '2026-09-10 06:01:00+00');
  insert into public.market_replenishment_candidates(run_id, market_account_id, store_id, product_id, reference_date, priority_level, rank_position, suggested_quantity)
    values
      ('${oldRun}', '${account}', '${storeA}', '${productA}', date '2026-09-09', 'critical', 1, 99),
      ('${run}', '${account}', '${storeA}', '${productA}', date '2026-09-10', 'critical', 2, 8),
      ('${run}', '${account}', '${storeB}', '${productA}', date '2026-09-10', 'high', 1, 6),
      ('${run}', '${account}', '${storeC}', '${productA}', date '2026-09-10', 'critical', 1, 5),
      ('${run}', '${account}', '${storeA}', '${productB}', date '2026-09-10', 'medium', 1, null),
      ('${run}', '${account}', '${storeB}', '${productC}', date '2026-09-10', 'medium', 1, 1.429),
      ('${run}', '${account}', '${storeA}', '${productD}', date '2026-09-10', 'low', 1, 9),
      ('${run}', '${account}', '${storeC}', '${productC}', date '2026-09-10', 'low', 2, null);
`)

await db.exec(sqlFile('202609100016_generate_replenishment_order_draft.sql'))
await db.exec(sqlFile('202609100017_read_replenishment_order_with_last_supplier.sql'))
await db.exec(sqlFile('202609100018_replenishment_order_review_backend.sql'))
await db.exec(sqlFile('202609110001_fix_replenishment_unknown_quantity_consolidation.sql'))
await db.exec(sqlFile('202609110002_round_replenishment_operational_quantities.sql'))
await db.exec(sqlFile('202609120001_filter_replenishment_draft_priorities.sql'))
await db.exec(sqlFile('202609120002_add_store_to_manual_replenishment_item.sql'))

const query = async (sql, params = []) => (await db.query(sql, params)).rows
let orderId

await db.exec(sqlFile('202609120003_replenishment_order_status_events_contract.sql'))
await db.exec(sqlFile('202609120004_filter_unknown_replenishment_operational_needs.sql'))
await db.exec(sqlFile('202609120005_filter_unknown_replenishment_internal_materialization.sql'))
const uuid = (n) => `90000000-0000-4000-8000-${String(n).padStart(12,'0')}`
let requestCounter = 0
const request = () => uuid(++requestCounter)
const generate = () => query('select public.market_generate_replenishment_order_draft($1) id', [account]).then(rows => rows[0].id)
const read = (id) => query('select public.market_get_replenishment_order($1,$2) result', [account,id]).then(rows => rows[0].result)
const approve = (id, req = request()) => query('select public.market_approve_replenishment_order($1,$2,$3) id', [account,id,req])
const reopen = (id, req = request()) => query('select public.market_reopen_replenishment_order($1,$2,$3) id', [account,id,req])
const supersede = (id, req = request()) => query('select public.market_supersede_replenishment_order($1,$2,$3) id', [account,id,req]).then(rows=>rows[0].id)
const allocations = (id) => query(`select a.*,i.product_id from public.market_replenishment_order_allocations a join public.market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 order by a.id`,[id])
async function reject(operation, pattern) {
  await db.exec('savepoint expected_error')
  try { await assert.rejects(operation, pattern) }
  finally { await db.exec('rollback to savepoint expected_error; release savepoint expected_error') }
}
function contractTest(name, body) {
  test(name, async () => {
    await db.exec('begin')
    try { await body(); await db.exec('set constraints all immediate') }
    finally { await db.exec('rollback') }
  })
}
async function prepared() {
  const id=await generate()
  const unknown=(await allocations(id)).find(a=>a.product_id===productB)
  await query('select public.market_update_replenishment_allocation_review($1,$2,$3,$4,$5)',[account,id,unknown.id,1,0])
  return id
}
async function newer(withCandidates=true, opts={}) {
  const id=request()
  await query(`insert into public.market_replenishment_runs(id,market_account_id,reference_date,algorithm_version,status,is_effective,started_at,finished_at)
    values ($1,$2,$3,'v1',$4,$5,$6,$6)`, [id,opts.account??account,opts.date??'2026-09-11',opts.status??'completed',opts.effective??true,opts.started??'2026-09-11T06:00:00Z'])
  if(withCandidates) await query(`insert into public.market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity)
    values($1,$2,$3,$4,'2026-09-11','high',1,3)`,[id,account,storeA,productC])
  return id
}
async function startSimulated(id) {
  // Simula somente persistencia futura autorizada; nao ha RPC/UI de execucao.
  await query("update public.market_replenishment_orders set status='in_progress',started_at=now(),started_by=$2 where id=$1",[id,actor])
  const line=(await query('select id from public.market_replenishment_operation_lines where order_id=$1 order by id limit 1',[id]))[0]
  await query('update public.market_replenishment_operation_lines set confirmed_quantity=1,started_at=now(),started_by=$2,completed_at=case when target_quantity=1 then now() else null end where id=$1',[line.id,actor])
  return line.id
}

test('materializacao exclui necessidade desconhecida sem alterar o batch', async () => {
  const batchUnknown = (await query(
    'select suggested_quantity from public.market_replenishment_candidates where run_id=$1 and product_id=$2',
    [run, productB],
  ))[0]
  assert.equal(batchUnknown.suggested_quantity, null)

  const id = await generate()
  const items = await query('select product_id,total_suggested_quantity from public.market_replenishment_order_items where order_id=$1', [id])
  assert.deepEqual(items.map((item) => item.product_id).sort(), [productA, productC].sort())
  assert.equal(items.some((item) => item.total_suggested_quantity === null), false)

  const allocations = await query(`
    select i.product_id, a.suggested_quantity, a.warehouse_allocated_quantity, a.purchase_needed_quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id
    where i.order_id=$1
  `, [id])
  assert.equal(allocations.length, 4)
  assert.equal(allocations.some((allocation) => allocation.suggested_quantity === null), false)
  assert.equal(allocations.some((allocation) => allocation.product_id === productB), false)
  assert.equal(allocations.some((allocation) => allocation.product_id === productD), false)

  const second = await generate()
  assert.equal(second, id)
  assert.equal((await query('select count(*)::int n from public.market_replenishment_order_items where order_id=$1', [id]))[0].n, 2)
})

contractTest('geracao e leitura mantem order ativa mesmo com novo batch; stale nao recalcula',async()=>{
  const id=await prepared()
  const before=(await read(id)).items
  assert.equal((await read(id)).isStale,false)
  const latest=await newer()
  const data=await read(id)
  assert.equal(data.sourceRunId,run)
  assert.equal(data.latestEligibleRunId,latest)
  assert.equal(data.isStale,true)
  assert.equal(data.canSupersede,true)
  assert.equal(await generate(),id)
  assert.deepEqual((await read(id)).items,before)
  assert.equal((await query('select count(*)::int n from public.market_replenishment_orders'))[0].n,1)
})

contractTest('stale ignora failed, nao efetivo, outra conta e reprocessamento de data anterior',async()=>{
  const id=await prepared()
  await newer(false,{status:'failed',effective:false})
  await newer(false,{effective:false})
  await newer(false,{account:otherAccount})
  await newer(false,{date:'2026-09-08',started:'2026-09-12T00:00:00Z'})
  assert.equal((await read(id)).isStale,false)
  await query('update public.market_replenishment_runs set is_effective=false where id=$1',[run])
  const sameDay=await newer(false,{date:'2026-09-10',started:'2026-09-10T09:00:00Z'})
  assert.equal((await read(id)).latestEligibleRunId,sameDay)
  assert.equal((await read(id)).isStale,true)
})

contractTest('approve exige revisao por allocation, cria duas frentes e nao inicia operacao',async()=>{
  const id=await generate()
  await reject(()=>approve(id),/REVIEW_PENDING/)
  const unknown=(await allocations(id)).find(a=>a.product_id===productB)
  await reject(()=>query('select public.market_update_replenishment_order_item_quantity($1,$2,$3,8)',[account,id,unknown.order_item_id]),/ALLOCATION_REVIEW_REQUIRED/)
  await query('select public.market_update_replenishment_allocation_review($1,$2,$3,1,0)',[account,id,unknown.id])
  const req=request()
  await approve(id,req)
  await approve(id,req)
  const data=await read(id)
  assert.equal(data.order.status,'approved')
  assert.equal(data.approvalRevision,1)
  assert.equal(data.startedAt,null)
  assert.equal(data.canReopen,true)
  assert.equal(data.warehouse.totalTarget,11)
  assert.equal(data.purchase.totalTarget,11)
  assert.equal(data.warehouse.totalConfirmed,0)
  assert.equal(data.purchase.status,'pending')
  const split=(await allocations(id)).find(a=>a.product_id===productA && a.store_id===storeA)
  const lines=await query('select operation_type,target_quantity from public.market_replenishment_operation_lines where allocation_id=$1 order by operation_type',[split.id])
  assert.deepEqual(lines.map(l=>[l.operation_type,Number(l.target_quantity)]),[['purchase',3],['warehouse',5]])
  assert.equal((await query("select count(*)::int n from public.market_replenishment_order_events where order_id=$1 and event_type='ORDER_APPROVED'",[id]))[0].n,1)
  await reject(()=>reopen(id,req),/REQUEST_CONFLICT/)
})

contractTest('reopen preserva metas anteriores; nova aprovacao incrementa revision',async()=>{
  const id=await prepared();await approve(id)
  const old=await query('select * from public.market_replenishment_operation_lines where order_id=$1',[id])
  const req=request();await reopen(id,req);await reopen(id,req)
  let data=await read(id)
  assert.equal(data.order.status,'draft');assert.equal(data.approvalRevision,1)
  assert.equal(data.warehouse.status,'not_applicable')
  assert.equal((await query('select approved_at,approved_by from public.market_replenishment_orders where id=$1',[id]))[0].approved_at,null)
  await approve(id)
  data=await read(id);assert.equal(data.approvalRevision,2)
  assert.deepEqual(await query('select * from public.market_replenishment_operation_lines where order_id=$1 and approval_revision=1',[id]),old)
  await reject(()=>query('update public.market_replenishment_operation_lines set target_quantity=target_quantity+1 where id=$1',[old[0].id]),/TARGET_IMMUTABLE/)
  await reject(()=>query('delete from public.market_replenishment_operation_lines where id=$1',[old[0].id]),/HISTORY_IMMUTABLE/)
})

contractTest('inicio simulado bloqueia reopen/cancel/supersede e retorno para draft',async()=>{
  const id=await prepared();await approve(id);await startSimulated(id);await newer()
  const data=await read(id)
  assert.equal(data.order.status,'in_progress');assert.equal(data.canReopen,false);assert.equal(data.canSupersede,false)
  await reject(()=>reopen(id),/NOT_APPROVED/)
  await reject(()=>supersede(id),/CANNOT_SUPERSEDE/)
  await reject(()=>query("select public.market_cancel_replenishment_order($1,$2,'desistiu')",[account,id]),/CANNOT_CANCEL/)
  await reject(()=>query("update public.market_replenishment_orders set status='draft',approved_at=null where id=$1",[id]),/INVALID_TRANSITION/)
  await reject(()=>query('update public.market_replenishment_orders set started_at=null where id=$1',[id]),/START_IMMUTABLE/)
  assert.equal(await generate(),id)
})

contractTest('evidencia em evento impede reabertura mesmo sem started_at no cabecalho',async()=>{
  const id=await prepared();await approve(id)
  await query("select public.market_replenishment_emit_event_internal($1,$2,'PURCHASE_STARTED',$3,null,null,null,null,'{}')",[account,id,request()])
  await reject(()=>reopen(id),/ALREADY_STARTED/)
  assert.equal((await read(id)).canReopen,false)
})

contractTest('supersede cria nova antes de cancelar antiga, registra vinculo e e idempotente',async()=>{
  const id=await generate();await approve(id);const latest=await newer()
  await query(`insert into public.market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity)
    values($1,$2,$3,$4,'2026-09-11','medium',2,null)`,[latest,account,storeB,productB])
  const req=request();const next=await supersede(id,req)
  assert.notEqual(next,id);assert.equal(await supersede(id,req),next)
  const old=await read(id);const current=await read(next)
  assert.equal(old.order.status,'cancelled');assert.equal(current.order.status,'draft');assert.equal(current.sourceRunId,latest)
  assert.equal(current.items.some(item=>item.productId===productB),false)
  assert.equal(current.items.some(item=>item.totalSuggestedQuantity===null),false)
  assert.equal((await query('select count(*)::int n from public.market_replenishment_order_allocations a join public.market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 and i.product_id=$2',[next,productB]))[0].n,0)
  assert.equal(await generate(),next)
  const event=(await query("select * from public.market_replenishment_order_events where order_id=$1 and event_type='ORDER_SUPERSEDED'",[id]))[0]
  assert.equal(event.related_order_id,next);assert.equal(event.actor_user_id,actor)
  const created=(await query("select sequence from public.market_replenishment_order_events where order_id=$1 and event_type='ORDER_CREATED'",[next]))[0]
  assert.ok(Number(created.sequence)<Number(event.sequence))
  await reject(()=>reopen(id),/NOT_APPROVED/)
})

contractTest('supersede sem candidatos e com falha de materializacao preserva antiga e eventos',async()=>{
  const id=await prepared();const latest=await newer(false)
  await reject(()=>supersede(id),/CANNOT_SUPERSEDE/)
  assert.equal((await read(id)).order.status,'draft')
  await query(`insert into public.market_replenishment_candidates(run_id,market_account_id,store_id,product_id,reference_date,priority_level,rank_position,suggested_quantity)
    values($1,$2,$3,$4,'2026-09-11','high',1,3)`,[latest,account,storeA,productC])
  // Forca falha real depois de inserir o novo cabecalho: snapshot negativo viola constraint existente.
  await query("insert into public.market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity) values($1,$2,$3,'INVENTORY','OUT',1)",[account,warehouseA,productC])
  await reject(()=>supersede(id),/warehouse_stock_check/)
  assert.equal((await read(id)).order.status,'draft')
  assert.equal((await query('select count(*)::int n from public.market_replenishment_orders'))[0].n,1)
  assert.equal((await query("select count(*)::int n from public.market_replenishment_order_events where event_type='ORDER_SUPERSEDED'"))[0].n,0)
})

contractTest('order ativa unica por conta e run de origem imutavel',async()=>{
  const id=await prepared();const latest=await newer()
  await reject(async()=>{
    await query('insert into public.market_replenishment_orders(market_account_id,run_id) values($1,$2)',[account,latest])
    await db.exec('set constraints all immediate')
  },/ACTIVE_CONFLICT/)
  await reject(()=>query('update public.market_replenishment_orders set run_id=$2 where id=$1',[id,latest]),/SOURCE_IMMUTABLE/)
})

contractTest('nenhuma frente aplicavel e item sem destino bloqueiam aprovacao',async()=>{
  const id=await prepared()
  for(const a of await allocations(id)) await query('select public.market_update_replenishment_allocation_review($1,$2,$3,0,0)',[account,id,a.id])
  await reject(()=>approve(id),/NO_OPERATION/)
  await query("insert into public.market_replenishment_order_items(order_id,market_account_id,product_id,source) values($1,$2,$3,'manual_review')",[id,account,productD])
  await reject(()=>approve(id),/ALLOCATION_REQUIRED/)
})

contractTest('uma frente inexistente nao bloqueia completion; separacao nao conclui warehouse',async()=>{
  const id=await prepared()
  for(const a of await allocations(id)) await query('select public.market_update_replenishment_allocation_review($1,$2,$3,0,2)',[account,id,a.id])
  await approve(id)
  assert.equal((await read(id)).warehouse.status,'not_applicable')
  assert.equal((await query('select public.market_complete_replenishment_order_internal($1,$2,$3) done',[account,id,request()]))[0].done,false)
  await startSimulated(id)
  assert.equal((await query('select public.market_complete_replenishment_order_internal($1,$2,$3) done',[account,id,request()]))[0].done,false)
  await query('update public.market_replenishment_operation_lines set confirmed_quantity=target_quantity,started_at=coalesce(started_at,now()),completed_at=now(),completed_by=$2 where order_id=$1',[id,actor])
  const completionRequest=request()
  await query("select public.market_replenishment_emit_event_internal($1,$2,'PURCHASE_COMPLETED',$3,null,null,null,null,'{}')",[account,id,completionRequest])
  assert.equal((await query('select public.market_complete_replenishment_order_internal($1,$2,$3) done',[account,id,completionRequest]))[0].done,true)
  assert.deepEqual((await query('select request_ordinal from public.market_replenishment_order_events where request_id=$1 order by request_ordinal',[completionRequest])).map(e=>e.request_ordinal),[1,2])
  assert.equal((await read(id)).order.status,'completed')
  await reject(()=>reopen(id),/NOT_APPROVED/)
  assert.equal((await query("select count(*)::int n from public.market_replenishment_order_events where order_id=$1 and event_type='ORDER_COMPLETED'",[id]))[0].n,1)
})

contractTest('ambas frentes precisam concluir; evento de separacao nao equivale recebimento',async()=>{
  const id=await prepared();await approve(id);await startSimulated(id)
  await query("update public.market_replenishment_operation_lines set confirmed_quantity=target_quantity,started_at=coalesce(started_at,now()),completed_at=now() where order_id=$1 and operation_type='purchase'",[id])
  await query("select public.market_replenishment_emit_event_internal($1,$2,'WAREHOUSE_SEPARATION_COMPLETED',$3,null,null,null,null,'{}')",[account,id,request()])
  assert.equal((await query('select public.market_complete_replenishment_order_internal($1,$2,$3) done',[account,id,request()]))[0].done,false)
})

contractTest('eventos append-only, atores do servidor e helpers sem acesso de cliente',async()=>{
  const id=await prepared();await approve(id)
  const event=(await query('select * from public.market_replenishment_order_events where order_id=$1 order by sequence limit 1',[id]))[0]
  assert.equal(event.actor_user_id,actor);assert.equal(event.actor_kind,'user')
  await reject(()=>query("update public.market_replenishment_order_events set metadata='{}' where id=$1",[event.id]),/APPEND_ONLY/)
  await reject(()=>query('delete from public.market_replenishment_order_events where id=$1',[event.id]),/APPEND_ONLY/)
  const privileges=(await query(`select
    has_function_privilege('authenticated','public.market_complete_replenishment_order_internal(uuid,uuid,uuid)','execute') helper,
    has_table_privilege('authenticated','public.market_replenishment_order_events','insert') event_write,
    has_table_privilege('service_role','public.market_replenishment_operation_lines','update') line_write`))[0]
  assert.deepEqual(privileges,{helper:false,event_write:false,line_write:false})
  await reject(()=>query('select public.market_get_replenishment_order($1,$2)',[otherAccount,id]),/PERMISSION_DENIED/)
  await query("update public.market_account_members set all_stores=false where market_account_id=$1",[account])
  await reject(()=>reopen(id),/PERMISSION_DENIED/)
})

contractTest('cancelamento exige motivo, conserva historico e nao reabre',async()=>{
  const id=await prepared();const req=request()
  await reject(()=>query("select public.market_cancel_replenishment_order($1,$2,'')",[account,id]),/REASON_REQUIRED/)
  await query("select public.market_cancel_replenishment_order($1,$2,'desistiu',$3)",[account,id,req])
  await query("select public.market_cancel_replenishment_order($1,$2,'desistiu',$3)",[account,id,req])
  await reject(()=>query("select public.market_cancel_replenishment_order($1,$2,'outro',$3)",[account,id,req]),/REQUEST_CONFLICT/)
  assert.equal((await read(id)).order.status,'cancelled')
  await reject(()=>query("update public.market_replenishment_orders set status='draft',cancelled_at=null,cancellation_reason=null where id=$1",[id]),/INVALID_TRANSITION/)
})

contractTest('RPC autenticada e constraint triggers diferidos funcionam sem expor helpers',async()=>{
  const id=await prepared()
  await db.exec('grant usage on schema public,auth to authenticated; grant select on public.market_account_members,public.market_stores,public.market_accounts,public.market_replenishment_order_allocations to authenticated')
  await db.exec('set local role authenticated')
  try {
    await approve(id)
    await db.exec('set constraints all immediate')
    assert.equal((await read(id)).order.status,'approved')
    await reject(()=>query('select public.market_complete_replenishment_order_internal($1,$2,$3)',[account,id,request()]),/permission denied/)
    assert.equal((await query('select count(*)::int n from public.market_replenishment_order_events where order_id=$1',[id]))[0].n,2)
    assert.equal((await query('select count(*)::int n from public.market_replenishment_operation_lines where order_id=$1',[id]))[0].n,6)
  } finally { await db.exec('reset role').catch(() => {}) }
})

contractTest('checagem previa bloqueia dados aprovados sem converter nem alterar',async()=>{
  const id=await prepared();await approve(id)
  const migration=sqlFile('202609120003_replenishment_order_status_events_contract.sql')
  const preflight=migration.slice(migration.indexOf('do $$'),migration.indexOf('alter table public.market_replenishment_orders'))
  await reject(()=>db.exec(preflight),/REPLENISHMENT_CONTRACT_PREFLIGHT/)
  assert.equal((await read(id)).order.status,'approved')
})

contractTest('inicio sem evidencia e completion prematura sao rejeitados no fechamento',async()=>{
  const id=await prepared();await approve(id)
  await reject(async()=>{
    await query("update public.market_replenishment_orders set status='in_progress',started_at=now() where id=$1",[id])
    await db.exec('set constraints all immediate')
  },/EXECUTION_REQUIRED/)
  await startSimulated(id)
  await reject(async()=>{
    await query("update public.market_replenishment_orders set status='completed',completed_at=now() where id=$1",[id])
    await db.exec('set constraints all immediate')
  },/INCOMPLETE/)
})

contractTest('allocation nao pode mudar destino ou planejamento depois de aprovada',async()=>{
  const id=await prepared();const a=(await allocations(id))[0];await approve(id)
  await reject(()=>query('update public.market_replenishment_order_allocations set purchase_needed_quantity=purchase_needed_quantity+1 where id=$1',[a.id]),/NOT_DRAFT/)
  await reject(()=>query('update public.market_replenishment_order_allocations set store_id=$2 where id=$1',[a.id,warehouseA]),/IDENTITY_IMMUTABLE/)
  const line=(await query('select * from public.market_replenishment_operation_lines where order_id=$1 limit 1',[id]))[0]
  await reject(()=>query('insert into public.market_replenishment_operation_lines(market_account_id,order_id,allocation_id,approval_revision,operation_type,target_quantity) values($1,$2,$3,1,$4,0.5)',[account,id,line.allocation_id,'purchase']),/check constraint|duplicate key/)
})
