import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'

const compiled = {}
for (const page of ['AdminMarketAccount', 'MarketDashboard']) {
  const result = await build({ input: `src/pages/${page}.tsx`, external: () => true, write: false, output: { format: 'cjs' }, transform: { jsx: 'react-jsx' } })
  compiled[page] = result.output[0].code
}

const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree)
  ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const text = tree => typeof tree === 'string' ? tree : Array.isArray(tree)
  ? tree.map(text).join(' ') : tree && typeof tree === 'object' ? text(tree.props?.children) : ''
const find = (tree, type, label) => nodes(tree).find(n => n.type === type && text(n).includes(label))
function harness(page, imports, props={accountId:'a',onBack(){}}) {
  const states=[], effects=[], memo=[], pending=[];let si=0,ei=0,mi=0
  const react={
    useState(initial){const i=si++;if(!(i in states))states[i]=typeof initial==='function'?initial():initial;return [states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v}]},
    useEffect(fn,deps){const i=ei++;if(!effects[i]||deps.some((v,j)=>v!==effects[i].deps[j]))pending.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()}})},
    useMemo(fn,deps){const i=mi++;if(!memo[i]||deps.some((v,j)=>v!==memo[i].deps[j]))memo[i]={deps,value:fn()};return memo[i].value},
  }
  react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps)
  const module={exports:{}}
  const source=compiled[page]
  const jsx=(type,props)=>({type,props})
  runInNewContext(source,{module,exports:module.exports,console,require:id=>({react,'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':{},...imports})[id]??{}})
  const Component=module.exports[page]
  return {render(){si=ei=mi=0;return Component(props)},async flush(){for(let i=0;i<6;i++){this.render();pending.splice(0).forEach(fn=>fn());await new Promise(r=>setImmediate(r))}return this.render()}}
}

for(const role of ['owner','admin','manager','operator','viewer']) test(`manual on home for ${role}, with no stores`,async()=>{
  const app=harness('MarketDashboard',{
    '../services/market':{getCurrentUserMarketAccess:async()=>({name:'Teste',member_status:'active',status:'active',role,stores:[]})},
    '../services/marketSalesSync':{getMarketSalesSyncContext:async()=>({integrationAvailable:false})},
    '../services/marketDashboardPermissions':{canAccessMarketSalesImports:()=>false},
    '../services/marketStoreProductParameters':{canEditStoreProductParameters:()=>false},
    '../services/marketSaleMargin':{canAccessMarketSaleMargin:()=>false},
    '../utils/marketPosition':{readMarketPosition:()=>null,canRestoreMarketModule:()=>true,saveMarketModule(){}},
  })
  const tree=await app.flush(),link=find(tree,'a','Abrir Manual')
  assert.ok(link);assert.equal(link.props.href,'/docs/GiroMicro_Market_Manual_Operacional.pdf')
  assert.equal(link.props.target,'_blank');assert.equal(link.props.rel,'noopener noreferrer')
  assert.ok(text(tree).includes('Consulte o fluxo recomendado de operação do GiroMicro Market.'))
  assert.equal(readFileSync('public/docs/GiroMicro_Market_Manual_Operacional.pdf').subarray(0,5).toString(),'%PDF-')
})

function admin({disabled=true,eligible=false,reject=false}={}) {
  const members=[{id:'owner',user_id:'owner',role:'owner',status:'active',all_stores:true},
    {id:'invited',user_id:'invited',role:'viewer',status:'invited',all_stores:true},
    ...(disabled?[{id:'disabled',user_id:'disabled',role:'operator',status:'disabled',all_stores:true}]:[])]
  const saved=[],deleted=[]
  const app=harness('AdminMarketAccount',{
    '../services/adminUsers':{listAuthenticatedUsers:async()=>members.map(m=>({user_id:m.id,full_name:m.id,email:`${m.id}@example.com`}))},
    '../services/market':{
      getMarketAccount:async()=>({id:'a',name:'Teste',status:'active',plan_code:'pilot'}),
      listMarketMembers:async()=>members,listMarketStores:async()=>[],
      getMarketAccountDeletionEligibility:async()=>eligible,
      updateMarketMemberAccess:async(...args)=>saved.push(args),
      deleteEmptyMarketAccount:async(...args)=>{deleted.push(args);if(reject)throw new Error('MARKET_NOT_EMPTY')},
    },
  })
  return {app,saved,deleted}
}

test('disabled hidden by default; toggle allows editing/reactivation; owner remains protected',async()=>{
  const {app,saved}=admin();let tree=await app.flush()
  assert.ok(text(tree).includes('invited@example.com'));assert.ok(!text(tree).includes('disabled@example.com'))
  const label=find(tree,'label','Mostrar desativados')
  nodes(label).find(n=>n.type==='input').props.onChange({target:{checked:true}})
  tree=app.render();const row=find(tree,'article','disabled@example.com')
  find(row,'button','Editar acesso').props.onClick()
  tree=app.render();const status=find(nodes(tree).find(n=>n.props?.role==='dialog'),'label','Status')
  nodes(status).find(n=>n.type==='select').props.onChange({target:{value:'active'}})
  tree=app.render();await nodes(tree).find(n=>n.type==='form'&&n.props.role==='dialog').props.onSubmit({preventDefault(){}})
  assert.equal(saved.length,1);assert.equal(saved[0][1],'disabled');assert.equal(saved[0][3],'active')
  tree=await app.flush();assert.equal(find(find(tree,'article','owner@example.com'),'button','Editar acesso'),undefined)
})

test('no disabled members means no filter control',async()=>{
  const {app}=admin({disabled:false});assert.equal(find(await app.flush(),'label','Mostrar desativados'),undefined)
})

test('delete requires eligibility and explicit name; backend refusal is understandable',async()=>{
  const denied=admin();assert.equal(find(await denied.app.flush(),'button','Excluir Market'),undefined)
  const {app,deleted}=admin({eligible:true,reject:true});let tree=await app.flush()
  find(tree,'button','Excluir Market').props.onClick();tree=app.render()
  assert.equal(find(tree,'button','Excluir permanentemente').props.disabled,true)
  assert.ok(text(tree).includes('Esta ação não pode ser desfeita'))
  nodes(find(tree,'label','Digite o nome')).find(n=>n.type==='input').props.onChange({target:{value:'Teste'}})
  tree=app.render();assert.equal(find(tree,'button','Excluir permanentemente').props.disabled,false)
  await nodes(tree).find(n=>n.type==='form'&&n.props.role==='dialog').props.onSubmit({preventDefault(){}})
  tree=app.render();assert.equal(deleted.length,1);assert.ok(text(tree).includes('Nenhum dado foi apagado'))
})
