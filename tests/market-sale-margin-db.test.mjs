import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
const db=new PGlite()
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const account=uuid(1),other=uuid(2),store=uuid(10),storeB=uuid(11),warehouse=uuid(12),user=uuid(20),integration=uuid(30)
await db.exec(`
 create role anon; create role authenticated;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
 create function public.market_has_role(a uuid, roles text[]) returns boolean language sql stable as $$select a::text=current_setting('test.account',true) and current_setting('test.role',true)=any(roles)$$;
 create function public.market_can_access_store(s uuid) returns boolean language sql stable as $$select s::text=any(string_to_array(current_setting('test.stores',true),','))$$;
 create table market_accounts(id uuid primary key,status text);
 create table market_stores(id uuid primary key,market_account_id uuid,store_type text,status text);
 create table market_products(id uuid primary key,market_account_id uuid,name text,ean text,sku text);
 create table market_store_products(market_account_id uuid,market_store_id uuid,product_id uuid,minimum_margin_pct numeric);
 create table market_integrations(id uuid primary key,market_account_id uuid,provider text);
 create table market_sales(id uuid primary key,market_account_id uuid,market_store_id uuid,source_system text,is_refunded boolean,has_error boolean,sold_at timestamptz);
 create table market_sale_items(id uuid primary key,market_account_id uuid,sale_id uuid,product_id uuid,sale_price numeric,unit_price numeric,external_product_id text);
 create table market_product_store_data(id uuid primary key,market_account_id uuid,market_store_id uuid,product_id uuid,integration_id uuid,current_cost numeric,current_sale_price numeric,external_product_id text,source_synced_at timestamptz,updated_at timestamptz);
 create table market_purchases(id uuid primary key,market_account_id uuid,destination_store_id uuid,status text,issued_at timestamptz,supplier_name text,invoice_number text);
 create table market_purchase_items(id uuid primary key,market_account_id uuid,market_purchase_id uuid,market_product_id uuid,stock_entry_status text,stock_unit_cost numeric,calculated_unit_cost numeric,received_at timestamptz,stock_quantity numeric,stock_unit text,reconciliation_status text);
 create table market_stock_movements(id uuid primary key,market_account_id uuid,market_store_id uuid,product_id uuid,movement_type text,direction text,reference_type text,reference_id uuid,reference_item_id uuid,quantity numeric,unit_cost numeric,occurred_at timestamptz);
 insert into market_accounts values('${account}','active'),('${other}','active');
 insert into market_stores values('${store}','${account}','store','active'),('${storeB}','${account}','store','active'),('${warehouse}','${account}','warehouse','active'),('${uuid(13)}','${other}','store','active');
 insert into market_integrations values('${integration}','${account}','accesys'),('${uuid(31)}','${other}','accesys'),('${uuid(32)}','${account}','other');
`)
await db.exec(readFileSync('supabase/migrations/20260918150449_add_market_sale_margin_analysis.sql','utf8'))
await db.exec(readFileSync('supabase/migrations/20260918150450_fix_sale_margin_sale_price_source.sql','utf8'))
let serial=1000
async function session(role='manager',stores=[store,storeB,warehouse,uuid(13)],actor=user){
 await db.query("select set_config('test.user',$1,false),set_config('test.account',$2,false),set_config('test.role',$3,false),set_config('test.stores',$4,false)",[actor,account,role,stores.join(',')])
}
async function product({cost=8,price=10,target=25,shop=store}={}){
 const id=uuid(serial++)
 await db.query('insert into market_products values($1,$2,$3,$4,$5)',[id,account,`Produto ${id}`,'000123','001'])
 await db.query('insert into market_store_products values($1,$2,$3,$4)',[account,shop,id,target])
 await data(id,shop,cost,price)
 await sale(id,shop,price)
 return id
}
async function data(id,shop,cost,price,date='2026-09-18',source=integration){
 await db.query('insert into market_product_store_data values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[uuid(serial++),account,shop,id,source,cost,price,'EXT1',date])
}
async function sale(id,shop,price,{date='2026-09-18',source='accesys',refunded=false,error=false,unitPrice=null,tenant=account}={}){
 const saleId=uuid(serial++)
 await db.query('insert into market_sales values($1,$2,$3,$4,$5,$6,$7)',[saleId,tenant,shop,source,refunded,error,date])
 await db.query('insert into market_sale_items values($1,$2,$3,$4,$5,$6,$7)',[uuid(serial++),tenant,saleId,id,price,unitPrice,'EXT1'])
}
async function receipt(id,{cost=9,stockCost=cost,issued='2026-09-16',received='2026-09-17',status='completed',itemStatus='received',move=true,moveType='PURCHASE',direction='IN',tenant=account,shop=warehouse}={}){
 const purchase=uuid(serial++),item=uuid(serial++)
 await db.query('insert into market_purchases values($1,$2,$3,$4,$5,$6,$7)',[purchase,tenant,shop,status,issued,'Fornecedor','123'])
 await db.query('insert into market_purchase_items values($1,$2,$3,$4,$5,$6,999,$7,2,$8,$9)',[item,tenant,purchase,id,itemStatus,stockCost,received,'UN','matched_manual'])
 if(move)await db.query('insert into market_stock_movements values($1,$2,$3,$4,$5,$6,$7,$8,$9,2,$10,$11)',[uuid(serial++),tenant,shop,id,moveType,direction,'PURCHASE',purchase,item,cost,received])
 return {purchase,item}
}
async function rows(shop=store,tenant=account){
 const result=await db.query('select public.market_get_sale_margin_analysis($1,$2) as result',[tenant,shop])
 return result.rows[0].result
}
async function clean(){await db.exec('reset role; truncate market_sale_items,market_sales,market_stock_movements,market_purchase_items,market_purchases,market_product_store_data,market_store_products,market_products;');await session()}
test.beforeEach(clean)
test.after(()=>db.close())

test('prioriza custo recebido convertido do Market mesmo sem acesso ao galpao; parcial vale',async()=>{
 const id=await product({cost:5});await receipt(id,{cost:8,stockCost:8,status:'receiving'})
 await session('manager',[store]);await db.exec('set role authenticated')
 const [r]=await rows();assert.equal(r.cost,8);assert.equal(r.cost_source,'COMPRA GIROMICRO')
 assert.equal(r.current_margin_pct,20);assert.equal(r.desired_margin_pct,25);assert.equal(r.difference_pp,5)
 assert.equal(r.invoice_number,'123');assert.equal(r.supplier_name,'Fornecedor')
})
test('custo do movimento prevalece; stock_unit_cost e fallback, nunca calculated_unit_cost',async()=>{
 const id=await product();await receipt(id,{cost:9,stockCost:8});assert.equal((await rows())[0].cost,9)
 await db.exec('truncate market_stock_movements,market_purchase_items,market_purchases')
 await receipt(id,{cost:null,stockCost:8});assert.equal((await rows())[0].cost,8)
})
test('ultima compra valida segue emissao; recebimento desempata, nao data de importacao',async()=>{
 const id=await product();await receipt(id,{cost:8,issued:'2026-09-16',received:'2026-09-18'})
 await receipt(id,{cost:9,issued:'2026-09-17',received:'2026-09-17'})
 assert.equal((await rows())[0].cost,9)
 await receipt(id,{cost:9.5,issued:'2026-09-17',received:'2026-09-18'})
 assert.equal((await rows())[0].cost,9.5)
 await receipt(id,{cost:0,issued:'2026-09-19',received:'2026-09-19'})
 assert.equal((await rows())[0].cost,9.5)
})
test('sem compra valida usa custo Accesys da loja; descarta pendente, cancelada e sem movimento',async()=>{
 const id=await product();await receipt(id,{cost:9,itemStatus:'pending'})
 await receipt(id,{cost:9,status:'cancelled'});await receipt(id,{cost:9,move:false})
 await receipt(id,{cost:9,direction:'OUT'});await receipt(id,{cost:9,tenant:other})
 const [r]=await rows();assert.equal(r.cost,8);assert.equal(r.cost_source,'ACCESYS');assert.equal(r.purchase_date,null)
})
test('falta meta/preco/custo e valores zero/invalidos excluem; meta zero e margem negativa valem',async()=>{
 await product({target:null});await product({price:null});await product({price:0});await product({cost:null});await product({cost:0})
 await product({cost:'NaN'});await product({price:'NaN'});await product({price:'Infinity'})
 const id=await product({cost:11,target:0});const result=await rows();assert.equal(result.length,1);assert.equal(result[0].product_id,id);assert.equal(result[0].current_margin_pct,-10)
})
test('dentro/acima da meta exclui; compara sem arredondar',async()=>{
 await product({cost:7.5});await product({cost:7});const id=await product({cost:7.50001})
 const result=await rows();assert.equal(result.length,1);assert.equal(result[0].product_id,id);assert.ok(result[0].difference_pp>0)
})
test('preco/meta isolados por loja; custo recebido e compartilhado no Market',async()=>{
 const id=await product({cost:8,price:10,target:25});await receipt(id,{cost:9})
 await db.query('insert into market_store_products values($1,$2,$3,15)',[account,storeB,id]);await data(id,storeB,1,20)
 await sale(id,storeB,20)
 assert.equal((await rows()).length,1);assert.equal((await rows(storeB)).length,0)
 await db.query('update market_store_products set minimum_margin_pct=60 where market_store_id=$1',[storeB])
 const [b]=await rows(storeB);assert.equal(b.cost,9);assert.equal(b.sale_price,20);assert.equal(b.desired_margin_pct,60);assert.equal(b.difference_pp,5)
})
test('fallback de custo usa registro Accesys local, preco vem da ultima venda valida',async()=>{
 const id=await product();await data(id,store,9,10,'2026-09-19',uuid(32));assert.equal((await rows())[0].cost,8)
 await data(id,store,8,0,'2026-09-20');assert.equal((await rows())[0].sale_price,10)
 await sale(id,store,9,{date:'2026-09-19'})
 for(const options of [{refunded:true},{error:true},{source:'other'},{tenant:other}])await sale(id,store,1,{date:'2026-09-20',...options})
 await sale(id,store,0,{date:'2026-09-21'});await sale(id,store,null,{date:'2026-09-21'})
 await sale(id,storeB,1,{date:'2026-09-22'})
 assert.equal((await rows())[0].sale_price,9)
 await sale(id,store,null,{date:'2026-09-23',unitPrice:9.5})
 assert.equal((await rows())[0].sale_price,9.5)
 await db.exec('truncate market_sale_items,market_sales');assert.equal((await rows()).length,0)
})
test('reproduz smoke Vitality: custo 8,99 e venda 10,66 resultam 15,67% e 4,33 pp',async()=>{
 const id=await product({price:10.66,target:20,cost:null})
 const {purchase}=await receipt(id,{cost:8.99,issued:'2026-09-04'})
 await db.query('update market_purchases set supplier_name=$1,invoice_number=$2 where id=$3',['SENDAS DISTRIBUIDORA S/A','49231',purchase])
 const [r]=await rows();assert.equal(r.cost,8.99);assert.equal(r.cost_source,'COMPRA GIROMICRO')
 assert.equal(r.sale_price,10.66);assert.equal(r.current_margin_pct.toFixed(2),'15.67');assert.equal(r.difference_pp.toFixed(2),'4.33')
 assert.equal(r.supplier_name,'SENDAS DISTRIBUIDORA S/A');assert.equal(r.invoice_number,'49231')
 assert.match(r.purchase_date,/^2026-09-04/)
})
test('retorna todas excecoes ordenadas por desvio, sem truncamento de 20 para Excel',async()=>{
 for(let n=0;n<25;n++)await product({cost:8+n/100})
 const result=await rows();assert.equal(result.length,25)
 for(let n=1;n<result.length;n++)assert.ok(result[n-1].difference_pp>=result[n].difference_pp)
})
test('nega anonimo/viewer, outra conta, loja sem acesso e warehouse; permite owner/admin/manager/operator',async()=>{
 await product()
 for(const role of ['owner','admin','manager','operator']){await session(role);assert.equal((await rows()).length,1)}
 await session('viewer');await assert.rejects(rows(),/SALE_MARGIN_ACCESS_DENIED/)
 await session('manager',[storeB]);await assert.rejects(rows(),/SALE_MARGIN_ACCESS_DENIED/)
 await session();await assert.rejects(rows(warehouse),/SALE_MARGIN_ACCESS_DENIED/);await assert.rejects(rows(uuid(13),other),/SALE_MARGIN_ACCESS_DENIED/)
 await session('manager',[store],'');await assert.rejects(rows(),/SALE_MARGIN_ACCESS_DENIED/)
 await session();await db.exec('set role anon');await assert.rejects(rows(),/permission denied/)
})
