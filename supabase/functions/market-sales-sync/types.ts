export type JsonObject = Record<string, unknown>

export interface NormalizedSaleItem {
  productId: null
  externalItemId: string
  externalProductId: string
  externalEan: string | null
  externalDescription: string | null
  quantity: number
  unitPrice: number
  salePrice: number
  totalAmount: number
  discountAmount: number
  netAmount: number
  unitCostSnapshot: null
  totalCostSnapshot: null
}

export interface NormalizedSalePayment {
  externalPaymentId: string
  amount: number
  paidAt: string | null
  method: string | null
  description: string | null
  brand: string | null
  cardType: string | null
  authorizationId: string | null
  rawData: null
}

export interface NormalizedSale {
  externalOrderId: string
  externalStoreId: string
  soldAt: string
  itemsQuantity: number
  subtotalAmount: number
  discountAmount: number
  couponAmount: number
  totalAmount: number
  externalStatus: string | null
  isRefunded: boolean
  hasError: boolean
  itemsSnapshotComplete: boolean
  paymentsSnapshotComplete: boolean
  rawData: null
}

export interface NormalizedOrderSnapshot {
  sale: NormalizedSale
  items: NormalizedSaleItem[]
  payments: NormalizedSalePayment[]
}

export interface AccesysPage {
  page: number
  pages: number
  records: number
  orders: NormalizedOrderSnapshot[]
}
