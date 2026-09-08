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
  -- Forma final (pós-202609070005) do livro-razão: precisão já alargada e
  -- reference_item_id/índice de idempotência já presentes, para não precisar
  -- carregar 202609010001 inteira (que depende de market_account_members/
  -- market_member_stores, fora do escopo destes testes de compras).
  create table market_stock_movements(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null, market_store_id uuid not null,
    product_id uuid not null,
    movement_type text not null check (movement_type in ('PURCHASE','SALE','TRANSFER_IN','TRANSFER_OUT','ADJUSTMENT_IN','ADJUSTMENT_OUT','LOSS','INVENTORY')),
    direction text not null check (direction in ('IN','OUT')), quantity numeric(18,4) not null check (quantity > 0),
    unit_cost numeric(18,6) null check (unit_cost is null or unit_cost >= 0),
    reference_type text null, reference_id uuid null, reference_item_id uuid null, notes text null,
    occurred_at timestamptz not null default now(), created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
  );
  create unique index ux_market_stock_movements_source_item on market_stock_movements
    (market_account_id, movement_type, reference_type, reference_id, reference_item_id)
    where reference_type is not null and reference_id is not null and reference_item_id is not null;
  create view market_stock_balance as
    select market_account_id, market_store_id, product_id,
      sum(case when direction='IN' then quantity else -quantity end)::numeric(18,4) as quantity_on_hand,
      max(occurred_at) as last_movement_at
    from market_stock_movements group by market_account_id, market_store_id, product_id;
