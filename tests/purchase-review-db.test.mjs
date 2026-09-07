// PostgreSQL embarcado, totalmente local. Dependência opcional de testes: ver README.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
registerHooks({ resolve(s,c,n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s,c) } })
const { extractPurchaseOcrDocumentFromPdfTextItems: parse } = await import('../src/utils/purchaseOcrExtraction.ts')
const { pdfStagingDocument } = await import('../src/utils/purchaseReview.ts')

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8')
const db = new PGlite()
const account='10000000-0000-4000-8000-000000000001', other='10000000-0000-4000-8000-000000000002'
const store='20000000-0000-4000-8000-000000000001', otherStore='20000000-0000-4000-8000-000000000002'
const product='30000000-0000-4000-8000-000000000001', product2='30000000-0000-4000-8000-000000000002'
const otherProduct='30000000-0000-4000-8000-000000000003'
const actor='40000000-0000-4000-8000-000000000001'
await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;
  create table market_accounts(id uuid primary key,status text);
  create table market_stores(id uuid primary key,market_account_id uuid,status text,store_type text,unique(id,market_account_id));
  create table market_products(id uuid primary key,market_account_id uuid,status text,ean text,sku text,unit text,name text,description text,unique(id,market_account_id));
  create table market_integrations(id uuid primary key,market_account_id uuid,provider text,status text);
  create table market_product_mappings(product_id uuid,market_account_id uuid,integration_id uuid,source_system text,external_is_inactive boolean);
  create function market_has_role(a uuid, roles text[]) returns boolean language sql as $$select a::text=current_setting('test.account') and current_setting('test.profile')=any(roles)$$;
  create function market_is_member(a uuid) returns boolean language sql as $$select a::text=current_setting('test.account')$$;
  create function market_can_access_store(s uuid) returns boolean language sql security definer as $$select exists(select 1 from market_stores where id=s and market_account_id::text=current_setting('test.account')) and current_setting('test.store_access')='yes'$$;
  select set_config('test.account','${account}',false),set_config('test.profile','owner',false),set_config('test.store_access','yes',false);
  insert into auth.users values('${actor}');
  insert into market_accounts values('${account}','active'),('${other}','active');
  insert into market_stores values('${store}','${account}','active','warehouse'),('${otherStore}','${other}','active','warehouse');
  insert into market_products values('${product}','${account}','active','7892840825133','A','UN','Produto A','Produto A'),
    ('${product2}','${account}','active',null,'B','UN','Produto B','Produto B'),
    ('${otherProduct}','${other}','active','7892840825133','C','UN','Outro Market','Outro Market');
  create table market_stock_movements(id integer); create table market_stock_balance(id integer);
  insert into market_stock_movements values(1); insert into market_stock_balance values(1);
