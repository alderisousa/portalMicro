import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'
const files=['services/marketStoreProductParameters.ts','pages/MarketStoreProductParameters.tsx','pages/MarketStockDashboard.tsx']
const compiled={}
for(const file of files){const r=await build({input:`src/${file}`,external:()=>true,write:false,output:{format:'cjs'},transform:{jsx:'react-jsx'}});compiled[file]=r.output[0].code}
function load(file,imports={}){const module={exports:{}};runInNewContext(compiled[file],{module,exports:module.exports,require:id=>imports[id]??{},console,Intl,window:{setTimeout:fn=>fn()}});return module.exports}
const search=load(files[2])
const values={minimum_stock:null,is_essential:false,minimum_margin_pct:null}
function service(data=values,error=null){
 const calls=[],chain={}
 for(const method of ['select','eq','upsert'])chain[method]=(...args)=>{calls.push([method,...args]);return chain}
 for(const method of ['single','maybeSingle'])chain[method]=async()=>({data,error})
 return {calls,api:load(files[0],{'../lib/supabase':{supabase:{from:name=>{calls.push(['from',name]);return chain}}}})}
}
const api=service().api
const product={id:'p',name:'Cafe torrado',ean:'789123',sku:'SKU1',unit:'UN',externalEans:['789999'],externalProductCodes:['CODE1']}
const stores=[{id:'a',name:'Loja A',store_type:'store',status:'active'},{id:'b',name:'Loja B',store_type:'store',status:'active'},{id:'w',name:'Galpao',store_type:'warehouse',status:'active'},{id:'i',name:'Inativa',store_type:'store',status:'inactive'}]
const plain=x=>JSON.parse(JSON.stringify(x))
test('permissoes e lojas operacionais',()=>{
 for(const role of ['owner','admin','manager','operator'])assert.equal(api.canEditStoreProductParameters(role),true)
 assert.equal(api.canEditStoreProductParameters('viewer'),false)
 assert.deepEqual(plain(api.operationalStores(stores)).map(s=>s.id),['a','b'])
})
test('vazio e zero distintos, precisao e faixas',()=>{
 assert.deepEqual(plain(api.parseStoreProductParameters('',false,'')),values)
 assert.deepEqual(plain(api.parseStoreProductParameters('0',true,'0')),{minimum_stock:0,is_essential:true,minimum_margin_pct:0})
 assert.throws(()=>api.parseStoreProductParameters('1.125',false,'25,75'))
 assert.equal(api.parseStoreProductParameters('',false,'100').minimum_margin_pct,100)
 for(const invalid of ['-1','NaN','Infinity','100.01','2.345'])assert.throws(()=>api.parseStoreProductParameters('',false,invalid))
 for(const invalid of ['-1','Infinity','0.0001','100000000000'])assert.throws(()=>api.parseStoreProductParameters(invalid,false,''))
})
test('leitura isolada por conta, loja e produto; ausente nao grava',async()=>{
 const h=service(null);assert.deepEqual(plain(await h.api.getStoreProductParameters('account','store','product')),values)
 for(const [key,value] of [['market_account_id','account'],['market_store_id','store'],['product_id','product']]) assert.ok(h.calls.some(c=>c[0]==='eq'&&c[1]===key&&c[2]===value))
 assert.ok(!h.calls.some(c=>c[0]==='upsert'))
 await assert.rejects(service(null,Error('offline')).api.getStoreProductParameters('a','s','p'),/offline/)
})
test('upsert contem apenas os parametros e chaves, preserva preco/custo/markup',async()=>{
 const h=service();await h.api.saveStoreProductParameters('account','a','p',{minimum_stock:0,is_essential:true,minimum_margin_pct:20,sale_price:99,cost:1,markup:99})
 const write=h.calls.find(c=>c[0]==='upsert')
 assert.deepEqual(plain(write[1]),{market_account_id:'account',market_store_id:'a',product_id:'p',minimum_stock:0,is_essential:true,minimum_margin_pct:20})
 assert.equal(write[2].onConflict,'market_store_id,product_id')
 await assert.rejects(service(null,Error('denied')).api.saveStoreProductParameters('a','s','p',values),/denied/)
 const invalid=service();await assert.rejects(invalid.api.saveStoreProductParameters('a','s','p',{...values,minimum_margin_pct:101}));assert.equal(invalid.calls.length,0)
})
const tick=()=>new Promise(resolve=>setImmediate(resolve))
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)]
function harness(exportName,props,overrides={}){
 const states=[],refs=[],effects=[];let si=0,ri=0,ei=0;const queued=[],calls=[]
 const services={...api,getStoreProductParameters:async()=>values,saveStoreProductParameters:async(...args)=>{calls.push(args);return args[3]},...overrides}
 const component=load(files[1],{
  react:{useState:v=>{const n=si++;if(!(n in states))states[n]=v;return [states[n],v=>states[n]=typeof v==='function'?v(states[n]):v]},useRef:v=>refs[ri++]??={current:v},useEffect:(fn,deps)=>{const n=ei++;if(!effects[n]||deps.some((d,i)=>d!==effects[n].deps[i])){queued.push(()=>{effects[n]?.cleanup?.();effects[n]={deps,cleanup:fn()}})}}},
  'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key})},
  '../components/BarcodeScanner':{BarcodeScanner:'scanner'},'lucide-react':{ArrowLeft:'icon',Save:'icon',Search:'icon',ScanBarcode:'icon',Download:'icon'},'../services/marketStoreProductParameters':services,
  '../services/marketStock':{listActiveProducts:async()=>[product,...Array.from({length:10},(_,i)=>({...product,id:`p${i}`,name:`Cafe ${i}`,ean:`${i}`,sku:null,externalEans:[],externalProductCodes:[]}))]},
  './MarketStockDashboard':search,
 })[exportName]
 return {calls,render(){si=ri=ei=0;return component(props)},async flush(){this.render();queued.splice(0).forEach(f=>f());await tick()},unmount(){effects.forEach(e=>e.cleanup?.())}}
}
let savedCount=0
const editorProps={accountId:'account',storeId:'a',storeName:'Loja A',product,onSaved:()=>savedCount++}
test('editor carrega, salva zero/essencial/margem e confirma loja e produto',async()=>{
 const h=harness('ProductParametersEditor',editorProps);await h.flush()
 let inputs=nodes(h.render()).filter(n=>n.type==='input');assert.equal(inputs.length,3)
 inputs[0].props.onChange({target:{value:'0'}});inputs[1].props.onChange({target:{value:'22'}});inputs[2].props.onChange({target:{checked:true}})
 await nodes(h.render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}})
 assert.deepEqual(plain(h.calls[0]),['account','a','p',{minimum_stock:0,is_essential:true,minimum_margin_pct:22}])
 assert.equal(savedCount,1)
})
test('falha de carga bloqueia formulario; falha de save preserva edicao',async()=>{
 const h=harness('ProductParametersEditor',editorProps,{getStoreProductParameters:async()=>{throw Error('offline')}});await h.flush()
 assert.ok(!nodes(h.render()).some(n=>n.type==='form'));assert.ok(nodes(h.render()).some(n=>n.props?.role==='alert'))
 const s=harness('ProductParametersEditor',editorProps,{saveStoreProductParameters:async()=>{throw Error('offline')}});await s.flush()
 nodes(s.render()).find(n=>n.type==='input').props.onChange({target:{value:'5'}})
 await nodes(s.render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}})
 assert.equal(nodes(s.render()).find(n=>n.type==='input').props.value,'5');assert.ok(nodes(s.render()).some(n=>n.props?.role==='alert'))
})
test('resposta antiga de leitura nao altera editor desmontado',async()=>{
 let resolve;const h=harness('ProductParametersEditor',editorProps,{getStoreProductParameters:()=>new Promise(r=>resolve=r)});await h.flush();h.unmount()
 resolve({minimum_stock:99,is_essential:true,minimum_margin_pct:90});await tick()
 assert.ok(!nodes(h.render()).some(n=>n.type==='form'))
})
test('fluxo loja -> pesquisa limitada -> produto; troca de loja limpa selecao',async()=>{
 const h=harness('MarketStoreProductParameters',{accountId:'account',stores,onBack(){}});await h.flush()
 assert.equal(nodes(h.render()).filter(n=>n.type==='option').length,3)
 assert.ok(!nodes(h.render()).some(n=>n.type==='input'))
 nodes(h.render()).find(n=>n.type==='select').props.onChange({target:{value:'a'}});await h.flush()
 const input=()=>nodes(h.render()).find(n=>n.type==='input')
 input().props.onChange({target:{value:'cafe'}})
 assert.equal(nodes(h.render()).find(n=>n.props?.className==='market-product-results').props.children.length,8)
 input().props.onKeyDown({key:'Enter',preventDefault(){}})
 let editor=nodes(h.render()).find(n=>typeof n.type==='function');assert.equal(editor.props.storeId,'a');assert.equal(editor.props.product.id,'p')
 nodes(h.render()).find(n=>n.type==='select').props.onChange({target:{value:'b'}});await h.flush()
 assert.ok(!nodes(h.render()).some(n=>typeof n.type==='function'))
 for(const code of ['789123','CODE1','SKU1','789999']){input().props.onChange({target:{value:code}});editor=nodes(h.render()).find(n=>typeof n.type==='function');assert.equal(editor.props.product.id,'p');assert.equal(editor.props.storeId,'b')}
})
test('cabecalhos locais compactos e entrada protegida',()=>{
 for(const page of ['MarketStoreProductParameters','MarketReplenishmentSettings']){
  assert.match(readFileSync(`src/pages/${page}.tsx`,'utf8'),/header className="market-import-header"/)
  assert.match(readFileSync(`src/pages/${page}.css`,'utf8'),/font-size: clamp\(26px, 4vw, 36px\)/)
 }
 const dashboard=readFileSync('src/pages/MarketDashboard.tsx','utf8')
 assert.match(dashboard,/showStoreProductParameters && canEditStoreProductParameters\(access.role\)/)
 assert.match(dashboard,/canEditStoreProductParameters\(access.role\) && <button/)
})

