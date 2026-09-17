import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'
import { fileURLToPath } from 'node:url'
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const compiled = new Map()
for (const path of ['src/utils/replenishmentCycle.ts','src/components/ReplenishmentCycleAction.tsx','src/services/marketReplenishment.ts']) {
  const result = await build({input:fileURLToPath(new URL(`../${path}`,import.meta.url)),external:()=>true,write:false,output:{format:'cjs'},transform:{jsx:'react-jsx'}})
  compiled.set(path,result.output[0].code)
}
function moduleFrom(path, imports, globals = {}) {
  const exports = {}
  const module = { exports }
  runInNewContext(compiled.get(path), {exports, module, require:name => { if (!(name in imports)) throw Error(name); return imports[name] }, console, ...globals})
  return module.exports
}
const errors = moduleFrom('src/utils/replenishmentCycle.ts', {})
const closure = {orderId:'order',summary:{totalNeeds:4,processed:1,readyToSupply:1,awaitingReceipt:1,stillToBuy:1,unknownQuantityNeeds:0,processedUnits:2,readyToSupplyUnits:3,awaitingReceiptUnits:4,stillToBuyKnownUnits:5}}
const items = [{allocationId:'allocation',sourceStoreId:'warehouse',remainingQuantity:3,operationLineId:null,extra:'preservar'}]
const batch = {orderId:'order',items,storeCount:1,productCount:1,allocationCount:1,totalUnits:3,stores:[{storeId:'store',storeName:'Manhattan',allocationCount:1,totalUnits:3}]}
const newCycle = {newOrderId:'new',referenceDate:'2026-09-15'}
const tick = () => new Promise(resolve=>setImmediate(resolve))
// Harness de hooks para exercitar os handlers reais sem rede ou DOM externo.
function harness(mode='close', overrides={}, success=async()=>{}, triggerLabel) {
  const states=[],refs=[]; let s=0,r=0
  const calls=[]
  const services={
    getReplenishmentClosurePreview:async()=>closure,
    getReplenishmentSupplyBatchPreview:async()=>batch,
    closeAndCreateReplenishmentOrder:async(...args)=>{calls.push(args);return newCycle},
    executeReplenishmentSupplyBatch:async(...args)=>{calls.push(args)},...overrides,
  }
  const {ReplenishmentCycleAction:Component}=moduleFrom('src/components/ReplenishmentCycleAction.tsx',{
    react:{useState:initial=>{const i=s++;if(!(i in states))states[i]=initial;return [states[i],value=>{states[i]=value}]},useRef:initial=>{const i=r++;return refs[i]??=( {current:initial} )}},
    'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'},
    'react-dom':{createPortal:node=>node},'./ConfirmDialog':{ConfirmDialog:'dialog'},
    '../services/marketReplenishment':services,'../utils/replenishmentCycle':errors,
  },{document:{body:{}},crypto:{randomUUID:()=> '12345678-1234-4234-8234-123456789012'}})
  function render(){s=0;r=0;return Component({accountId:'account',orderId:'order',mode,onSuccess:success,triggerLabel})}
  return {render,calls,async open(){render().props.children[0].props.onClick();await tick()},dialog(){return nodes(render()).find(n=>n.type==='dialog')}}
}
function nodes(tree){if(!tree||typeof tree!=='object')return [];if(Array.isArray(tree))return tree.flatMap(nodes);return [tree,...nodes(tree.props?.children)]}
function content(tree){if(tree==null||typeof tree==='boolean')return '';if(Array.isArray(tree))return tree.map(content).join(' ');if(typeof tree!=='object')return String(tree);return content(tree.props?.children)}

test('encerramento no aviso inclui rascunho desatualizado; closed continua terminal',()=>{
 const page=read('src/pages/MarketReplenishment.tsx')
 assert.match(page,/orderDetail\?\.isStale === true && \['draft', 'approved', 'in_progress'\]\.includes\(orderDetail.order.status\)/)
 assert.match(page,/overview.run.id !== orderDetail.order.runId/)
 assert.match(page,/orderTerminal =[^\n]+status === 'closed'/)
 assert.match(page,/getMarketReplenishmentOrder\(accountId, result.newOrderId\)/)
})

