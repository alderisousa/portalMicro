import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'
const paths = ['services/marketReplenishmentSettings.ts', 'pages/MarketReplenishmentSettings.tsx']
const code = {}
for (const path of paths) {
  const result = await build({input:`src/${path}`,external:()=>true,write:false,output:{format:'cjs'},transform:{jsx:'react-jsx'}})
  code[path] = result.output[0].code
}
function load(path, imports) {
  const module = {exports:{}}
  runInNewContext(code[path], {module,exports:module.exports,require:id=>{if (!(id in imports)) throw Error(id); return imports[id]},console})
  return module.exports
}
const values = {normal_list_limit:100,coverage_target_days:7,acceleration_threshold_pct:30,essential_no_sale_days:7}
function service(data={id:'settings',...values},error=null) {
  const calls=[]
  const query={}
  for(const method of ['select','eq','is','update','insert']) query[method]=(...args)=>{calls.push([method,...args]);return query}
  for(const method of ['single','maybeSingle']) query[method]=async()=>{calls.push([method]);return {data,error}}
  return {calls,api:load(paths[0],{'../lib/supabase':{supabase:{from:name=>{calls.push(['from',name]);return query}}}})}
}
test('leitura limita conta e padrão, sem buscar parâmetros internos',async()=>{
 const {api,calls}=service(); await api.getMarketReplenishmentSettings('account')
 assert.ok(calls.some(c=>JSON.stringify(c)==='["eq","market_account_id","account"]'))
 assert.ok(calls.some(c=>JSON.stringify(c)==='["is","store_id",null]'))
 assert.equal(calls.find(c=>c[0]==='select')[1],'id,normal_list_limit,coverage_target_days,acceleration_threshold_pct,essential_no_sale_days')
})
test('ausência usa padrões sem escrever; falhas de leitura propagam',async()=>{
 const {api,calls}=service(null); assert.equal((await api.getMarketReplenishmentSettings('a')).normal_list_limit,100)
 assert.ok(!calls.some(c=>['insert','update'].includes(c[0])))
 await assert.rejects(service(null,Error('offline')).api.getMarketReplenishmentSettings('a'),/offline/)
})
test('limites inclusivos, decimais válidos e entradas inválidas',async()=>{
 const {api,calls}=service()
 for(const f of api.replenishmentSettingsFields){
  for(const v of [f.min,f.max]) assert.doesNotThrow(()=>api.validateReplenishmentSettings({...values,[f.key]:v}))
  for(const v of [f.min-1,f.max+1,NaN,Infinity,'',undefined,f.min+0.001]) {
   await assert.rejects(api.saveMarketReplenishmentSettings('a','s',{...values,[f.key]:v}))
  }
 }
 assert.doesNotThrow(()=>api.validateReplenishmentSettings({...values,coverage_target_days:7.25,acceleration_threshold_pct:30.55}))
 assert.equal(calls.length,0)
})
test('salva apenas quatro parâmetros, com filtros de registro, conta e padrão',async()=>{
 const {api,calls}=service(); await api.saveMarketReplenishmentSettings('account','settings',{...values,demand_method:'m7',store_id:'other'})
 const payload=calls.find(c=>c[0]==='update')[1]
 assert.deepEqual(Object.keys(payload).sort(),[...Object.keys(values),'updated_at'].sort())
 for(const expected of [['eq','id','settings'],['eq','market_account_id','account'],['is','store_id',null]]) assert.ok(calls.some(c=>JSON.stringify(c)===JSON.stringify(expected)))
 assert.equal(calls.at(-1)[0],'single')
})
test('criação somente no padrão, sem upsert nem sobrescrita após conflito',async()=>{
 const {api,calls}=service(); await api.saveMarketReplenishmentSettings('account',null,values)
 assert.equal(calls.find(c=>c[0]==='insert')[1].store_id,null)
 assert.equal(calls.find(c=>c[0]==='insert')[1].market_account_id,'account')
 await assert.rejects(service(null,Error('duplicate')).api.saveMarketReplenishmentSettings('a',null,values),/duplicate/)
 await assert.rejects(service(null,Error('no rows')).api.saveMarketReplenishmentSettings('a','s',values),/no rows/)
})
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)]
const tick=()=>new Promise(r=>setImmediate(r))
function page(overrides={}){
 const states=[],refs=[];let i=0,j=0,started=false;const effects=[];const calls=[]
 const api=service().api
 const Component=load(paths[1],{
  react:{useState:v=>{const n=i++;if(!(n in states))states[n]=v;return [states[n],v=>states[n]=typeof v==='function'?v(states[n]):v]},useRef:v=>refs[j++]??={current:v},useEffect:fn=>{if(!started)effects.push(fn)}},
  'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
  'lucide-react':{ArrowLeft:'icon',Save:'icon'},'./MarketReplenishmentSettings.css':{},
  '../services/marketReplenishmentSettings':{...api,getMarketReplenishmentSettings:async()=>({id:'s',...values}),saveMarketReplenishmentSettings:async(...args)=>{calls.push(args);return {id:'s',...args[2]}},...overrides},
 }).MarketReplenishmentSettings
 return {calls,render(){i=0;j=0;return Component({accountId:'account',onBack(){}})},async init(){this.render();started=true;effects.forEach(f=>f());await tick()}}
}
test('tela carrega, expõe somente quatro campos acessíveis e salva edição',async()=>{
 const h=page(); await h.init(); let tree=h.render()
 const inputs=nodes(tree).filter(n=>n.type==='input'); assert.equal(inputs.length,4)
 assert.equal(inputs[0].props.value,'100'); assert.ok(inputs.every(n=>n.props.required&&n.props['aria-describedby']))
 inputs[0].props.onChange({target:{value:'120'}})
 await nodes(h.render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}})
 assert.equal(h.calls[0][2].normal_list_limit,120)
 assert.ok(nodes(h.render()).some(n=>n.props?.role==='status'))
})
test('erro de carga bloqueia formulário e oferece nova tentativa',async()=>{
 const h=page({getMarketReplenishmentSettings:async()=>{throw Error('offline')}});await h.init()
 assert.ok(nodes(h.render()).some(n=>n.props?.role==='alert'))
 assert.ok(!nodes(h.render()).some(n=>n.type==='form'))
})
test('erro de gravação preserva edição e não anuncia sucesso',async()=>{
 const h=page({saveMarketReplenishmentSettings:async()=>{throw Error('offline')}});await h.init()
 nodes(h.render()).find(n=>n.type==='input').props.onChange({target:{value:'130'}})
 await nodes(h.render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}})
 assert.equal(nodes(h.render()).find(n=>n.type==='input').props.value,'130')
 assert.ok(nodes(h.render()).some(n=>n.props?.role==='alert'))
 assert.ok(!nodes(h.render()).some(n=>n.props?.role==='status'))
})
test('entrada em Produtos restrita à alçada administrativa',()=>{
 const source=readFileSync('src/pages/MarketDashboard.tsx','utf8')
 assert.match(source,/const canConfigureReplenishment = \['owner', 'admin', 'manager'\].includes\(access.role\)/)
 assert.match(source,/showReplenishmentSettings && canConfigureReplenishment/)
 assert.match(source,/Duplicados no cadastro<\/button>\{canConfigureReplenishment/)
})
