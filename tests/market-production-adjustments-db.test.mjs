import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'

// Entire Market migration chain, with only Supabase auth/platform scaffolding
// and pgcrypto extension installation omitted (gen_random_uuid is built in).
const db = new PGlite()
const dir = new URL('../supabase/migrations/', import.meta.url)
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema auth;
  create table auth.users(id uuid primary key, email text);
  create table public.profiles(id uuid primary key, full_name text);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
  create function public.is_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'')='yes'$$;
  create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now(); return new; end$$;
  grant usage on schema auth, public to authenticated, anon, service_role;
`)
for (const name of readdirSync(dir).sort().filter(n => n >= '202608310001' && n.endsWith('.sql'))) {
  if (/admin_users_business_members|add_profile_last_access/.test(name)) continue
  let sql = readFileSync(new URL(name, dir), 'utf8').replace(/create extension if not exists pgcrypto;/g, '')
  try { await db.exec(sql) } catch (error) { throw new Error(`Migration fixture ${name}: ${error.message}`) }
}
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const actor = uuid(1)
let serial = 100
await db.query('insert into auth.users(id) values($1)', [actor])
const query = async (sql, args=[]) => (await db.query(sql,args)).rows
async function tenant() {
  const id=uuid(serial++)
  await query("insert into market_accounts(id,name) values($1,'Teste')",[id])
  return id
}
async function integration(account) {
  const id=uuid(serial++)
  await query("insert into market_integrations(id,market_account_id,provider,base_url,external_company_id,status) values($1::uuid,$2,'accesys','https://example.com',$1::text,'active')",[id,account])
  return id
}
async function store(account,code='2250',type='store') {
  const id=uuid(serial++)
  await query("insert into market_stores(id,market_account_id,name,external_code,store_type) values($1,$2,'Loja',$3,$4)",[id,account,code,type])
  return id
}
const refs = (account) => query('select * from market_store_external_refs where market_account_id=$1 order by external_store_id',[account])
async function asAdmin(admin=true) {
  await db.exec('reset role')
  await query("select set_config('test.user',$1,false),set_config('test.admin',$2,false)",[actor,admin?'yes':'no'])
  await db.exec('set role authenticated')
}
const canDelete = async account => (await query('select admin_market_account_can_delete($1) result',[account]))[0].result
const remove = (account,name='Teste') => query('select admin_delete_empty_market_account($1,$2)',[account,name])
test.beforeEach(()=>db.exec('reset role'))
test.after(()=>db.close())

test('2250 maps on create, reprocessing is idempotent and code changes retire old refs',async()=>{
  const a=await tenant(),i=await integration(a),s=await store(a)
  let r=await refs(a); assert.equal(r.length,1); assert.equal(r[0].integration_id,i); assert.equal(r[0].is_active,true)
  await query("update market_stores set external_code='2250' where id=$1",[s])
  assert.equal((await refs(a)).length,1)
  await query("update market_stores set external_code='2251' where id=$1",[s])
  r=await refs(a); assert.deepEqual(r.map(x=>[x.external_store_id,x.is_active]),[['2250',false],['2251',true]])
  await query("update market_stores set external_code='2250' where id=$1",[s])
  r=await refs(a); assert.equal(r.length,2); assert.equal(r[0].is_active,true)
})

test('warehouse/blank/inactive have no active mapping; reactivation restores same identity',async()=>{
  const a=await tenant();await integration(a)
  await store(a,'warehouse','warehouse'); await store(a,null); await store(a,'  ')
  assert.equal((await refs(a)).length,0)
  const s=await store(a),id=(await refs(a))[0].id
  for(const mutation of ["status='inactive'","external_code=null","store_type='warehouse'"]) {
    await query(`update market_stores set ${mutation} where id=$1`,[s])
    assert.equal((await refs(a)).filter(x=>x.is_active).length,0)
    await query("update market_stores set external_code='2250',status='active',store_type='store' where id=$1",[s])
    assert.equal((await refs(a))[0].id,id); assert.equal((await refs(a))[0].is_active,true)
  }
})

test('integration created after stores materializes refs; tenants and integrations stay isolated',async()=>{
  const a=await tenant(),b=await tenant();await store(a);await store(b)
  assert.equal((await refs(a)).length,0)
  const i=await integration(a),j=await integration(a),k=await integration(b)
  assert.deepEqual(new Set((await refs(a)).map(x=>x.integration_id)),new Set([i,j]))
  assert.equal((await refs(b))[0].integration_id,k)
  await query("update market_integrations set status='active' where id=$1",[i])
  assert.equal((await refs(a)).length,2)
})

test('mapping collision rolls back store save and preserves historical owner',async()=>{
  const a=await tenant();await integration(a); const first=await store(a)
  await query("update market_stores set external_code='2251' where id=$1",[first])
  await assert.rejects(()=>store(a),/STORE_MAPPING_CONFLICT/)
  assert.equal((await query('select * from market_stores where market_account_id=$1',[a])).length,1)
  assert.equal((await refs(a))[0].market_store_id,first)
  const second=await store(a,'2252')
  await assert.rejects(()=>query("update market_stores set external_code='2250' where id=$1",[second]),/STORE_MAPPING_CONFLICT/)
  assert.equal((await query('select external_code from market_stores where id=$1',[second]))[0].external_code,'2252')
  assert.equal((await refs(a)).find(r=>r.external_store_id==='2252').is_active,true)
})

test('integration creation rolls back entirely if legacy store codes conflict after normalization',async()=>{
  const a=await tenant();await store(a,'2250');await store(a,' 2250 ')
  await assert.rejects(()=>integration(a),/STORE_MAPPING_CONFLICT/)
  assert.equal((await refs(a)).length,0)
  assert.equal((await query('select * from market_integrations where market_account_id=$1',[a])).length,0)
})

test('administrative account deletes atomically, preserves users and another tenant',async()=>{
  const a=await tenant(),b=await tenant(),s=await store(a),i=await integration(a)
  const m=uuid(serial++)
  await query("insert into market_account_members(id,market_account_id,user_id,role) values($1,$2,$3,'owner')",[m,a,actor])
  await query('insert into market_member_stores(market_account_member_id,market_store_id) values($1,$2)',[m,s])
  await query("insert into market_integration_credentials(integration_id,market_account_id,username,password_ciphertext,encryption_version) values($1,$2,'test',decode('01','hex'),1)",[i,a])
  await query('insert into market_replenishment_settings(market_account_id) values($1)',[a])
  await asAdmin(); assert.equal(await canDelete(a),true);await remove(a)
  await db.exec('reset role')
  assert.equal((await query('select * from market_accounts where id=$1',[a])).length,0)
  assert.equal((await query('select * from market_accounts where id=$1',[b])).length,1)
  assert.equal((await query('select * from auth.users where id=$1',[actor])).length,1)
  assert.equal((await refs(a)).length,0)
})

test('confirmation, anonymous and non-platform admin cannot delete; generic DELETE is revoked',async()=>{
  const a=await tenant();await asAdmin(false)
  await assert.rejects(()=>remove(a),/Acesso negado/)
  await assert.rejects(()=>canDelete(a),/Acesso negado/)
  await asAdmin(); await assert.rejects(()=>remove(a,'Wrong'),/MARKET_CONFIRMATION_REQUIRED/)
  await assert.rejects(()=>query('delete from market_accounts where id=$1',[a]),/permission denied/)
  await db.exec('reset role; set role anon')
  await assert.rejects(()=>remove(a),/permission denied/)
})

test('catalog, draft import and stock milestone block deletion without partial changes',async()=>{
  for(const kind of ['product','import','milestone']) {
    const a=await tenant(),s=await store(a);await integration(a)
    if(kind==='product') await query("insert into market_products(market_account_id,name) values($1,'Produto')",[a])
    if(kind==='import') await query("insert into market_sales_imports(market_account_id,file_name) values($1,'test.csv')",[a])
    if(kind==='milestone') await query('update market_stores set stock_control_started_at=now() where id=$1',[s])
    const before=await refs(a)
    await asAdmin();assert.equal(await canDelete(a),false);await assert.rejects(()=>remove(a),/MARKET_NOT_EMPTY/)
    await db.exec('reset role');assert.deepEqual(await refs(a),before)
    assert.equal((await query('select * from market_accounts where id=$1',[a])).length,1)
  }
})

test('new tenant table is blocked by default instead of silently cascading its data',async()=>{
  const a=await tenant()
  await db.exec('create table public.market_future_history(market_account_id uuid references market_accounts(id) on delete cascade)')
  await query('insert into market_future_history values($1)',[a])
  await asAdmin(); assert.equal(await canDelete(a),false); await assert.rejects(()=>remove(a),/MARKET_NOT_EMPTY/)
})

test('sales retain old reference and cached inactive mapping cannot persist a new sale',async()=>{
  const a=await tenant(),i=await integration(a),s=await store(a),ref=(await refs(a))[0].id
  const insertSale=()=>query(`insert into market_sales(market_account_id,market_store_id,integration_id,store_external_ref_id,source_type,source_system,external_order_id,sold_at)
    values($1,$2,$3,$4,'api','accesys',$5,now()) returning id`,[a,s,i,ref,String(serial++)])
  const sale=(await insertSale())[0].id
  await query("update market_stores set external_code='2251' where id=$1",[s])
  assert.equal((await query('select store_external_ref_id from market_sales where id=$1',[sale]))[0].store_external_ref_id,ref)
  await assert.rejects(insertSale,/SYNC_STORE_MAPPING_NOT_FOUND/)
  await asAdmin();assert.equal(await canDelete(a),false);await assert.rejects(()=>remove(a),/MARKET_NOT_EMPTY/)
})

for(const kind of ['inventory','purchase','transfer','replenishment','sales_sync','product_sync']) test(`${kind} blocks empty-Market deletion, including unfinished operations`,async()=>{
  const a=await tenant(),s=await store(a),i=await integration(a)
  if(kind==='inventory') await query('insert into market_inventory_sessions(market_account_id,market_store_id,started_at,created_by) values($1,$2,now(),$3)',[a,s,actor])
  if(kind==='purchase') await query('insert into market_purchases(market_account_id,destination_store_id) values($1,$2)',[a,s])
  if(kind==='transfer') {
    const dest=await store(a,'dest')
    await query('insert into market_transfers(market_account_id,source_store_id,destination_store_id) values($1,$2,$3)',[a,s,dest])
  }
  if(kind==='replenishment') await query("insert into market_replenishment_runs(market_account_id,reference_date,algorithm_version) values($1,current_date,'test')",[a])
  if(kind==='sales_sync') await query('insert into market_sales_sync_runs(market_account_id,integration_id,period_start,period_end,next_day,heartbeat_at) values($1,$2,current_date,current_date,current_date,now())',[a,i])
  if(kind==='product_sync') await query("insert into market_product_sync_runs(market_account_id,integration_id,status,source,page_size,heartbeat_at) values($1,$2,'running','admin',10,now())",[a,i])
  const before=await refs(a)
  await asAdmin();assert.equal(await canDelete(a),false);await assert.rejects(()=>remove(a),/MARKET_NOT_EMPTY/)
  await db.exec('reset role');assert.deepEqual(await refs(a),before)
  assert.equal((await query('select * from market_stores where id=$1',[s])).length,1)
})

test('member reactivation and owner protections keep existing RPC semantics',async()=>{
  const a=await tenant(),u=uuid(serial++),owner=uuid(serial++),m=uuid(serial++)
  await query('insert into auth.users(id) values($1)',[u])
  await query("insert into market_account_members(id,market_account_id,user_id,role,status,all_stores) values($1,$2,$3,'owner','active',true),($4,$2,$5,'operator','disabled',true)",[owner,a,actor,m,u])
  await asAdmin()
  await query("select admin_update_market_member_access($1,$2,'operator','active',true,'{}'::uuid[])",[a,m])
  await assert.rejects(()=>query("select admin_update_market_member_access($1,$2,'operator','disabled',true,'{}'::uuid[])",[a,owner]),/propriet.rio n.o pode/)
  await db.exec('reset role');assert.equal((await query('select status from market_account_members where id=$1',[m]))[0].status,'active')
})

test('unexpected dependency without tenant key fails closed, even if CASCADE is configured',async()=>{
  const a=await tenant()
  await db.exec('create table public.future_store_history(store_id uuid references market_stores(id) on delete cascade)')
  await asAdmin();assert.equal(await canDelete(a),false);await assert.rejects(()=>remove(a),/MARKET_NOT_EMPTY/)
  await db.exec('reset role; drop table public.future_store_history')
})

test('a late database failure rolls back all administrative removals',async()=>{
  const a=await tenant(),s=await store(a);await integration(a)
  const before=await refs(a)
  await db.exec(`create function public.test_refuse_delete() returns trigger language plpgsql as $$begin raise exception 'TEST_LATE_FAILURE'; end$$;
    create trigger test_refuse_delete before delete on market_accounts for each row execute function public.test_refuse_delete();`)
  await asAdmin();assert.equal(await canDelete(a),true);await assert.rejects(()=>remove(a),/TEST_LATE_FAILURE/)
  await db.exec('reset role; drop trigger test_refuse_delete on market_accounts; drop function test_refuse_delete()')
  assert.deepEqual(await refs(a),before)
  assert.equal((await query('select * from market_stores where id=$1',[s])).length,1)
})

test('authenticated platform Admin can save stores with private triggers; refs cannot be edited separately',async()=>{
  const a=await tenant();await integration(a)
  // Supabase default table grants are not installed in embedded PostgreSQL.
  await db.exec('grant select,insert,update on market_stores to authenticated')
  await asAdmin();const s=await store(a)
  await assert.rejects(()=>query('update market_store_external_refs set is_active=false where market_store_id=$1',[s]),/permission denied/)
  await db.exec('reset role');assert.equal((await refs(a))[0].is_active,true)
  const helpers=await query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='market_private' and (has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE'))`)
  assert.deepEqual(helpers,[])
})