test('scanner reutilizado seleciona codigo, avisa ausente e pos-save mantem loja e foca pesquisa',async()=>{
 const h=harness('MarketStoreProductParameters',{accountId:'account',stores,onBack(){}});await h.flush()
 nodes(h.render()).find(n=>n.type==='select').props.onChange({target:{value:'a'}});await h.flush()
 let focused=0
 nodes(h.render()).find(n=>n.type==='input').props.ref.current={focus(){focused++}}
 const open=()=>nodes(h.render()).find(n=>n.props?.className==='market-scanner-button').props.onClick()
 open();nodes(h.render()).find(n=>n.type==='scanner').props.onDetected('789123')
 const editor=nodes(h.render()).find(n=>typeof n.type==='function');assert.equal(editor.props.product.id,'p')
 editor.props.onSaved()
 assert.equal(nodes(h.render()).find(n=>n.type==='select').props.value,'a')
 assert.equal(nodes(h.render()).find(n=>n.type==='input').props.value,'')
 assert.ok(!nodes(h.render()).some(n=>typeof n.type==='function'));assert.equal(focused,1)
 open();nodes(h.render()).find(n=>n.type==='scanner').props.onDetected('missing')
 assert.ok(nodes(h.render()).some(n=>n.props?.role==='alert'));assert.equal(focused,2)
 open();nodes(h.render()).find(n=>n.type==='scanner').props.onClose();assert.equal(focused,3)
})

test('exportacao paginada restringe conta/loja, inclui zero e bloqueia galpao',async()=>{
 const calls=[];let page=0;const chain={}
 for(const method of ['select','eq','or','order','limit','gt'])chain[method]=(...args)=>{calls.push([method,...args]);return chain}
 chain.then=resolve=>resolve({data:page++===0?[{id:'row',minimum_stock:0}]:[],error:null})
 const s=load(files[0],{'../lib/supabase':{supabase:{from:()=>chain}}})
 const store={...stores[0],market_account_id:'account'}
 assert.equal((await s.listStoreProductParametersForExport('account',store)).length,1)
 assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='market_store_id'&&c[2]==='a'))
 assert.ok(calls.some(c=>c[0]==='eq'&&c[1]==='market_account_id'&&c[2]==='account'))
 assert.ok(calls.some(c=>c[0]==='or'&&c[1]==='minimum_stock.not.is.null,is_essential.eq.true,minimum_margin_pct.not.is.null'))
 assert.ok(calls.some(c=>c[0]==='gt'&&c[2]==='row'))
 await assert.rejects(s.listStoreProductParametersForExport('account',{...store,store_type:'warehouse'}))
 await assert.rejects(s.listStoreProductParametersForExport('other',store))
})
