import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync(new URL('../src/utils/replenishmentPurchaseDisplay.ts', import.meta.url), 'utf8')
const js = stripTypeScriptTypes(source)
const { missingReplenishmentPurchases: missing } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const item = (id, name, quantity, overrides = {}) => ({ id, productId: id, productName: name, status: 'pending',
  allocations: [{ storeId: 'manhatan', storeName: 'EDIFÍCIL MANHATAN', status: 'pending', priorityLevel: 'high', purchaseNeededQuantity: quantity }], ...overrides })
const order = { order: { status: 'in_progress' }, isStale: true, canSupersede: false, purchase: { pendingLines: 2 }, items: [
  item('guarana', 'ANTARCTICA GUARANA LATA 350ML', 3), item('cafe', '3 CORACAO CAFE TRADICIONAL 500G', 1),
  item('bubbaloo', 'Chiclete Bubbaloo Uva 5g', 0, { status: 'fulfilled' }),
] }

test('ordem antiga in_progress: dois pendentes e meta 4 aparecem mesmo sem declarações', () => {
  const rows = missing(order, [], '')
  assert.equal(rows.length, order.purchase.pendingLines)
  assert.deepEqual(rows.map(row => [row.productName, row.targetQuantity]), [[order.items[0].productName, 3], [order.items[1].productName, 1]])
  assert.equal(rows[0].stores[0].storeName, 'EDIFÍCIL MANHATAN')
  assert.equal(missing(order, [], 'outra-loja').length, 0)
})

test('declaração existente prevalece, inclusive comprado; não duplica fallback', () => {
  assert.deepEqual(missing(order, [{ productId: 'guarana', purchasedQuantity: 3 }], '').map(row => row.id), ['cafe'])
  assert.equal(missing(order, [{ productId: 'guarana' }, { productId: 'cafe' }], '').length, 0)
})

test('LOW, cancelados e abastecimento sem compra permanecem excluídos', () => {
  const low = item('low', 'LOW', 5)
  low.allocations[0].priorityLevel = 'low'
  const cancelledAllocation = item('cancelled-allocation', 'Cancelado', 1)
  cancelledAllocation.allocations[0].status = 'cancelled'
  assert.equal(missing({ ...order, items: [...order.items, low, cancelledAllocation, item('cancelled', 'Cancelado', 2, { status: 'cancelled' })] }, [], '').length, 2)
})

test('atualizar a mesma ordem recarrega compras e fallback não oferece mutações', () => {
  const component = readFileSync(new URL('../src/components/ReplenishmentPurchasing.tsx', import.meta.url), 'utf8')
  const page = readFileSync(new URL('../src/pages/MarketReplenishment.tsx', import.meta.url), 'utf8')
  assert.match(page, /orderDetail=\{orderDetail\}/)
  assert.match(component, /\[reload, orderDetail\]/)
  assert.match(component, /length \+ missing.length/)
  const fallback = component.split('{missing.map(')[1].split('</>')[0]
  assert.doesNotMatch(fallback, /onClick|mark\(|mutate\(/)
  assert.doesNotMatch(page + component, /market_supersede_replenishment_order|market_cancel_replenishment_order\(/)
})
