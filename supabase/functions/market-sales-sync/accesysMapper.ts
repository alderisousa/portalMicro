import { parseAccesysDateTime } from './dateTime.ts'
import { parseAccesysMoney } from './money.ts'
import type { AccesysPage, JsonObject, NormalizedOrderSnapshot } from './types.ts'

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`SYNC_INVALID_PAYLOAD: ${field} deve ser objeto.`)
  }
  return value as JsonObject
}

function externalId(value: unknown, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new Error(`SYNC_INVALID_ID: ${field} e obrigatorio.`)
  }
  if (typeof value === 'number' && (!Number.isInteger(value) || !Number.isSafeInteger(value))) {
    throw new Error(`SYNC_INVALID_ID: ${field} numerico deve ser inteiro seguro.`)
  }
  return String(value).trim()
}

function numberField(value: unknown, field: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(`SYNC_INVALID_NUMBER: ${field} possui valor invalido.`)
  }
  return value
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.trim() || null
}

function completeArray(container: JsonObject, key: string): { complete: boolean; values: unknown[] } {
  if (!Object.prototype.hasOwnProperty.call(container, key)) return { complete: false, values: [] }
  if (!Array.isArray(container[key])) {
    throw new Error(`SYNC_INVALID_PAYLOAD: ${key} presente deve ser array.`)
  }
  return { complete: true, values: container[key] as unknown[] }
}

export function mapAccesysOrder(value: unknown): NormalizedOrderSnapshot {
  const envelope = object(value, 'item')
  const order = object(envelope.order, 'order')
  const itemSnapshot = completeArray(envelope, 'orderItems')
  const paymentSnapshot = completeArray(envelope, 'orderPayments')
  const statusSnapshot = completeArray(envelope, 'orderStatuses')
  const statuses = statusSnapshot.values.map((entry) => object(entry, 'orderStatuses[]'))

  // Sem ordenacao oficial do provider, somente um status e tratado como atual.
  // Com varios status, preservamos apenas os indicadores cumulativos seguros.
  const singleStatus = statuses.length === 1 ? statuses[0] : null
  const items = itemSnapshot.values.map((entry) => {
    const item = object(entry, 'orderItems[]')
    return {
      productId: null,
      externalItemId: externalId(item.id, 'orderItems[].id'),
      externalProductId: externalId(item.productId, 'orderItems[].productId'),
      externalEan: text(item.sku),
      externalDescription: text(item.description),
      quantity: numberField(item.quantity, 'orderItems[].quantity', true),
      unitPrice: parseAccesysMoney(item.unitValue, 'orderItems[].unitValue'),
      salePrice: parseAccesysMoney(item.salePrice, 'orderItems[].salePrice'),
      // totalValue representa o total bruto da linha; totalSalePrice nao o substitui.
      totalAmount: parseAccesysMoney(item.totalValue, 'orderItems[].totalValue'),
      discountAmount: parseAccesysMoney(item.discount, 'orderItems[].discount'),
      netAmount: parseAccesysMoney(item.netValue, 'orderItems[].netValue'),
      unitCostSnapshot: null,
      totalCostSnapshot: null,
    }
  })

  const payments = paymentSnapshot.values.map((entry) => {
    const payment = object(entry, 'orderPayments[]')
    return {
      externalPaymentId: externalId(payment.id, 'orderPayments[].id'),
      amount: parseAccesysMoney(payment.amount, 'orderPayments[].amount'),
      paidAt: payment.date == null ? null : parseAccesysDateTime(payment.date, 'orderPayments[].date'),
      method: text(payment.description),
      description: text(payment.detailDescription),
      brand: text(payment.detailBrand),
      cardType: text(payment.detailCardType),
      authorizationId: text(payment.authorizationId),
      rawData: null,
    }
  })

  return {
    sale: {
      externalOrderId: externalId(order.id, 'order.id'),
      externalStoreId: externalId(order.siteId, 'order.siteId'),
      soldAt: parseAccesysDateTime(order.createdAt, 'order.createdAt'),
      // itemsSumQuantity e a soma de unidades; itemsQuantity pode representar linhas.
      itemsQuantity: numberField(order.itemsSumQuantity, 'order.itemsSumQuantity'),
      subtotalAmount: parseAccesysMoney(order.itemsTotalValue, 'order.itemsTotalValue'),
      discountAmount: parseAccesysMoney(order.discountsAmount, 'order.discountsAmount'),
      couponAmount: parseAccesysMoney(order.couponValue, 'order.couponValue'),
      totalAmount: parseAccesysMoney(order.totalValue, 'order.totalValue'),
      externalStatus: singleStatus ? text(singleStatus.status) : null,
      isRefunded: statuses.some((status) => status.refunded === true),
      hasError: statuses.some((status) => status.error === true),
      itemsSnapshotComplete: itemSnapshot.complete,
      paymentsSnapshotComplete: paymentSnapshot.complete,
      rawData: null,
    },
    items,
    payments,
  }
}

export function mapAccesysPage(value: unknown): AccesysPage {
  const payload = object(value, 'response')
  const page = numberField(payload.page, 'page', true)
  const pages = numberField(payload.pages, 'pages', true)
  const records = numberField(payload.records, 'records')
  if (!Number.isInteger(page) || !Number.isInteger(pages) || !Number.isInteger(records) || page > pages) {
    throw new Error('SYNC_INVALID_PAGINATION: page, pages e records devem ser inteiros coerentes.')
  }
  if (!Array.isArray(payload.items)) throw new Error('SYNC_INVALID_PAYLOAD: items deve ser array.')
  return { page, pages, records, orders: payload.items.map(mapAccesysOrder) }
}

export function nextAccesysPage(currentPage: number, pages: number): number | null {
  return currentPage < pages ? currentPage + 1 : null
}
