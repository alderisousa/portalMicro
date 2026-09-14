import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const base=new URL('./replenishment-post-purchase-db.test.mjs',import.meta.url)
// Reuse the existing fixture (schema through 005, plan/buy/status/read helpers)
// without running its suite.
let source=readFileSync(base,'utf8').split('\ncontractTest(')[0]
source=source.replaceAll(',import.meta.url)',`, ${JSON.stringify(base.href)})`)
const fixture=await import(`data:text/javascript;base64,${Buffer.from(source+'\nexport {db,query,account,request,contractTest,plan,buy,status,read};').toString('base64')}`)
const {db,query,account,request,contractTest,plan,buy,status,read}=fixture

const migrationPath=new URL('../supabase/migrations/202609140006_backfill_replenishment_purchase_progress.sql',import.meta.url)
const migrationSql=readFileSync(migrationPath,'utf8')
// Strip the migration's own begin/commit: each contractTest already runs
// inside its own transaction (rolled back afterwards), so a nested
// begin/commit would break that isolation instead of a real manual apply.
const migrationBody=migrationSql.split('\nbegin;\n')[1].split('\ncommit;')[0]
const backfill=()=>db.exec(migrationBody)

const lines=(id,product)=>query(`select l.id,l.confirmed_quantity,l.target_quantity from market_replenishment_operation_lines l
 join market_replenishment_order_allocations a on a.id=l.allocation_id
 join market_replenishment_order_items i on i.id=a.order_item_id
 where l.order_id=$1 and l.operation_type='purchase' and i.product_id=$2 order by a.id`,[id,product])

// Reproduces the pre-004 legacy state: purchased_quantity already declared,
// but confirmed_quantity/order status never advanced together with it. Bypasses
// the production guards on purpose, the same way the existing FIFO-by-UUID
// fixture does, only to build the synthetic starting point for the migration.
async function forceLegacy(id,product,confirmedValues) {
 const rows=await lines(id,product)
 // Flush pending deferred trigger events first; Postgres refuses to
 // (DIS/EN)ABLE TRIGGER on a table with events still pending in this xact.
 await db.exec('set constraints all immediate')
 await db.exec('alter table market_replenishment_operation_lines disable trigger user;alter table market_replenishment_orders disable trigger user')
 for(let i=0;i<rows.length;i++) await query('update market_replenishment_operation_lines set confirmed_quantity=$1,completed_at=null,completed_by=null where id=$2',[confirmedValues[i]??0,rows[i].id])
 await query("update market_replenishment_orders set status='in_progress',completed_at=null,completed_by=null where id=$1",[id])
 await db.exec('alter table market_replenishment_operation_lines enable trigger user;alter table market_replenishment_orders enable trigger user')
}

contractTest('caso A: target1 purchased1 confirmed0 vira confirmed1 e conclui a ordem pelo helper oficial',async()=>{
 const {id,product}=await plan([1]);await buy(id,1)
 await forceLegacy(id,product,[0])
 assert.equal(await status(id),'in_progress')
 await backfill()
 assert.deepEqual((await lines(id,product)).map(r=>Number(r.confirmed_quantity)),[1])
 assert.equal(await status(id),'completed')
})

contractTest('caso B: target3 purchased3 confirmed0 vira confirmed3 e conclui a ordem pelo helper oficial',async()=>{
 const {id,product}=await plan([3]);await buy(id,3)
 await forceLegacy(id,product,[0])
 await backfill()
 assert.deepEqual((await lines(id,product)).map(r=>Number(r.confirmed_quantity)),[3])
 assert.equal(await status(id),'completed')
})

contractTest('caso C: multiplas linhas todas em zero recebem a distribuicao FIFO correta; ordem nao conclui se sobrar alvo',async()=>{
 const {id,product}=await plan([2,2,1]);await buy(id,3)
 await forceLegacy(id,product,[0,0,0])
 await backfill()
 assert.deepEqual((await lines(id,product)).map(r=>Number(r.confirmed_quantity)),[2,1,0])
 assert.equal(await status(id),'in_progress')
})

contractTest('caso E: qualquer confirmed_quantity>0 ja existente na declaracao mantem a declaracao inteira intocada',async()=>{
 const {id,product}=await plan([2,2,1]);await buy(id,3)
 // Estado legado sintetico: alguma correcao parcial anterior deixou a
 // primeira linha com 1 (soma da declaracao > 0). A 006 nao redistribui aqui:
 // trata como risco residual fora do escopo, em vez de decidir por conta
 // propria o que fazer com o progresso ja existente.
 await forceLegacy(id,product,[1,0,0])
 const before=await lines(id,product), statusBefore=await status(id)
 await backfill()
 assert.deepEqual(await lines(id,product),before)
 assert.equal(await status(id),statusBefore)
})

contractTest('caso D: reexecutar a 006 nao muda nada (idempotente)',async()=>{
 const {id,product}=await plan([1]);await buy(id,1)
 await forceLegacy(id,product,[0])
 await backfill()
 const linesBefore=await lines(id,product), statusBefore=await status(id)
 await backfill()
 assert.deepEqual(await lines(id,product),linesBefore)
 assert.equal(await status(id),statusBefore)
 assert.equal(statusBefore,'completed')
})

contractTest('declaracoes coerentes ou em outros status permanecem intocadas',async()=>{
 const {id,product}=await plan([3]);await buy(id,3)
 const before=await lines(id,product), statusBefore=await status(id)
 await backfill()
 assert.deepEqual(await lines(id,product),before)
 assert.equal(await status(id),statusBefore)
})

test('migration 006 nao toca 003/004/005 nem cria efeitos fora do escopo declarado',()=>{
 // Varre somente o bloco executavel (do $$ ... $$), nao os comentarios do
 // cabecalho que citam de proposito o que este backfill NAO faz.
 const executable=migrationBody
 assert.doesNotMatch(executable,/insert\s+into\s+(public\.)?market_stock_movements/i)
 assert.doesNotMatch(executable,/market_replenishment_purchase_nf_links/i)
 assert.doesNotMatch(executable,/market_replenishment_receipt_allocations/i)
 assert.doesNotMatch(executable,/market_replenishment_supply_executions/i)
 assert.doesNotMatch(executable,/purchased_quantity\s*=/i)
 assert.doesNotMatch(executable,/purchase_version/i)
 assert.match(executable,/market_complete_replenishment_order_internal/)
})