`)
const core=sqlFile('202608310001_create_market_multitenant_core.sql')
await db.exec(core.slice(core.indexOf('create table if not exists public.market_purchases ('),core.indexOf('-- 6. IMPORTAÇÃO DE VENDAS')))
await db.exec('alter table market_purchases enable row level security; alter table market_purchase_items enable row level security;')
for (const name of ['202609040001_create_market_purchase_staging_foundation.sql','202609040002_import_market_purchase_staging.sql','202609040003_reimport_purchase_staging.sql','202609040004_purchase_reconciliation.sql','202609040005_purchase_reconciliation_accesys_scope.sql','202609070001_purchase_human_review.sql','202609070002_purchase_unit_conversion.sql','202609070003_fix_purchase_unit_conversion_resolution.sql','202609070004_purchase_ai_text_staging.sql']) await db.exec(sqlFile(name))

const query = async (sql,params=[]) => (await db.query(sql,params)).rows
const values={supplier_product_code:'7892840825133',barcode_raw:'7892840825133',description_raw:'Produto',quantity:15,unit:'UN',unit_price:7.69,gross_amount:115.35,net_amount:115.35,discount_amount:0,freight_amount:0,other_amount:0}
const document=(item=values) => ({header:{supplierName:'Fornecedor',supplierCnpj:'32193036000125',documentNumber:'15915',series:'1',issueDate:'20/07/2026',productsTotal:item.gross_amount,invoiceTotal:item.gross_amount},items:[item]})
const importDoc=async(ref,item=values,a=account,s=store) => (await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[a,s,ref,document(item)]))[0].id
const getItem=async(id) => (await query('select * from market_purchase_items where market_purchase_id=$1',[id]))[0]
const save=async(item,v,confirm=false,a=account) => query('select market_save_purchase_item_review($1,$2,$3,$4,$5)',[a,item.id,v,item.updated_at,confirm])
const saveConversion=async(item,factor,reuse=false,a=account) => query('select market_save_purchase_item_conversion($1,$2,$3,$4,$5)',[a,item.id,factor,item.updated_at,reuse])
let purchase, item
test('PDF persistido: EAN automático preserva original e não confere nem recebe',async()=>{
  purchase=await importDoc('pdf:test:1'); item=await getItem(purchase)
  assert.equal(item.market_product_id,product); assert.equal(item.reconciliation_status,'matched_auto')
  assert.equal(item.reviewed_at,null); assert.equal(item.stock_entry_status,'pending')
  assert.equal(item.original_data.supplier_product_code,values.supplier_product_code)
  assert.equal(item.barcode_normalized,values.barcode_raw)
  assert.equal(await importDoc('pdf:test:1'),purchase)
  await assert.rejects(query('select market_complete_purchase_review($1,$2)',[account,purchase]),/PURCHASE_REVIEW_INCOMPLETE/)
})
test('correção persiste, original não muda e conflito é detectado',async()=>{
  await save(item,{...values,quantity:5,unit_price:23.07})
  const changed=await getItem(purchase)
  assert.equal(Number(changed.quantity),5); assert.equal(changed.original_data.quantity,15)
  assert.equal(changed.reviewed_at,null)
  await assert.rejects(save(item,values),/PURCHASE_REVIEW_CONFLICT/)
  await assert.rejects(query("update market_purchase_items set original_data='{}' where id=$1",[item.id]),/PURCHASE_ORIGINAL_IMMUTABLE/)
  item=changed
})
test('produto pode ser trocado, mapping mantém tenant e fornecedor',async()=>{
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,item.id,product2])
  item=await getItem(purchase)
  assert.equal(item.market_product_id,product2); assert.equal(item.reviewed_at,null)
  const mapping=(await query('select * from market_purchase_product_mappings'))[0]
  assert.equal(mapping.market_account_id,account); assert.equal(mapping.supplier_document,'32193036000125')
  const next=await importDoc('pdf:mapping:1')
  assert.equal((await getItem(next)).reconciliation_status,'mapped')
  assert.equal((await getItem(next)).market_product_id,product2)
})
test('aprovação humana por item e compra, troca posterior invalida ambas',async()=>{
  await save(item,{...values,quantity:5,unit_price:23.07},true)
  item=await getItem(purchase); assert.equal(item.reviewed_by,actor)
  await query('select market_complete_purchase_review($1,$2)',[account,purchase])
  let header=(await query('select * from market_purchases where id=$1',[purchase]))[0]
  assert.equal(header.status,'ready'); assert.equal(header.reviewed_by,actor)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,item.id,product])
  item=await getItem(purchase); assert.equal(item.reviewed_at,null)
  header=(await query('select * from market_purchases where id=$1',[purchase]))[0]
  assert.equal(header.reviewed_at,null); assert.equal(header.status,'reconciling')
})
test('código curto não vira EAN, preço de cinco casas preservado',async()=>{
  const id=await importDoc('pdf:short:1',{...values,supplier_product_code:'1732',barcode_raw:null,quantity:1,unit_price:107.81670,gross_amount:107.82,net_amount:107.82})
  const row=await getItem(id)
  assert.equal(row.barcode_normalized,null); assert.equal(row.supplier_product_code,'1732'); assert.equal(Number(row.unit_price),107.8167)
})
test('GTIN formatado com espaços/pontos/hífens normaliza sem perder o original nem ser rejeitado',async()=>{
  const formatted='7892.8408-2513 3'
  const id=await importDoc('pdf:formatted-gtin:1',{...values,supplier_product_code:formatted,barcode_raw:formatted})
  const row=await getItem(id)
  assert.equal(row.barcode_raw,formatted); assert.equal(row.barcode_normalized,'7892840825133')
  assert.equal(row.market_product_id,product); assert.equal(row.reconciliation_method,'ean_exact')
})
test('isolamento, perfil, loja e escrita REST protegidos',async()=>{
  await assert.rejects(save(item,values,false,other),/RECONCILE_PERMISSION_DENIED/)
  await assert.rejects(query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,item.id,otherProduct]),/RECONCILE_PRODUCT_NOT_FOUND/)
  await db.exec("select set_config('test.profile','viewer',false)")
  await assert.rejects(save(item,values),/RECONCILE_PERMISSION_DENIED/)
  await db.exec("select set_config('test.profile','owner',false),set_config('test.store_access','no',false)")
  await assert.rejects(save(item,values),/RECONCILE_PURCHASE_NOT_ACCESSIBLE/)
  await db.exec("select set_config('test.store_access','yes',false); set role authenticated;")
  await assert.rejects(query('update market_purchase_items set reviewed_at=now(),reviewed_by=$1 where id=$2',[actor,item.id]),/permission denied/)
  await db.exec('reset role')
})
test('outro Market usa seu catálogo EAN, não mapping privado',async()=>{
  await db.exec(`select set_config('test.account','${other}',false)`)
  const id=await importDoc('pdf:other:1',values,other,otherStore)
  const row=await getItem(id)
  assert.equal(row.market_product_id,otherProduct); assert.equal(row.reconciliation_method,'ean_exact'); assert.equal(row.reviewed_at,null)
  assert.equal((await query('select count(*)::int as n from market_purchase_product_mappings where market_account_id=$1',[other]))[0].n,0)
  await db.exec(`select set_config('test.account','${account}',false)`)
})
test('correção de identidade invalida match e conserva ambos os códigos originais',async()=>{
  const fresh=await getItem(purchase)
  await save(fresh,{...values,supplier_product_code:'1732',barcode_raw:'1732'})
  const changed=await getItem(purchase)
  assert.equal(changed.market_product_id,null); assert.equal(changed.reconciliation_status,'pending')
  assert.equal(changed.barcode_normalized,null)
  assert.equal(changed.original_data.barcode_raw,'7892840825133')
  assert.equal(changed.original_data.supplier_product_code,'7892840825133')
  await assert.rejects(save(changed,{...values,supplier_product_code:'1732',barcode_raw:'1732'},true),/PURCHASE_REVIEW_MATCH_REQUIRED/)
})
test('mapping de código curto não cruza fornecedor',async()=>{
  const row=await getItem(purchase)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,row.id,product2])
  const doc=document({...values,supplier_product_code:'1732',barcode_raw:null})
  doc.header.supplierCnpj='28620040000155'
  const id=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:other-supplier',doc]))[0].id
  assert.equal((await getItem(id)).market_product_id,null)
})
test('de/para ambíguo não escolhe produto arbitrariamente, fica em needs_review',async()=>{
  const supplierDoc='11222333000181'
  await query(
    `insert into market_purchase_product_mappings(market_account_id,supplier_document,supplier_product_code,barcode_normalized,description_normalized,market_product_id,created_by)
     values ($1,$2,'9999',null,null,$3,$5),($1,$2,'9999',null,'PRODUTO AMBIGUO',$4,$5)`,
    [account,supplierDoc,product,product2,actor])
  const doc=document({...values,supplier_product_code:'9999',barcode_raw:null,description_raw:'PRODUTO AMBIGUO'})
  doc.header.supplierCnpj=supplierDoc
  const id=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:ambiguous:1',doc]))[0].id
  const row=await getItem(id)
  assert.equal(row.market_product_id,null); assert.equal(row.reconciliation_status,'needs_review')
  assert.match(row.reconciliation_notes,/Mais de um/)
})
const cxSupplierDoc='44555666000199'
const cxValues={supplier_product_code:'5555',barcode_raw:null,description_raw:'CREME ACAI ULTRACAI POTE 1LT TRADICIONAL CX 6 UN',quantity:1,unit:'CX',unit_price:167.40,gross_amount:167.40,net_amount:167.40,discount_amount:0,freight_amount:0,other_amount:0}
let cxId, cxRow
test('produto conciliado sem conversão continua sem conferência; conferir exige fator válido',async()=>{
  const doc=document(cxValues); doc.header.supplierCnpj=cxSupplierDoc
  cxId=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:cx:1',doc]))[0].id
  cxRow=await getItem(cxId)
  assert.equal(cxRow.reconciliation_status,'pending'); assert.equal(cxRow.conversion_factor,null)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,cxRow.id,product])
  cxRow=await getItem(cxId)
  assert.equal(cxRow.market_product_id,product); assert.equal(cxRow.reviewed_at,null) // produto conciliado, ainda não conferido
  // CX (doc) != UN (estoque do produto): fator fica pendente, mas a unidade de
  // estoque já é conhecida a partir do produto conciliado (bug corrigido:
  // antes ficava null/"?" mesmo com produto já vinculado).
  assert.equal(cxRow.conversion_factor,null); assert.equal(cxRow.stock_unit,'UN')
  await assert.rejects(save(cxRow,cxValues,true),/PURCHASE_ITEM_CONVERSION_REQUIRED/)
  await assert.rejects(saveConversion(cxRow,0),/PURCHASE_ITEM_CONVERSION_INVALID/)
  await assert.rejects(saveConversion(cxRow,-2),/PURCHASE_ITEM_CONVERSION_INVALID/)
})
test('1 CX com fator 6 confirma 6 UN de entrada prevista e custo unitário previsto, sem tocar o original',async()=>{
  await saveConversion(cxRow,6)
  cxRow=await getItem(cxId)
  assert.equal(Number(cxRow.conversion_factor),6); assert.equal(cxRow.stock_unit,'UN')
  assert.equal(Number(cxRow.stock_quantity),6); assert.equal(Number(cxRow.stock_unit_cost),27.9)
  assert.equal(Number(cxRow.original_data.quantity),1); assert.equal(cxRow.original_data.unit,'CX')
  assert.equal(Number(cxRow.quantity),1); assert.equal(cxRow.unit,'CX') // documento não foi "corrigido" para 6 UN
  assert.equal(cxRow.reviewed_at,null) // conversão sozinha não confere o item
})
test('fator de conversão aceita até seis casas decimais e rejeita além disso',async()=>{
  const id=await importDoc('pdf:precision-factor:1',{...values,supplier_product_code:'7777',barcode_raw:null,unit:'CX'})
  let row=await getItem(id)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row.id,product])
  row=await getItem(id)
  await saveConversion(row,2.123456)
  row=await getItem(id)
  assert.equal(Number(row.conversion_factor),2.123456)
  await assert.rejects(saveConversion(row,2.1234567),/PURCHASE_ITEM_CONVERSION_INVALID/)
})
test('item cuja unidade do documento já é a de estoque resolve fator 1 automaticamente',async()=>{
  const id=await importDoc('pdf:un-un:1',{...values,supplier_product_code:'6666',barcode_raw:null,quantity:10,unit:'UN',unit_price:2,gross_amount:20,net_amount:20})
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,(await getItem(id)).id,product2])
  const row=await getItem(id)
  assert.equal(Number(row.conversion_factor),1); assert.equal(row.stock_unit,'UN'); assert.equal(Number(row.stock_quantity),10)
})
test('conferir o item confirma; corrigir o fator depois invalida a conferência do item e da compra',async()=>{
  await save(cxRow,cxValues,true)
  cxRow=await getItem(cxId)
  assert.ok(cxRow.reviewed_at)
  const purchaseHeader=(await query('select status from market_purchases where id=$1',[cxId]))[0]
  assert.equal(purchaseHeader.status,'reconciling') // ainda não é a compra inteira que completou
  await saveConversion(cxRow,8)
  cxRow=await getItem(cxId)
  assert.equal(cxRow.reviewed_at,null); assert.equal(Number(cxRow.conversion_factor),8)
  await saveConversion(cxRow,6) // devolve ao valor correto para os testes seguintes
  cxRow=await getItem(cxId)
})
test('conversão salva para reaproveitar é aplicada automaticamente em compra futura equivalente, sem conferir',async()=>{
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,cxRow.id,product])
  cxRow=await getItem(cxId)
  await saveConversion(cxRow,6,true)
  cxRow=await getItem(cxId)
  assert.equal(Number(cxRow.conversion_factor),6)
  const doc2=document(cxValues); doc2.header.supplierCnpj=cxSupplierDoc
  const id2=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:cx:2',doc2]))[0].id
  const row2=await getItem(id2)
  assert.equal(row2.market_product_id,product); assert.equal(row2.reconciliation_status,'mapped')
  assert.equal(Number(row2.conversion_factor),6); assert.equal(row2.stock_unit,'UN')
  assert.equal(row2.reviewed_at,null) // conversão conhecida/reaproveitada não confere o item automaticamente
})
test('conversão de um tenant não vaza para outro Market mesmo com fornecedor/código/unidade iguais',async()=>{
  await db.exec(`select set_config('test.account','${other}',false)`)
  const doc3=document(cxValues); doc3.header.supplierCnpj=cxSupplierDoc
  const id3=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[other,otherStore,'pdf:cx:other',doc3]))[0].id
  const row3=await getItem(id3)
  assert.equal(row3.market_product_id,null); assert.equal(row3.conversion_factor,null)
  await db.exec(`select set_config('test.account','${account}',false)`)
})
test('conversão continua contextual ao fornecedor: mesmo código de outro fornecedor não reaproveita',async()=>{
  const doc4=document({...cxValues}); doc4.header.supplierCnpj='32193036000125'
  const id4=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:cx:othersupplier',doc4]))[0].id
  const row4=await getItem(id4)
  assert.equal(row4.market_product_id,null); assert.equal(row4.conversion_factor,null)
})
test('EAN automático (ean_exact) também resolve a unidade de estoque mesmo sem fator conhecido',async()=>{
  const id=await importDoc('pdf:ean-cx:1',{...values,supplier_product_code:null,barcode_raw:'7892840825133',unit:'CX',quantity:2,unit_price:50,gross_amount:100,net_amount:100})
  const row=await getItem(id)
  assert.equal(row.market_product_id,product); assert.equal(row.reconciliation_method,'ean_exact')
  assert.equal(row.conversion_factor,null); assert.equal(row.stock_unit,'UN') // produto UN, doc CX: fator pendente, unidade já conhecida
  assert.equal(row.reviewed_at,null)
})
test('de/para de produto (purchase_mapping) automático também resolve a unidade sem fator conhecido',async()=>{
  const mapDoc='55666777000110'
  const first=document({...cxValues,supplier_product_code:'8888',barcode_raw:null}); first.header.supplierCnpj=mapDoc
  const id1=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:mapping-cx:1',first]))[0].id
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,(await getItem(id1)).id,product])
  const second=document({...cxValues,supplier_product_code:'8888',barcode_raw:null}); second.header.supplierCnpj=mapDoc
  const id2=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:mapping-cx:2',second]))[0].id
  const row2=await getItem(id2)
  assert.equal(row2.market_product_id,product); assert.equal(row2.reconciliation_status,'mapped')
  assert.equal(row2.conversion_factor,null); assert.equal(row2.stock_unit,'UN') // mapeado automaticamente, fator ainda pendente
})
test('produto sem unidade de estoque válida não finge conhecer o destino e bloqueia salvar fator',async()=>{
  const blankUnitProduct='30000000-0000-4000-8000-000000000009'
  await query(`insert into market_products values($1,$2,'active',null,'BLANK','',$3,$3)`,[blankUnitProduct,account,'Produto sem unidade'])
  const id=await importDoc('pdf:blank-unit:1',{...values,supplier_product_code:'9090',barcode_raw:null,unit:'CX'})
  const row0=await getItem(id)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row0.id,blankUnitProduct])
  const row=await getItem(id)
  assert.equal(row.market_product_id,blankUnitProduct); assert.equal(row.stock_unit,null); assert.equal(row.conversion_factor,null)
  await assert.rejects(saveConversion(row,3),/RECONCILE_PRODUCT_UNIT_MISSING/)
})
test('desfazer a reconciliação limpa a conversão; escrita REST direta na tabela de conversões é bloqueada',async()=>{
  await query('select market_undo_purchase_item_reconciliation($1,$2)',[account,cxRow.id])
  cxRow=await getItem(cxId)
  assert.equal(cxRow.market_product_id,null); assert.equal(cxRow.conversion_factor,null); assert.equal(cxRow.stock_unit,null)
  await db.exec('set role authenticated')
  await assert.rejects(query('insert into market_purchase_unit_conversions(market_account_id,supplier_product_code,source_unit,stock_unit,conversion_factor) values ($1,$2,$3,$4,$5)',[account,'zzzz','CX','UN',2]),/permission denied/)
  await db.exec('reset role')
})
test('conversão não gera movimento nem altera saldo de estoque',async()=>{
  assert.deepEqual(await query('select * from market_stock_movements'),[{id:1}])
  assert.deepEqual(await query('select * from market_stock_balance'),[{id:1}])
})
test('RPC autenticada funciona, RLS não revela compras de outro tenant',async()=>{
  await db.exec('set role authenticated')
  assert.equal((await query('select * from market_purchases where market_account_id=$1',[other])).length,0)
  const id=await importDoc('pdf:authenticated', {...values,supplier_product_code:'new-code',barcode_raw:null})
  const row=await getItem(id)
  await save(row,{...values,supplier_product_code:'new-code',barcode_raw:null,quantity:1.2345,unit_price:2.12345,gross_amount:2.62,net_amount:2.62})
  assert.equal(Number((await getItem(id)).quantity),1.2345)
  assert.equal(Number((await getItem(id)).unit_price),2.12345)
  await assert.rejects(query('delete from market_purchase_product_mappings'),/permission denied/)
  await db.exec('reset role')
})
test('conferência rejeita divergência e conta indisponível',async()=>{
  const id=await importDoc('pdf:math-check')
  let row=await getItem(id)
  await assert.rejects(save(row,{...values,quantity:2},true),/PURCHASE_REVIEW_MATH/)
  assert.equal((await getItem(id)).reviewed_at,null)
  await db.exec(`update market_accounts set status='suspended' where id='${account}'`)
  row=await getItem(id)
  await assert.rejects(save(row,values),/PURCHASE_REVIEW_LOCKED/)
  await db.exec(`update market_accounts set status='active' where id='${account}'`)
})
test('catálogo Accesys vigente continua obrigatório no match manual',async()=>{
  const integration='50000000-0000-4000-8000-000000000001'
  await db.exec(`insert into market_integrations values('${integration}','${account}','accesys','active');
    insert into market_product_mappings values('${product}','${account}','${integration}','accesys',false);`)
  const id=await importDoc('pdf:current-catalog')
  const row=await getItem(id)
  assert.equal(row.market_product_id,product)
  await assert.rejects(query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row.id,product2]),/RECONCILE_PRODUCT_NOT_CURRENT/)
})
test('PDFs reais chegam ao staging com 22/2 itens e precisão intacta',async()=>{
  for (const name of ['jf','carmel']) {
    const fixture=JSON.parse(readFileSync(new URL(`fixtures/${name}.json`,import.meta.url)))[0]
    const doc=pdfStagingDocument(parse(fixture))
    const id=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,`pdf:real:${name}`,doc]))[0].id
    const rows=await query('select * from market_purchase_items where market_purchase_id=$1 order by line_number',[id])
    assert.equal(rows.length,name==='jf'?22:2)
    assert.equal(rows[0].original_data.supplier_product_code,name==='jf'?'7892840825133':'1732')
    assert.ok(rows.every(row=>row.reviewed_at===null && row.stock_entry_status==='pending'))
    if(name==='carmel') assert.equal(Number(rows[1].unit_price),107.8167)
  }
})
test('precisão excedente e NaN são rejeitados antes de arredondar/gravar',async()=>{
  const id=await importDoc('pdf:precision:1')
  const row=await getItem(id)
  await assert.rejects(save(row,{...values,quantity:1.12345}),/PURCHASE_ITEM_PRECISION/)
  await assert.rejects(save(row,{...values,unit_price:1.123456}),/PURCHASE_ITEM_PRECISION/)
  await assert.rejects(save(row,{...values,quantity:'NaN'}),/PURCHASE_ITEM_INVALID/)
  assert.equal(Number((await getItem(id)).quantity),15)
})
test('Texto IA usa o mesmo staging, mesma conciliação automática, sem conferir sozinho',async()=>{
  const doc=document({...values,supplier_product_code:null,barcode_raw:'7892840825133'})
  const id=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4,$5) as id',[account,store,'ai_text:hash-1',doc,'ai_text']))[0].id
  const header=(await query('select * from market_purchases where id=$1',[id]))[0]
  assert.equal(header.source_type,'ai_text')
  const row=await getItem(id)
  assert.equal(row.market_product_id,product); assert.equal(row.reconciliation_method,'ean_exact')
  assert.equal(row.reviewed_at,null) // match automático não confere sozinho, igual ao PDF
  // idempotência: mesma referência + mesma origem não duplica
  assert.equal((await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4,$5) as id',[account,store,'ai_text:hash-1',doc,'ai_text']))[0].id,id)
})
test('mesma referência em origens diferentes (pdf x ai_text) não colide',async()=>{
  const doc=document({...values,supplier_product_code:'shared-ref-code',barcode_raw:null})
  const pdfId=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'shared-ref',doc]))[0].id
  const aiId=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4,$5) as id',[account,store,'shared-ref',doc,'ai_text']))[0].id
  assert.notEqual(pdfId,aiId)
  assert.equal((await query('select source_type from market_purchases where id=$1',[pdfId]))[0].source_type,'pdf')
  assert.equal((await query('select source_type from market_purchases where id=$1',[aiId]))[0].source_type,'ai_text')
})
test('origem inválida é rejeitada explicitamente',async()=>{
  const doc=document({...values,supplier_product_code:'invalid-source-code',barcode_raw:null})
  await assert.rejects(query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4,$5) as id',[account,store,'bad-source',doc,'texto_livre']),/PURCHASE_SOURCE_TYPE_INVALID/)
})
test('nenhuma conferência alterou ledger ou saldo',async()=>{
  assert.deepEqual(await query('select * from market_stock_movements'),[{id:1}])
  assert.deepEqual(await query('select * from market_stock_balance'),[{id:1}])
  assert.doesNotMatch(sqlFile('202609070001_purchase_human_review.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609070002_purchase_unit_conversion.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609070003_fix_purchase_unit_conversion_resolution.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609070004_purchase_ai_text_staging.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  await db.close()
})