// Renderiza o JSX real do aviso isolado, sem carregar a página ou consultar o banco.
const pageSource=read('src/pages/MarketReplenishment.tsx')
const noticeStart=pageSource.indexOf('{orderDetail?.isStale === true')
const noticeEnd=pageSource.indexOf('</aside>}',noticeStart)+'</aside>}'.length
const noticeExpression=pageSource.slice(noticeStart+1,noticeEnd-1)
const noticeBuild=await build({input:'notice-test.tsx',write:false,external:id=>id==='react/jsx-runtime',
 plugins:[{name:'notice-test',resolveId:id=>id==='notice-test.tsx'?id:null,load:id=>id==='notice-test.tsx'?{
  code:`export function renderNotice(overview,orderDetail,busy=false){
   const accountId='account', visibleOrderItems=[], number=new Intl.NumberFormat('pt-BR');
   const releasing=busy, approving=false, savingAllocations={};
   const ReplenishmentCycleAction='cycle-action';
   return overview?.run && (${noticeExpression});
  }`,moduleType:'tsx'}:null}],output:{format:'cjs'},transform:{jsx:'react-jsx'}})
compiled.set('notice-test',noticeBuild.output[0].code)
const {renderNotice}=moduleFrom('notice-test',{'react/jsx-runtime':{
 jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),
}})
const overview={run:{id:'latest',productsSelected:10}}
const order=(status,isStale,runId)=>({isStale,order:{id:'order',status,runId}})
const actions=tree=>nodes(tree).filter(node=>node.type==='cycle-action')

test('lista atual na análise mais recente e ausência de batch não oferecem troca',()=>{
 assert.equal(actions(renderNotice(overview,order('draft',false,'latest'))).length,0)
 assert.equal(actions(renderNotice(overview,order('draft',true,'latest'))).length,0)
 assert.equal(actions(renderNotice({run:null},order('draft',true,'old'))).length,0)
 assert.equal(actions(renderNotice(overview,order('draft',false,'old'))).length,0)
})

test('aviso de análise anterior oferece close para draft, approved e in_progress',()=>{
 for(const status of ['draft','approved','in_progress']){
  const result=actions(renderNotice(overview,order(status,true,'old')))
  assert.equal(result.length,1,status)
  assert.equal(result[0].props.mode,'close')
  assert.equal(result[0].props.triggerLabel,'Usar análise mais recente')
  assert.equal(result[0].props.orderId,'order')
  assert.equal(typeof result[0].props.onSuccess,'function')
  assert.equal(actions(renderNotice(overview,order(status,true,'old'),true))[0].props.disabled,true)
 }
 for(const status of ['completed','cancelled','closed'])assert.equal(actions(renderNotice(overview,order(status,true,'old'))).length,0)
})

