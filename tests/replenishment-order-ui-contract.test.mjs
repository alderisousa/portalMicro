import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const page = readFileSync(new URL('../src/pages/MarketReplenishment.tsx', import.meta.url), 'utf8')
const service = readFileSync(new URL('../src/services/marketReplenishment.ts', import.meta.url), 'utf8')

test('frontend revisa allocations somente no contexto de uma loja', () => {
  assert.match(service, /supabase\.rpc\('market_update_replenishment_allocation_review'/)
  assert.match(service, /p_market_account_id: accountId,\s+p_order_id: orderId,\s+p_allocation_id: allocationId,\s+p_warehouse_quantity: warehouseQuantity,\s+p_purchase_quantity: purchaseQuantity/s)
  assert.doesNotMatch(page + service, /market_update_replenishment_order_item_quantity/)
  assert.match(page, /isDraftOrder && contextStoreId && storeAllocation && inputs/)
  assert.match(page, /\['warehouse', 'purchase'\] as const/)
})

test('frontend mantém consolidada somente leitura e sem inclusão manual', () => {
  assert.match(page, /!contextStoreId && <div className="market-replenishment-order-allocations">/)
  assert.match(page, /isDraftOrder && contextStoreId && <div className="market-replenishment-manual">/)
  assert.doesNotMatch(page, /isDraftOrder && !contextStoreId[^\n]*Adicionar produto/)
  assert.doesNotMatch(page, /!contextStoreId[^\n]*market-replenishment-quantity-edit/)
})

test('frontend preserva aprovação da lista inteira', () => {
  assert.match(page, /approveMarketReplenishmentOrder\(accountId, orderDetail\.order\.id\)/)
  assert.match(page, /Aprovar lista/)
})
