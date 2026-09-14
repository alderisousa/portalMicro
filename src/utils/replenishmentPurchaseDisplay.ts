import type { MarketReplenishmentOrderDetail, ReplenishmentPurchaseLine } from '../types/marketReplenishment'

export function purchaseWorkQueues(lines: ReplenishmentPurchaseLine[], storeId: string) {
  const scoped = lines.filter(line => !storeId || line.stores.some(store => store.storeId === storeId))
  return {
    buy: scoped.map(line => ({ line, quantity: line.stores.filter(store => !storeId || store.storeId === storeId)
      .reduce((sum, store) => sum + Math.max(0, store.targetQuantity - store.purchasedQuantity), 0) })).filter(entry => entry.quantity > 0),
    waiting: scoped.flatMap(line => line.stores.filter(store => (!storeId || store.storeId === storeId) && store.awaitingQuantity > 0).map(store => ({ line, store }))),
    history: scoped.filter(line => (line.purchasedQuantity ?? 0) > 0 || line.receivedQuantity > 0),
  }
}

// Legacy orders may have purchase allocations but no purchase declarations.
// Keep those needs visible without manufacturing IDs for purchase mutations.
export function missingReplenishmentPurchases(order: MarketReplenishmentOrderDetail, lines: ReplenishmentPurchaseLine[], storeId: string) {
  const declared = new Set(lines.map((line) => line.productId))
  return order.items.flatMap((item) => {
    if (declared.has(item.productId) || !['pending', 'partial'].includes(item.status)) return []
    const stores = item.allocations.filter((allocation) => allocation.status !== 'cancelled'
      && allocation.priorityLevel !== 'low' && (allocation.purchaseNeededQuantity ?? 0) > 0
      && (!storeId || allocation.storeId === storeId))
      .map((allocation) => ({ storeId: allocation.storeId, storeName: allocation.storeName, targetQuantity: allocation.purchaseNeededQuantity! }))
    return stores.length ? [{ id: item.id, productName: item.productName, stores,
      targetQuantity: stores.reduce((sum, store) => sum + store.targetQuantity, 0) }] : []
  })
}
