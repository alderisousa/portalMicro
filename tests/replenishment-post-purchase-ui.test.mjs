import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const src=readFileSync(new URL('../src/utils/replenishmentPurchaseDisplay.ts',import.meta.url),'utf8')
const {purchaseWorkQueues}=await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(src)).toString('base64')}`)
const line={id:'declaration',orderId:'order',targetQuantity:5,purchasedQuantity:2,receivedQuantity:0,
 stores:[{allocationId:'a',storeId:'store',storeName:'Manhattan',targetQuantity:5,purchasedQuantity:2,receivedQuantity:0,awaitingQuantity:2,deliveredQuantity:0,remainingPhysical:5}]}
test('partial purchase participates in buy and waiting by quantity',()=>{
 const queues=purchaseWorkQueues([line],'')
 assert.equal(queues.buy[0].quantity,3)
 assert.equal(queues.waiting[0].store.awaitingQuantity,2)
 assert.equal(queues.history.length,1)
})
test('full acquired leaves buy; attributed receipt leaves waiting; store filter is respected',()=>{
 const full={...line,purchasedQuantity:5,stores:[{...line.stores[0],purchasedQuantity:5,awaitingQuantity:5}]}
 assert.equal(purchaseWorkQueues([full],'').buy.length,0)
 assert.equal(purchaseWorkQueues([full],'').waiting.length,1)
 const received={...full,receivedQuantity:5,stores:[{...full.stores[0],receivedQuantity:5,awaitingQuantity:0}]}
 assert.equal(purchaseWorkQueues([received],'').waiting.length,0)
 assert.equal(purchaseWorkQueues([received],'other').history.length,0)
})
test('normal UI has three queues, no invoice selection or reconciliation button, reads across completed orders',()=>{
 const ui=readFileSync(new URL('../src/components/ReplenishmentPurchasing.tsx',import.meta.url),'utf8')
 for(const label of ['Comprar','Aguardando entrada','Abastecer']) assert.ok(ui.includes(`label: '${label}'`))
 assert.doesNotMatch(ui,/label: 'Histórico'/)
 assert.doesNotMatch(ui,/NF correspondente|Vincular quantidade|linkReplenishmentPurchaseNf|checkInvoices|<select/)
 assert.match(ui,/getReplenishmentPurchasing\(accountId, null\)/)
 assert.match(ui,/getReplenishmentStoreSupply\(accountId, null,/)
 assert.match(ui,/line.canCorrect && line.committedQuantity === 0/)
 assert.match(ui,/request.current.id/)
})
test('Histórico é uma área própria, independente da lista/ordem atual, reusando as mesmas fontes',()=>{
 const ui=readFileSync(new URL('../src/components/ReplenishmentHistory.tsx',import.meta.url),'utf8')
 assert.match(ui,/getReplenishmentPurchasing\(accountId, null\)/)
 assert.match(ui,/getReplenishmentDeliveryHistory/)
 assert.match(ui,/purchaseWorkQueues/)
 assert.doesNotMatch(ui,/interface Props[^}]*(orderDetail|orderId)/)
 const page=readFileSync(new URL('../src/pages/MarketReplenishment.tsx',import.meta.url),'utf8')
 assert.match(page,/<ReplenishmentHistory/)
 // O botao/secao de Histórico nao pode estar dentro do bloco condicionado a
 // orderDetail existir com status approved/in_progress/completed.
 const historySection=page.split('Histórico de Reposição')[1]?.slice(0,400) ?? ''
 assert.doesNotMatch(historySection,/orderDetail\.order\.status/)
})