`)
const core=sqlFile('202608310001_create_market_multitenant_core.sql')
await db.exec(core.slice(core.indexOf('create table if not exists public.market_purchases ('),core.indexOf('-- 6. IMPORTAÇÃO DE VENDAS')))
await db.exec('alter table market_purchases enable row level security; alter table market_purchase_items enable row level security;')
for (const name of ['202609040001_create_market_purchase_staging_foundation.sql','202609040002_import_market_purchase_staging.sql','202609040003_reimport_purchase_staging.sql','202609040004_purchase_reconciliation.sql','202609040005_purchase_reconciliation_accesys_scope.sql','202609070001_purchase_human_review.sql','202609070002_purchase_unit_conversion.sql','202609070003_fix_purchase_unit_conversion_resolution.sql','202609070004_purchase_ai_text_staging.sql','202609070005_purchase_receiving.sql','202609070006_purchase_receiving_require_unit_cost.sql','202609080001_purchase_review_automation.sql']) await db.exec(sqlFile(name))

const query = async (sql,params=[]) => (await db.query(sql,params)).rows
const values={supplier_product_code:'7892840825133',barcode_raw:'7892840825133',description_raw:'Produto',quantity:15,unit:'UN',unit_price:7.69,gross_amount:115.35,net_amount:115.35,discount_amount:0,freight_amount:0,other_amount:0}
const document=(item=values) => ({header:{supplierName:'Fornecedor',supplierCnpj:'32193036000125',documentNumber:'15915',series:'1',issueDate:'20/07/2026',productsTotal:item.gross_amount,invoiceTotal:item.gross_amount},items:[item]})
const importDoc=async(ref,item=values,a=account,s=store) => (await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[a,s,ref,document(item)]))[0].id
const getItem=async(id) => (await query('select * from market_purchase_items where market_purchase_id=$1',[id]))[0]
const save=async(item,v,confirm=false,a=account) => query('select market_save_purchase_item_review($1,$2,$3,$4,$5)',[a,item.id,v,item.updated_at,confirm])
const saveConversion=async(item,factor,reuse=false,a=account) => query('select market_save_purchase_item_conversion($1,$2,$3,$4,$5)',[a,item.id,factor,item.updated_at,reuse])
const receive=async(purchaseId,a=account) => (await query('select market_receive_purchase_items($1,$2) as result',[a,purchaseId]))[0].result
const deleteNote=async(purchaseId,a=account) => query('select market_delete_purchase_staging($1,$2)',[a,purchaseId])
const getPurchase=async(id) => (await query('select * from market_purchases where id=$1',[id]))[0]
const itemsOf=async(purchaseId) => query('select * from market_purchase_items where market_purchase_id=$1 order by line_number',[purchaseId])
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
  assert.deepEqual(await query('select * from market_stock_movements'),[])
  assert.deepEqual(await query('select * from market_stock_balance'),[])
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
  assert.deepEqual(await query('select * from market_stock_movements'),[])
  assert.deepEqual(await query('select * from market_stock_balance'),[])
  assert.doesNotMatch(sqlFile('202609070001_purchase_human_review.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609070002_purchase_unit_conversion.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609070003_fix_purchase_unit_conversion_resolution.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609070004_purchase_ai_text_staging.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
})

let recvId
test('monta compra RECV: 1 item pronto, 1 não conciliado, 1 não conferido, 1 com conversão pendente',async()=>{
  const items=[
    {supplier_product_code:'recv-1',barcode_raw:null,description_raw:'Pronto para receber',quantity:2,unit:'UN',unit_price:10,gross_amount:20,net_amount:20,discount_amount:0,freight_amount:0,other_amount:0},
    {supplier_product_code:'recv-2',barcode_raw:null,description_raw:'Não conciliado',quantity:1,unit:'UN',unit_price:20,gross_amount:20,net_amount:20,discount_amount:0,freight_amount:0,other_amount:0},
    {supplier_product_code:'recv-3',barcode_raw:null,description_raw:'Não conferido',quantity:1,unit:'UN',unit_price:20,gross_amount:20,net_amount:20,discount_amount:0,freight_amount:0,other_amount:0},
    {supplier_product_code:'recv-4',barcode_raw:null,description_raw:'Conversão pendente',quantity:1,unit:'CX',unit_price:167.4,gross_amount:167.4,net_amount:167.4,discount_amount:0,freight_amount:0,other_amount:0},
  ]
  const total=items.reduce((sum,i)=>sum+i.gross_amount,0)
  const doc={header:{supplierName:'Fornecedor RECV',supplierCnpj:'32193036000125',documentNumber:'RECV-1',series:'1',issueDate:'01/09/2026',productsTotal:total,invoiceTotal:total},items}
  recvId=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:recv:1',doc]))[0].id
  let rows=await itemsOf(recvId)
  // recv-1: concilia com `product` (UN, mesma unidade do documento -> fator 1 automático) e confere
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,rows[0].id,product])
  rows=await itemsOf(recvId)
  await save(rows[0],items[0],true)
  // recv-2: fica pendente de conciliação (não tocado)
  // recv-3: concilia (com `product`, o único "vigente" após o teste de catálogo Accesys) mas NÃO confere
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,rows[2].id,product])
  // recv-4: concilia com `product` (UN), mas documento está em CX -> conversão fica pendente; não confere
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,rows[3].id,product])
  rows=await itemsOf(recvId)
  assert.equal(rows[0].stock_entry_status,'pending'); assert.ok(rows[0].reviewed_at) // pronto, ainda não recebido
  assert.equal(rows[1].reconciliation_status,'pending')
  assert.equal(rows[2].reconciliation_status,'matched_manual'); assert.equal(rows[2].reviewed_at,null)
  assert.equal(rows[3].conversion_factor,null); assert.equal(rows[3].stock_unit,'UN') // unidade já conhecida (produto), só o fator fica pendente
})
test('1./2./3./4. só o item pronto entra; não conciliado, não conferido e conversão pendente ficam de fora',async()=>{
  const result=await receive(recvId)
  assert.equal(result.itemsReceivedNow,1); assert.equal(result.itemsTotal,4); assert.equal(result.itemsReceivedTotal,1)
  assert.equal(result.purchaseStatus,'receiving') // 8./9./10.: 0 < recebidos < total
  const rows=await itemsOf(recvId)
  assert.equal(rows[0].stock_entry_status,'received'); assert.ok(rows[0].received_at); assert.equal(rows[0].received_by,actor)
  assert.equal(rows[1].stock_entry_status,'pending')
  assert.equal(rows[2].stock_entry_status,'pending')
  assert.equal(rows[3].stock_entry_status,'pending')
  const purchaseRow=await getPurchase(recvId)
  assert.equal(purchaseRow.status,'receiving')
})
test('5./19. item já recebido não entra de novo; retry sem itens novos não duplica movimento',async()=>{
  await assert.rejects(receive(recvId),/PURCHASE_RECEIVE_NO_READY_ITEMS/)
  const movements=await query('select * from market_stock_movements where reference_id=$1',[recvId])
  assert.equal(movements.length,1)
})
test('6./27. item recebido é imutável: nenhuma RPC de edição/conciliação/conversão o altera',async()=>{
  const received=(await itemsOf(recvId))[0]
  const sameValues={supplier_product_code:'recv-1',barcode_raw:null,description_raw:'tentativa de editar',quantity:2,unit:'UN',unit_price:10,gross_amount:20,net_amount:20,discount_amount:0,freight_amount:0,other_amount:0}
  await assert.rejects(save(received,sameValues),/RECONCILE_STOCK_ALREADY_ADVANCED/)
  await assert.rejects(query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,received.id,product2]),/RECONCILE_STOCK_ALREADY_ADVANCED/)
  await assert.rejects(query('select market_undo_purchase_item_reconciliation($1,$2)',[account,received.id]),/RECONCILE_STOCK_ALREADY_ADVANCED/)
  await assert.rejects(saveConversion(received,2),/RECONCILE_STOCK_ALREADY_ADVANCED/)
})
test('16./17./18. custo unitário, custo total e referências à compra/item preservados no movimento',async()=>{
  const movement=(await query('select * from market_stock_movements where reference_id=$1',[recvId]))[0]
  const item=(await itemsOf(recvId))[0]
  assert.equal(Number(movement.quantity),Number(item.stock_quantity))
  assert.equal(Number(movement.unit_cost),Number(item.stock_unit_cost))
  assert.equal(Number(movement.quantity)*Number(movement.unit_cost)>0,true)
  assert.equal(movement.movement_type,'PURCHASE'); assert.equal(movement.direction,'IN')
  assert.equal(movement.reference_type,'PURCHASE'); assert.equal(movement.reference_id,recvId); assert.equal(movement.reference_item_id,item.id)
  assert.equal(movement.market_store_id,store); assert.equal(movement.product_id,product)
  const balance=(await query('select * from market_stock_balance where market_account_id=$1 and market_store_id=$2 and product_id=$3',[account,store,product]))[0]
  assert.equal(Number(balance.quantity_on_hand),Number(item.stock_quantity))
})
test('caso real Norac: net_amount ausente usa automaticamente o total da linha para o custo, sem exigir edição manual (item 1/2/3 do pedido)',async()=>{
  const noracValues={...values,supplier_product_code:'norac-1',barcode_raw:null,net_amount:null}
  const id=await importDoc('pdf:norac-cost:1',noracValues)
  let row=await getItem(id)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row.id,product])
  row=await getItem(id)
  await save(row,noracValues,true)
  row=await getItem(id)
  assert.ok(row.reviewed_at) // conferido normalmente: net_amount não é exigido para conferir
  assert.equal(row.net_amount,null) // fallback NUNCA escreve em net_amount — o documento continua fiel ao original
  assert.equal(row.original_data.net_amount,null)
  assert.equal(Number(row.conversion_factor),1); assert.equal(row.stock_unit,'UN') // PT/UN→UN: conversão 1:1 resolvida
  assert.equal(Number(row.stock_quantity),15) // não depende de net_amount
  const expectedCost=Number(row.gross_amount)/15
  assert.ok(Math.abs(Number(row.calculated_unit_cost)-expectedCost)<1e-6) // custo "documento" usa o total da linha
  assert.ok(Math.abs(Number(row.stock_unit_cost)-expectedCost)<1e-6) // custo "estoque" idem (fator 1)
  const result=await receive(id) // pronto de primeira: nenhuma edição manual de net_amount foi necessária
  assert.equal(result.itemsReceivedNow,1)
  const movement=(await query('select unit_cost from market_stock_movements where reference_item_id=$1',[row.id]))[0]
  assert.ok(Math.abs(Number(movement.unit_cost)-expectedCost)<1e-6)
})
test('item 3: sem valor líquido e sem total válido, custo continua null mesmo já conciliado e convertido — nunca inventa valor',async()=>{
  const noTotalValues={...values,supplier_product_code:'no-total-1',barcode_raw:null,net_amount:null,gross_amount:null,unit_price:null}
  const id=await importDoc('pdf:no-total:1',noTotalValues)
  let row=await getItem(id)
  assert.equal(row.gross_amount,null); assert.equal(row.net_amount,null)
  assert.equal(row.calculated_unit_cost,null); assert.equal(row.stock_unit_cost,null)
  // Mesmo com produto conciliado e conversão 1:1 resolvida (UN=UN), sem
  // nenhum valor monetário na linha o custo continua null — não é só a
  // conversão pendente que produzia null antes.
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row.id,product])
  row=await getItem(id)
  assert.equal(Number(row.conversion_factor),1); assert.equal(row.stock_unit,'UN')
  assert.equal(row.calculated_unit_cost,null); assert.equal(row.stock_unit_cost,null)
})
let cascadeId, cascadeRows
test('itens 4/7: nova correspondência é aplicada imediatamente a outra ocorrência idêntica da MESMA compra',async()=>{
  const supplierDoc='66777888000122'
  const itemA={...values,supplier_product_code:'cascade-1',barcode_raw:null,description_raw:'Produto cascata A'}
  const itemB={...values,supplier_product_code:'cascade-1',barcode_raw:null,description_raw:'Produto cascata B (mesma identidade de mapping)'}
  const itemC={...values,supplier_product_code:'cascade-other',barcode_raw:null,description_raw:'Produto não relacionado'}
  const doc=document(itemA); doc.header.supplierCnpj=supplierDoc; doc.items=[itemA,itemB,itemC]
  cascadeId=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:cascade:1',doc]))[0].id
  cascadeRows=await itemsOf(cascadeId)
  assert.equal(cascadeRows[0].reconciliation_status,'pending'); assert.equal(cascadeRows[1].reconciliation_status,'pending')
  const result=(await query(
    'select market_confirm_purchase_item_reconciliation($1,$2,$3,true) as result',
    [account,cascadeRows[0].id,product],
  ))[0].result
  assert.equal(result.itemsAutoResolved,1) // só a linha B compartilha a identidade do mapping; C fica de fora
  cascadeRows=await itemsOf(cascadeId)
  assert.equal(cascadeRows[0].market_product_id,product); assert.equal(cascadeRows[0].reconciliation_status,'matched_manual')
  assert.equal(cascadeRows[1].market_product_id,product); assert.equal(cascadeRows[1].reconciliation_status,'mapped')
  assert.equal(cascadeRows[2].market_product_id,null); assert.equal(cascadeRows[2].reconciliation_status,'pending') // identidade diferente, não tocado
})
test('item 8: produto conciliado automaticamente pela cascata NÃO fica conferido sozinho',async()=>{
  assert.equal(cascadeRows[1].reviewed_at,null); assert.equal(cascadeRows[1].reviewed_by,null)
  assert.equal(cascadeRows[1].stock_entry_status,'pending')
})
test('item 10: conciliar sem marcar "usar esta correspondência" não persiste mapping nem reprocessa nada',async()=>{
  const supplierDoc='77888999000133'
  const itemA={...values,supplier_product_code:'no-mapping-1',barcode_raw:null,description_raw:'Sem persistir mapping A'}
  const itemB={...values,supplier_product_code:'no-mapping-1',barcode_raw:null,description_raw:'Sem persistir mapping B'}
  const doc=document(itemA); doc.header.supplierCnpj=supplierDoc; doc.items=[itemA,itemB]
  const id=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:no-cascade:1',doc]))[0].id
  const rows=await itemsOf(id)
  const result=(await query(
    'select market_confirm_purchase_item_reconciliation($1,$2,$3,false) as result',
    [account,rows[0].id,product],
  ))[0].result
  assert.equal(result.itemsAutoResolved,0)
  const stillPending=await itemsOf(id)
  assert.equal(stillPending[1].reconciliation_status,'pending')
  assert.equal((await query('select count(*)::int as n from market_purchase_product_mappings where supplier_product_code=$1',['no-mapping-1']))[0].n,0)
})
test('itens 2/4: mapping persistido é reaproveitado automaticamente em compra futura (QR/chave de acesso, sem clique manual)',async()=>{
  const supplierDoc='88999000111144'
  const qrDoc=(item)=>({accessKey:null,supplier:{name:'Fornecedor QR',document:supplierDoc},invoiceNumber:'QR-1',series:'1',
    totals:{totalAmount:item.gross_amount,productsAmount:item.gross_amount},
    items:[{lineNumber:1,supplierProductCode:item.supplier_product_code,barcode:item.barcode_raw,description:item.description_raw,
      unit:item.unit,quantity:item.quantity,unitPrice:item.unit_price,grossAmount:item.gross_amount,netAmount:item.net_amount}]})
  const first={...values,supplier_product_code:'qr-cascade-1',barcode_raw:null,description_raw:'Item QR primeira compra'}
  const firstDoc=qrDoc(first); firstDoc.accessKey='1'.repeat(44)
  const firstId=(await query('select market_import_purchase_staging($1,$2,$3,$4) as result',[account,store,'qrcode',firstDoc]))[0].result.purchaseId
  const firstRow=(await itemsOf(firstId))[0]
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,firstRow.id,product])
  const second={...values,supplier_product_code:'qr-cascade-1',barcode_raw:null,description_raw:'Item QR segunda compra'}
  const secondDoc=qrDoc(second); secondDoc.accessKey='2'.repeat(44)
  const secondId=(await query('select market_import_purchase_staging($1,$2,$3,$4) as result',[account,store,'qrcode',secondDoc]))[0].result.purchaseId
  const secondRow=(await itemsOf(secondId))[0]
  assert.equal(secondRow.market_product_id,product); assert.equal(secondRow.reconciliation_status,'mapped')
  assert.equal(secondRow.reviewed_at,null) // resolvido automaticamente, mas não conferido sozinho
})
test('item 5: mapping de outro tenant não é reaproveitado, mesmo com fornecedor/código idênticos',async()=>{
  const supplierDoc='99000111222155'
  const itemA={...values,supplier_product_code:'tenant-scope-1',barcode_raw:null}
  const doc=document(itemA); doc.header.supplierCnpj=supplierDoc
  const id=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:tenant-scope:1',doc]))[0].id
  const row=(await itemsOf(id))[0]
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,row.id,product])
  await db.exec(`select set_config('test.account','${other}',false)`)
  const otherDoc=document({...itemA}); otherDoc.header.supplierCnpj=supplierDoc
  const otherId=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[other,otherStore,'pdf:tenant-scope:other',otherDoc]))[0].id
  const otherRow=(await itemsOf(otherId))[0]
  assert.equal(otherRow.market_product_id,null); assert.equal(otherRow.reconciliation_status,'pending')
  await db.exec(`select set_config('test.account','${account}',false)`)
})
test('item 6: mapping salvo para outro fornecedor não é aplicado indevidamente ao mesmo código',async()=>{
  const itemA={...values,supplier_product_code:'supplier-scope-1',barcode_raw:null}
  const docA=document(itemA); docA.header.supplierCnpj='10101010101010'
  const idA=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:supplier-scope:a',docA]))[0].id
  const rowA=(await itemsOf(idA))[0]
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,rowA.id,product])
  const itemB={...values,supplier_product_code:'supplier-scope-1',barcode_raw:null}
  const docB=document(itemB); docB.header.supplierCnpj='20202020202020'
  const idB=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:supplier-scope:b',docB]))[0].id
  const rowB=(await itemsOf(idB))[0]
  assert.equal(rowB.market_product_id,null); assert.equal(rowB.reconciliation_status,'pending')
})
test('item 11: botão manual de reprocessar continua funcionando de forma independente',async()=>{
  const supplierDoc='30303030303030'
  // Grava o mapping por uma compra que NÃO participa do reprocessamento
  // automático (saveMapping=false), simulando um mapping que passou a
  // existir por outro caminho depois que a nota já estava em staging.
  const mapped={...values,supplier_product_code:'manual-reprocess-1',barcode_raw:null}
  const doc1=document(mapped); doc1.header.supplierCnpj=supplierDoc
  const id1=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:manual-reprocess:1',doc1]))[0].id
  const row1=(await itemsOf(id1))[0]
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row1.id,product]) // saveMapping=false: não persiste, não reprocessa nada
  await query(
    `insert into market_purchase_product_mappings(market_account_id,supplier_document,supplier_product_code,barcode_normalized,description_normalized,market_product_id,created_by)
     values ($1,$2,$3,null,null,$4,$5)`,
    [account,supplierDoc,'manual-reprocess-2',product,actor],
  )
  const doc2=document({...values,supplier_product_code:'manual-reprocess-2',barcode_raw:null}); doc2.header.supplierCnpj=supplierDoc
  const id2=(await query('select market_import_pdf_purchase_staging($1,$2,$3,$4,$4) as id',[account,store,'pdf:manual-reprocess:2',doc2]))[0].id
  let row2=(await itemsOf(id2))[0]
  // O import de PDF já reprocessa sozinho ao final (202609070004); zera esse
  // resultado de volta a 'pending' para isolar o que este teste quer provar:
  // que a MESMA RPC, chamada isoladamente (o botão "Reprocessar pendentes"),
  // resolve o item de forma independente do fluxo automático.
  await query('select market_undo_purchase_item_reconciliation($1,$2)',[account,row2.id])
  row2=(await itemsOf(id2))[0]
  assert.equal(row2.reconciliation_status,'pending')
  const reprocessResult=(await query('select market_reprocess_purchase_pending_items($1,$2) as result',[account,id2]))[0].result
  assert.equal(reprocessResult.itemsMatched,1)
  row2=(await itemsOf(id2))[0]
  assert.equal(row2.market_product_id,product); assert.equal(row2.reconciliation_status,'mapped')
})
test('migration 202609080001 nunca movimenta estoque nem confere item sozinha',async()=>{
  assert.doesNotMatch(sqlFile('202609080001_purchase_review_automation.sql'),/\b(insert\s+into|update|delete\s+from)\s+(public\.)?market_stock_(movements|balance)\b/i)
  assert.doesNotMatch(sqlFile('202609080001_purchase_review_automation.sql'),/reviewed_at\s*=\s*now\(\)/i)
})
test('7./11. resolvendo os itens restantes, a próxima entrada recebe o resto e conclui automaticamente',async()=>{
  let rows=await itemsOf(recvId)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,rows[1].id,product])
  rows=await itemsOf(recvId)
  await save(rows[1],{supplier_product_code:'recv-2',barcode_raw:null,description_raw:'Não conciliado',quantity:1,unit:'UN',unit_price:20,gross_amount:20,net_amount:20,discount_amount:0,freight_amount:0,other_amount:0},true)
  rows=await itemsOf(recvId)
  await save(rows[2],{supplier_product_code:'recv-3',barcode_raw:null,description_raw:'Não conferido',quantity:1,unit:'UN',unit_price:20,gross_amount:20,net_amount:20,discount_amount:0,freight_amount:0,other_amount:0},true)
  rows=await itemsOf(recvId)
  await saveConversion(rows[3],6)
  rows=await itemsOf(recvId)
  await save(rows[3],{supplier_product_code:'recv-4',barcode_raw:null,description_raw:'Conversão pendente',quantity:1,unit:'CX',unit_price:167.4,gross_amount:167.4,net_amount:167.4,discount_amount:0,freight_amount:0,other_amount:0},true)

  const result=await receive(recvId)
  assert.equal(result.itemsReceivedNow,3); assert.equal(result.itemsReceivedTotal,4); assert.equal(result.itemsTotal,4)
  assert.equal(result.purchaseStatus,'completed')
  const purchaseRow=await getPurchase(recvId)
  assert.equal(purchaseRow.status,'completed'); assert.ok(purchaseRow.received_at)
  const movements=await query('select * from market_stock_movements where reference_id=$1',[recvId])
  assert.equal(movements.length,4) // nenhuma linha duplicada (1 da entrada anterior + 3 novas)
  assert.equal(new Set(movements.map((m)=>m.reference_item_id)).size,4) // uma entrada por item, nunca duas para a mesma linha
})
test('após concluída, a compra continua bloqueada para qualquer edição',async()=>{
  const rows=await itemsOf(recvId)
  await assert.rejects(saveConversion(rows[0],9),/PURCHASE_REVIEW_LOCKED/)
  await assert.rejects(receive(recvId),/PURCHASE_REVIEW_LOCKED/)
})
test('22. exclusão de nota intacta funciona (nenhum item tocado)',async()=>{
  const id=await importDoc('pdf:delete:untouched',{...values,supplier_product_code:'del-0',barcode_raw:null})
  await deleteNote(id)
  assert.equal((await query('select * from market_purchases where id=$1',[id])).length,0)
  assert.equal((await query('select * from market_purchase_items where market_purchase_id=$1',[id])).length,0)
})
test('23. exclusão é bloqueada depois de conciliar um item',async()=>{
  const id=await importDoc('pdf:delete:reconciled',{...values,supplier_product_code:'del-1',barcode_raw:null})
  const row=await getItem(id)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row.id,product])
  await assert.rejects(deleteNote(id),/PURCHASE_DELETE_NOT_ALLOWED/)
  assert.equal((await query('select * from market_purchases where id=$1',[id])).length,1)
})
test('24. exclusão é bloqueada depois de conferir um item',async()=>{
  const id=await importDoc('pdf:delete:reviewed',{...values,supplier_product_code:'del-2',barcode_raw:null})
  let row=await getItem(id)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,false)',[account,row.id,product])
  row=await getItem(id)
  await save(row,{...values,supplier_product_code:'del-2',barcode_raw:null},true)
  await assert.rejects(deleteNote(id),/PURCHASE_DELETE_NOT_ALLOWED/)
})
test('25./26. exclusão é bloqueada depois de receber; mapping global salvo não é apagado',async()=>{
  const id=await importDoc('pdf:delete:received',{...values,supplier_product_code:'del-3',barcode_raw:null})
  let row=await getItem(id)
  await query('select market_confirm_purchase_item_reconciliation($1,$2,$3,true)',[account,row.id,product])
  row=await getItem(id)
  await save(row,{...values,supplier_product_code:'del-3',barcode_raw:null},true)
  await receive(id)
  const mappingCountBefore=(await query('select count(*)::int as n from market_purchase_product_mappings where supplier_product_code=$1',['del-3']))[0].n
  assert.equal(mappingCountBefore,1)
  await assert.rejects(deleteNote(id),/PURCHASE_DELETE_NOT_ALLOWED/)
  const mappingCountAfter=(await query('select count(*)::int as n from market_purchase_product_mappings where supplier_product_code=$1',['del-3']))[0].n
  assert.equal(mappingCountAfter,1)
})
test('exclusão nunca movimenta estoque; contagem final do ledger bate com o que foi efetivamente recebido',async()=>{
  assert.doesNotMatch(sqlFile('202609070005_purchase_receiving.sql'),/\bdelete\s+from\s+(public\.)?market_stock_movements\b/i)
  assert.doesNotMatch(sqlFile('202609070006_purchase_receiving_require_unit_cost.sql'),/\bdelete\s+from\s+(public\.)?market_stock_movements\b/i)
  const total=(await query('select count(*)::int as n from market_stock_movements'))[0].n
  assert.equal(total,6) // 4 itens da compra RECV + 1 de 'pdf:norac-cost:1' + 1 de 'pdf:delete:received' (del-3); nenhuma tentativa de exclusão gerou movimento
  await db.close()
})