test('novo texto abre o preview existente; confirmação e texto padrão permanecem iguais',async()=>{
 let previews=0,success=0
 const h=harness('close',{getReplenishmentClosurePreview:async()=>{previews++;return closure}},async()=>{success++},'Usar análise mais recente')
 assert.equal(content(h.render().props.children[0]),'Usar análise mais recente')
 assert.equal(content(harness().render().props.children[0]),'Encerrar e abrir nova lista')
 await h.open()
 assert.equal(previews,1)
 assert.equal(h.calls.length,0)
 assert.equal(h.dialog().props.confirmLabel,'Encerrar e abrir nova lista')
 h.dialog().props.onConfirm();await tick()
 assert.equal(h.calls.length,1)
 assert.equal(success,1)
})
test('preview abre modal com quatro categorias e alerta de estoque pronto',async()=>{
 const h=harness();await h.open();const text=content(h.dialog())
 for(const label of ['Processados','Prontos para abastecer','Aguardando entrada','Ainda para comprar','ATENÇÃO','3','não será desfeito'])assert.ok(text.includes(label),label)
 assert.equal(h.calls.length,0)
})
test('confirmacao usa request-id e so troca ordem depois do sucesso',async()=>{
 let result;const h=harness('close',{},async value=>{result=value});await h.open();h.dialog().props.onConfirm();await tick()
 assert.equal(h.calls[0][2],'12345678-1234-4234-8234-123456789012');assert.equal(result,newCycle);assert.equal(h.dialog(),undefined)
})
test('erro da analise mantem modal e lista, retry preserva request-id e payload',async()=>{
 const ids=[];let changes=0
 const h=harness('close',{closeAndCreateReplenishmentOrder:async(...args)=>{ids.push(args);throw {message:'REPLENISHMENT_FRESH_ANALYSIS_FAILED'}}},async()=>{changes++})
 await h.open();h.dialog().props.onConfirm();await tick();assert.match(content(h.dialog()),/A lista atual foi mantida/)
 h.dialog().props.onConfirm();await tick();assert.deepEqual(ids[0],ids[1]);assert.equal(changes,0)
})
test('double-submit bloqueado enquanto executa e modal permanece processando',async()=>{
 let resolve;let count=0
 const h=harness('close',{closeAndCreateReplenishmentOrder:()=>{count++;return new Promise(r=>{resolve=r})}})
 await h.open();const dialog=h.dialog();dialog.props.onConfirm();dialog.props.onConfirm()
 assert.equal(count,1);assert.equal(h.dialog().props.processing,true);h.dialog().props.onCancel();assert.ok(h.dialog())
 resolve(newCycle);await tick()
})
test('falha de recarga apos commit repete apenas leitura, nunca mutacao',async()=>{
 let refresh=0;const h=harness('close',{},async()=>{if(++refresh===1)throw Error('offline')})
 await h.open();h.dialog().props.onConfirm();await tick();assert.match(content(h.dialog()),/Operação registrada/)
 h.dialog().props.onConfirm();await tick();assert.equal(h.calls.length,1);assert.equal(refresh,2)
})
test('lote mostra resumo por loja e envia exatamente o objeto items do preview',async()=>{
 const h=harness('supply');await h.open();assert.match(content(h.dialog()),/Manhattan/);assert.match(content(h.dialog()),/distribuição física/)
 h.dialog().props.onConfirm();await tick();assert.equal(h.calls[0][2],items)
})
test('batch conflict exibe mensagem e nao executa parcialmente',async()=>{
 const h=harness('supply',{executeReplenishmentSupplyBatch:async()=>{throw {message:'REPLENISHMENT_SUPPLY_BATCH_CONFLICT'}}})
 await h.open();h.dialog().props.onConfirm();await tick();assert.match(content(h.dialog()),/A situação do abastecimento mudou desde a conferência/)
})
test('lote vazio nao confirma e individual permanece disponivel',async()=>{
 const h=harness('supply',{getReplenishmentSupplyBatchPreview:async()=>({...batch,items:[]})});await h.open();assert.equal(h.dialog().props.confirmDisabled,true)
 const ui=read('src/components/ReplenishmentPurchasing.tsx')
 assert.match(ui,/new Set\(supply.map\(line => line.orderId\)\)/);assert.match(ui,/executeReplenishmentStoreSupply\(accountId,line.orderId/)
})
test('closed historico exibe parcelas congeladas e nao tem mutacoes',()=>{
 const ui=read('src/components/ReplenishmentHistory.tsx')
 for(const label of ['Encerrada com pendências','Encerrada','Pronto para abastecer ao encerrar','Aguardando entrada ao encerrar','Ainda para comprar ao encerrar'])assert.ok(ui.includes(label))
 assert.doesNotMatch(ui,/executeReplenishment|setReplenishmentPurchased|<ReplenishmentCycleAction/)
})
test('erros de dominio cobertos e fallback amigavel',()=>{
 for(const code of ['RELIABLE_SALES_DATE_UNAVAILABLE','ORDER_NO_CANDIDATES','FRESH_ANALYSIS_FAILED','ORDER_ACTIVE_CONFLICT','CLOSURE_ORDER_INVALID','SUPPLY_BATCH_CONFLICT'])assert.notEqual(errors.replenishmentCycleError({message:`REPLENISHMENT_${code}`}),errors.replenishmentCycleError({message:'unknown'}))
})
test('modal mobile limita largura e altura, empilha acoes e prende foco',()=>{
 const css=read('src/index.css'),ui=read('src/components/ReplenishmentCycleAction.tsx')
 assert.match(css,/\.replenishment-cycle-dialog[^}]*max-height: calc\(100dvh/)
 assert.match(css,/\.replenishment-cycle-dialog[^}]*overflow-wrap: anywhere/)
 assert.match(css,/\.replenishment-cycle-dialog .confirm-dialog-actions[^}]*flex-direction: column/)
 assert.match(ui,/<ConfirmDialog trapFocus/)
})
test('services encaminham as cinco RPCs e items sem transformacao',async()=>{
 const calls=[]
 const service=moduleFrom('src/services/marketReplenishment.ts',{'../lib/supabase':{supabase:{rpc:async(name,args)=>{calls.push({name,args});return {data:{},error:null}}}},'./marketReconciliation':{},'../utils/marketReplenishment':{}})
 await service.getReplenishmentClosurePreview('a','o');await service.closeReplenishmentOrder('a','o','r');await service.closeAndCreateReplenishmentOrder('a','o','r');await service.getReplenishmentSupplyBatchPreview('a','o');await service.executeReplenishmentSupplyBatch('a','o',items,'r')
 assert.equal(calls.length,5);assert.equal(calls[4].args.p_items,items);assert.equal(calls[4].args.p_request_id,'r')
})
