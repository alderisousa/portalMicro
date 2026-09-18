import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'
const paths=['src/utils/marketPosition.ts','src/pages/MarketDashboard.tsx','src/pages/MarketStockDashboard.tsx','src/pages/MarketReplenishment.tsx','src/components/ReplenishmentPurchasing.tsx','src/utils/marketStockBalance.ts','src/utils/replenishmentPurchaseDisplay.ts']
const code={}
for(const path of paths){const r=await build({input:path,external:()=>true,write:false,output:{format:'cjs'},transform:{jsx:'react-jsx'}});code[path]=r.output[0].code}
const memory=new Map()
const localStorage={getItem:k=>memory.get(k)??null,setItem:(k,v)=>memory.set(k,v),removeItem:k=>memory.delete(k)}
const window={setTimeout:()=>0,addEventListener(){},removeEventListener(){}}
function load(path,imports={}){const module={exports:{}};runInNewContext(code[path],{module,exports:module.exports,require:id=>imports[id]??{},console,localStorage,window,document:{},Intl,Date});return module.exports}
const api=load(paths[0]);const plain=x=>JSON.parse(JSON.stringify(x));const tick=()=>new Promise(r=>setImmediate(r))
const nodes=t=>!t||typeof t!=='object'?[]:Array.isArray(t)?t.flatMap(nodes):[t,...nodes(t.props?.children)]
const stores=[{id:'s',name:'Loja',status:'active',store_type:'store'},{id:'s2',name:'Outra',status:'active',store_type:'store'},{id:'inactive',status:'inactive',store_type:'store'}]
const access={id:'a',name:'Market',role:'manager',member_status:'active',status:'active',stores}
const position=(module,extra={})=>({version:1,userId:'u',marketAccountId:'a',module,...extra})
function harness(path,name,props,imports={}){
 const states=[],refs=[],effects=[],memo=[];let si=0,ri=0,ei=0,mi=0;const queued=[]
 const react={useState:initial=>{const n=si++;if(!(n in states))states[n]=typeof initial==='function'?initial():initial;return [states[n],v=>states[n]=typeof v==='function'?v(states[n]):v]},useRef:initial=>refs[ri++]??={current:initial},
 useEffect:(fn,deps)=>{const n=ei++;if(!effects[n]||!deps||deps.some((v,i)=>v!==effects[n].deps[i]))queued.push(()=>{effects[n]?.cleanup?.();effects[n]={deps,cleanup:fn()}})},
 useMemo:(fn,deps)=>{const n=mi++;if(!memo[n]||deps.some((v,i)=>v!==memo[n].deps[i]))memo[n]={deps,value:fn()};return memo[n].value}}
 react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps)
 const Component=load(path,{react,'react/jsx-runtime':{jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'fragment'},
 'lucide-react':new Proxy({},{get:()=> 'icon'}),'../utils/marketPosition':api,...imports})[name]
 return {render(){si=ri=ei=mi=0;return Component(props)},async flush(times=8){for(let i=0;i<times;i++){this.render();queued.splice(0).forEach(f=>f());await tick()}return this.render()},unmount(){effects.forEach(e=>e.cleanup?.())}}
}
test.beforeEach(()=>memory.clear())
test('isolamento usuario/Market, versao e whitelist de contexto',()=>{
 api.writeMarketPosition(position('stock',{stock:{storeId:'s',counting:true,items:[{quantity:99}],query:'secret'},token:'secret'}))
 assert.equal(api.readMarketPosition('other'),null);assert.equal(api.readMarketPosition('u','other'),null)
 const restored=api.readMarketPosition('u','a')
 assert.ok(typeof restored.savedAt==='number'&&Date.now()-restored.savedAt<1000)
 const {savedAt,...rest}=restored
 assert.deepEqual(plain(rest),position('stock',{stock:{storeId:'s',counting:true}}))
 const key=[...memory.keys()][0];for(const raw of ['{broken',JSON.stringify({...position('stock'),version:2}),JSON.stringify({...position('stock'),userId:'other'}),JSON.stringify(position('unknown')),JSON.stringify({...position('stock'),savedAt:'now'})]){
  memory.set(key,raw);assert.equal(api.readMarketPosition('u'),null);assert.equal(memory.has(key),false)
 }
})
test('posicao expira ao completar 60 minutos parada; abaixo do limite ainda restaura',()=>{
 const hour=60*60*1000
 for(const [ageMs,shouldRestore] of [[hour-1,true],[hour,false],[hour+60000,false]]){
  api.writeMarketPosition(position('stock',{stock:{storeId:'s',counting:true}}))
  const key=[...memory.keys()][0]
  const stored=JSON.parse(memory.get(key))
  memory.set(key,JSON.stringify({...stored,savedAt:Date.now()-ageMs}))
  const result=api.readMarketPosition('u','a')
  assert.equal(!!result,shouldRestore,`idade ${ageMs}ms deveria restaurar=${shouldRestore}`)
  assert.equal(memory.has(key),shouldRestore,`posicao expirada deve ser removida (idade ${ageMs}ms)`)
 }
})
test('expiracao nao contorna isolamento por usuario/conta',()=>{
 api.writeMarketPosition(position('stock',{stock:{storeId:'s',counting:true}}))
 const key=[...memory.keys()][0]
 const stored=JSON.parse(memory.get(key))
 memory.set(key,JSON.stringify({...stored,savedAt:Date.now()-1000}))
 assert.equal(api.readMarketPosition('other'),null)
 assert.equal(api.readMarketPosition('u','other-account'),null)
 assert.equal(api.readMarketPosition('u','a').module,'stock')
})
test('armazenamento indisponivel nao bloqueia; logout limpa somente usuario',()=>{
 api.writeMarketPosition(position('stock'));api.writeMarketPosition({...position('purchases'),userId:'other'})
 api.clearMarketPosition('u');assert.equal(api.readMarketPosition('u'),null);assert.equal(api.readMarketPosition('other').module,'purchases')
 const get=localStorage.getItem;localStorage.getItem=()=>{throw Error('blocked')};assert.equal(api.readMarketPosition('other'),null);localStorage.getItem=get
 const set=localStorage.setItem;localStorage.setItem=()=>{throw Error('quota')};assert.doesNotThrow(()=>api.writeMarketPosition(position('stock')));localStorage.setItem=set
})
test('conta e contexto inativos nao restauram; modulo segue role e integracao',()=>{
 assert.equal(api.accessiblePositionAccount(position('stock'),[{...access,status:'suspended'}]),undefined)
 assert.equal(api.accessiblePositionAccount(position('stock'),[{...access,id:'other'}]),undefined)
 assert.equal(api.validPositionStore('inactive',stores),'')
 assert.equal(api.canRestoreMarketModule('saleMargin','viewer',false),false)
 assert.equal(api.canRestoreMarketModule('storeProductParameters','operator',false),true)
 assert.equal(api.canRestoreMarketModule('purchases','operator',false),false)
 assert.equal(api.canRestoreMarketModule('imports','manager',null),false)
 assert.equal(api.canRestoreMarketModule('imports','manager',true),false)
 assert.equal(api.canRestoreMarketModule('imports','manager',false),true)
})
const moduleComponents={stock:'MarketStockDashboard',replenishment:'MarketReplenishment',purchases:'MarketPurchases',commercial:'MarketCommercialDashboard',imports:'MarketSalesImports',duplicates:'MarketDuplicateProducts',replenishmentSettings:'MarketReplenishmentSettings',storeProductParameters:'MarketStoreProductParameters',saleMargin:'MarketSaleMargin'}
function dashboard(role='manager',integration=false){
 const imports={'../services/market':{getCurrentUserMarketAccess:async()=>({...access,role})},'../services/marketSalesSync':{getMarketSalesSyncContext:async()=>({integrationAvailable:integration})},
 '../services/marketDashboardPermissions':{canAccessMarketSalesImports:(r,i)=>api.canRestoreMarketModule('imports',r,i)},'../services/marketStoreProductParameters':{canEditStoreProductParameters:r=>r!=='viewer'},'../services/marketSaleMargin':{canAccessMarketSaleMargin:r=>r!=='viewer'}}
 for(const component of Object.values(moduleComponents))imports[`./${component}`]={[component]:component}
 return harness(paths[1],'MarketDashboard',{userId:'u',accountId:'a',header:null,onBack(){}},imports)
}
test('restaura todos os modulos somente depois do acesso; contextos nao sao apagados na montagem',async()=>{
 for(const [module,component] of Object.entries(moduleComponents)){
  api.writeMarketPosition(position(module,{stock:{storeId:'s',counting:true},replenishment:{orderId:'o',storeId:'s',view:'waiting'}}))
  const h=dashboard();assert.ok(!nodes(h.render()).some(n=>n.type===component));await h.flush()
  assert.ok(nodes(h.render()).some(n=>n.type===component),module)
  assert.equal(api.readMarketPosition('u').module,module)
  if(module==='stock')assert.equal(api.readMarketPosition('u').stock.counting,true)
  h.unmount()
 }
})
test('modulo sem permissao e importacoes indisponiveis caem no Dashboard',async()=>{
 api.writeMarketPosition(position('saleMargin'));const h=dashboard('viewer');await h.flush()
 assert.ok(!nodes(h.render()).some(n=>n.type==='MarketSaleMargin'));assert.equal(api.readMarketPosition('u').module,'dashboard')
 api.writeMarketPosition(position('imports'));await dashboard('manager',true).flush();assert.equal(api.readMarketPosition('u').module,'dashboard')
})
function stock(draft,canStart=true){
 const calls=[]
 const services={getMarketStockContext:async()=>({access,canStart}),getMarketStockBalance:async(...a)=>{calls.push(['balance',...a]);return []},getMarketInventoryDraft:async(...a)=>{calls.push(['draft',...a]);return draft},listMarketInventorySessions:async()=>[],listMarketStoreProductSettings:async()=>[],listActiveProducts:async()=>[],saveMarketInventoryDraft:async()=>{throw Error('must not create')}}
 const h=harness(paths[2],'MarketStockDashboard',{userId:'u',accountId:'a',onBack(){}},{'../services/marketStock':services,'../services/marketIntegration':{findAccesysIntegrationId:async()=>null},'../utils/marketStockBalance':load(paths[5])})
 return {...h,calls}
}
test('estoque relê loja e rascunho, retoma contagem; nao persiste itens',async()=>{
 api.writeMarketPosition(position('stock',{stock:{storeId:'s2',counting:true}}))
 const draft={id:'d',marketAccountId:'a',marketStoreId:'s2',status:'draft',inventoryType:'cycle',startedAt:'2026-09-18',updatedAt:'2026-09-18',items:[]}
 const h=stock(draft);await h.flush()
 assert.ok(h.calls.some(c=>c[0]==='draft'&&c[2]==='s2'))
 assert.deepEqual(plain(api.readMarketPosition('u').stock),{storeId:'s2',counting:true})
 assert.equal(JSON.stringify(api.readMarketPosition('u')).includes('items'),false)
})
test('estoque sem draft/finalizado/sem permissao/loja revogada nao ressuscita contagem',async()=>{
 for(const variant of ['absent','completed','viewer','inactive']){
  api.writeMarketPosition(position('stock',{stock:{storeId:variant==='inactive'?'inactive':'s',counting:true}}))
  const draft=variant==='absent'?null:{id:'d',marketAccountId:'a',marketStoreId:'s',status:variant==='completed'?'completed':'draft',inventoryType:'cycle',startedAt:'2026-09-18',updatedAt:'2026-09-18',items:[]}
  await stock(draft,variant!=='viewer').flush()
  assert.equal(api.readMarketPosition('u').stock.counting,false,variant)
  assert.equal(api.readMarketPosition('u').stock.storeId,'s')
 }
})
function replenishment(result){
 const calls=[];return {calls,...harness(paths[3],'MarketReplenishment',{userId:'u',accountId:'a',stores,onBack(){}},{'../services/marketReplenishment':{
 getMarketReplenishmentOverview:async()=>({run:null,stores:[]}),getMarketReplenishmentOrder:async(...args)=>{calls.push(args);if(result instanceof Error)throw result;return result},generateMarketReplenishmentOrderDraft:async()=>{throw Error('must not generate')}},'./MarketStockDashboard':{findMarketStockProducts:()=>[]},'../utils/marketReplenishment':{}})}
}
const detail={order:{id:'o',marketAccountId:'a',status:'approved'},items:[{status:'pending',allocations:[{storeId:'s',storeName:'Loja',status:'pending',priorityLevel:'high'}]}]}
test('reposicao restaura ordem/contexto e abas sem gerar lista; Consolidada fica vazia',async()=>{
 for(const view of ['buy','waiting','supply'])for(const storeId of ['s','']){
  api.writeMarketPosition(position('replenishment',{replenishment:{orderId:'o',storeId,view}}))
  const h=replenishment(detail);await h.flush();assert.deepEqual(h.calls,[['a','o']])
  assert.deepEqual(plain(api.readMarketPosition('u').replenishment),{orderId:'o',storeId,view})
 }
})
test('ordem ausente, fechada, outra conta e erro fazem fallback; loja revogada cai em Consolidada',async()=>{
 for(const result of [null,Error('denied'),{...detail,order:{...detail.order,status:'closed'}},{...detail,order:{...detail.order,marketAccountId:'other'}}]){
  api.writeMarketPosition(position('replenishment',{replenishment:{orderId:'o',storeId:'s',view:'supply'}}));await replenishment(result).flush()
  assert.equal(api.readMarketPosition('u').replenishment.orderId,'')
 }
 api.writeMarketPosition(position('replenishment',{replenishment:{orderId:'o',storeId:'denied',view:'waiting'}}));await replenishment(detail).flush()
 assert.equal(api.readMarketPosition('u').replenishment.storeId,'')
})
test('Purchasing aceita aba inicial e informa troca sem persistir filtros/linhas',async()=>{
 const changed=[];const h=harness(paths[4],'ReplenishmentPurchasing',{accountId:'a',storeId:'',orderId:'o',orderDetail:{...detail,items:[]},initialView:'waiting',onViewChange:v=>changed.push(v)},
 {'../services/marketReplenishment':{getReplenishmentPurchasing:async()=>[],getReplenishmentStoreSupply:async()=>[]},'../utils/replenishmentPurchaseDisplay':load(paths[6])})
 await h.flush();let tabs=nodes(h.render()).filter(n=>n.type==='button'&&'aria-pressed'in n.props)
 assert.equal(tabs[1].props['aria-pressed'],true);tabs[2].props.onClick();assert.deepEqual(changed,['supply'])
 assert.equal(nodes(h.render()).filter(n=>n.type==='button'&&'aria-pressed'in n.props)[2].props['aria-pressed'],true)
})
test('App retoma apenas apos leitura autenticada dos acessos e limpa no logout explicito',()=>{
 const source=readFileSync('src/App.tsx','utf8')
 assert.match(source,/listCurrentUserMarketAccounts\(\)[\s\S]*?readMarketPosition\(currentUserId\)[\s\S]*?accessiblePositionAccount\(position, accounts\)/)
 const logout=source.slice(source.indexOf('const logout = async () => {'),source.indexOf('const logout = async () => {')+220)
 assert.match(logout,/clearMarketPosition\(currentUserId\)/)
 assert.ok(source.includes('key={`${currentUserId}:${access.id}`}'))
})
