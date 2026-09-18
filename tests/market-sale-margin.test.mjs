import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'
import ExcelJS from 'exceljs'
const files=['src/pages/MarketSaleMargin.tsx','src/services/marketSaleMargin.ts','src/utils/marketSaleMarginExport.ts']
const code={}
for(const file of files){const result=await build({input:file,external:()=>true,write:false,output:{format:'cjs'},transform:{jsx:'react-jsx'}});code[file]=result.output[0].code}
function load(file,imports={}){const module={exports:{}};runInNewContext(code[file],{module,exports:module.exports,require:id=>imports[id]??{},console,Intl,Date});return module.exports}
const row=(id=1)=>({product_id:`p${id}`,product_name:`Produto ${id}`,ean:'000123',code:'00042',cost:8,cost_source:'COMPRA GIROMICRO',purchase_date:'2026-09-17T00:00:00Z',supplier_name:'Fornecedor',invoice_number:'123',sale_price:10,current_margin_pct:20,desired_margin_pct:25,difference_pp:5})
const stores=[{id:'a',name:'Loja A',store_type:'store',status:'active'},{id:'b',name:'Loja B',store_type:'store',status:'active'},{id:'w',name:'Galpao',store_type:'warehouse',status:'active'},{id:'i',name:'Inativa',store_type:'store',status:'inactive'}]
const tick=()=>new Promise(r=>setImmediate(r))
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)]
function harness(name,props,request=async()=>Array.from({length:25},(_,i)=>row(i))){
 const state=[],refs=[],effects=[];let si=0,ri=0,ei=0;const queued=[],calls=[]
 const Component=load(files[0],{
  react:{useState:v=>{const n=si++;if(!(n in state))state[n]=v;return [state[n],v=>state[n]=typeof v==='function'?v(state[n]):v]},useRef:v=>refs[ri++]??={current:v},useEffect:(fn,deps)=>{const n=ei++;if(!effects[n]||deps.some((d,i)=>d!==effects[n].deps[i]))queued.push(()=>{effects[n]?.cleanup?.();effects[n]={deps,cleanup:fn()}})}},
  'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'fragment'},
  'lucide-react':{ArrowLeft:'icon',Download:'icon',RefreshCw:'icon'},
  '../services/marketSaleMargin':{getMarketSaleMargin:async(...args)=>{calls.push(args);return request(...args)}},
 })[name]
 return {calls,render(){si=ri=ei=0;return Component(props)},async flush(){this.render();queued.splice(0).forEach(f=>f());await tick()},unmount(){effects.forEach(e=>e.cleanup?.())}}
}
test('servico passa conta/loja ao RPC e preserva todos os resultados',async()=>{
 const calls=[];const expected=Array.from({length:25},(_,i)=>row(i))
 const api=load(files[1],{'../lib/supabase':{supabase:{rpc:async(...args)=>{calls.push(args);return {data:expected,error:null}}}}})
 assert.equal((await api.getMarketSaleMargin('account','a')).length,25)
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[['market_get_sale_margin_analysis',{p_market_account_id:'account',p_store_id:'a'}]])
 const bad=load(files[1],{'../lib/supabase':{supabase:{rpc:async()=>({error:{code:'PGRST202'},data:null})}}})
 await assert.rejects(bad.getMarketSaleMargin('account','a'),/ainda precisa/)
})
test('tela somente lojas ativas, troca loja remonta consulta e nao oferece edicao',async()=>{
 const h=harness('MarketSaleMargin',{accountId:'account',stores,onBack(){}});await h.flush()
 assert.equal(nodes(h.render()).filter(n=>n.type==='option').length,3)
 assert.ok(!nodes(h.render()).some(n=>typeof n.type==='function'))
 nodes(h.render()).find(n=>n.type==='select').props.onChange({target:{value:'a'}})
 const a=nodes(h.render()).find(n=>typeof n.type==='function');assert.equal(a.props.store.id,'a')
 nodes(h.render()).find(n=>n.type==='select').props.onChange({target:{value:'b'}})
 const b=nodes(h.render()).find(n=>typeof n.type==='function');assert.equal(b.props.store.id,'b');assert.notEqual(a.key,b.key)
 assert.equal(nodes(h.render()).filter(n=>n.type==='input').length,0)
})
test('lista visual de 20; consulta exclusiva da loja e Excel recebe array completo',async()=>{
 const h=harness('SaleMarginResults',{accountId:'account',store:stores[0],onReload(){}});await h.flush()
 assert.equal(nodes(h.render()).filter(n=>n.type==='article').length,20)
 assert.deepEqual(h.calls,[['account','a']])
 assert.ok(nodes(h.render()).filter(n=>n.type==='button').every(n=>!n.props.disabled))
 const source=readFileSync(files[0],'utf8')
 assert.match(source,/createSaleMarginSpreadsheet\(rows, store.name\)/)
 assert.equal(nodes(h.render()).filter(n=>['form','input'].includes(n.type)).length,0)
})
test('erro e dados ausentes nao exibem produtos nem liberam Excel',async()=>{
 for(const request of [async()=>[],async()=>{throw Error('offline')}]){
  const h=harness('SaleMarginResults',{accountId:'account',store:stores[0],onReload(){}},request);await h.flush()
  assert.equal(nodes(h.render()).filter(n=>n.type==='article').length,0)
  assert.equal(nodes(h.render()).filter(n=>n.type==='button')[1].props.disabled,true)
 }
})
test('resposta atrasada da loja anterior e descartada',async()=>{
 let resolve;const h=harness('SaleMarginResults',{accountId:'account',store:stores[0],onReload(){}},()=>new Promise(r=>resolve=r))
 await h.flush();h.unmount();resolve([row()]);await tick()
 assert.equal(nodes(h.render()).filter(n=>n.type==='article').length,0)
})
test('Excel real exporta mais de 20 da loja escolhida, preserva numeros e codigos',async()=>{
 const api=load(files[2],{exceljs:ExcelJS});const rows=Array.from({length:25},(_,i)=>row(i))
 rows[0]={...rows[0],product_name:'=Produto',cost_source:'ACCESYS',purchase_date:null,supplier_name:null,invoice_number:null}
 const before=structuredClone(rows)
 const {filename,buffer}=await api.createSaleMarginSpreadsheet(rows,'Loja B',new Date(2026,8,18))
 assert.equal(filename,'margem-venda-Loja B-2026-09-18.xlsx')
 const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);const sheet=book.worksheets[0]
 assert.equal(sheet.rowCount,26);assert.equal(sheet.columnCount,11)
 assert.equal(sheet.getCell('A2').value,'=Produto');assert.equal(sheet.getCell('A2').type,ExcelJS.ValueType.String)
 assert.equal(sheet.getCell('B2').value,'000123');assert.equal(sheet.getCell('C2').value,'00042')
 assert.equal(sheet.getCell('D2').value,8);assert.equal(sheet.getCell('H2').value,10)
 assert.equal(sheet.getCell('I2').value,20);assert.equal(sheet.getCell('J2').value,25);assert.equal(sheet.getCell('K2').value,5)
 assert.equal(sheet.getCell('F2').value,null);assert.equal(sheet.getCell('E2').value,'ACCESYS')
 assert.equal(sheet.getCell('E3').value,'COMPRA GIROMICRO');assert.ok(sheet.getCell('F3').value instanceof Date)
 assert.deepEqual(rows,before)
})
test('entrada permite owner/admin/manager/operator e bloqueia viewer',()=>{
 const {canAccessMarketSaleMargin}=load(files[1])
 for(const role of ['owner','admin','manager','operator'])assert.equal(canAccessMarketSaleMargin(role),true)
 assert.equal(canAccessMarketSaleMargin('viewer'),false)
 const dashboard=readFileSync('src/pages/MarketDashboard.tsx','utf8')
 assert.match(dashboard,/showSaleMargin && canAccessMarketSaleMargin\(access.role\)/)
 assert.match(dashboard,/canAccessMarketSaleMargin\(access.role\) && <button[^\n]*setShowSaleMargin\(true\)/)
})
