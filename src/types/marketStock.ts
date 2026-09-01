import type { CurrentUserMarketAccess } from './market'

export interface MarketStockProduct {
  id: string
  name: string
  ean: string | null
  sku: string | null
  unit: string
  externalEans: string[]
  externalProductCodes: string[]
}

export interface MarketInitialInventoryItem {
  productId: string
  quantity: number
}

export interface MarketStockBalanceRow {
  marketAccountId: string
  marketStoreId: string
  storeName: string
  stockControlStartedAt: string | null
  productId: string
  productName: string
  ean: string | null
  sku: string | null
  unit: string
  quantityOnHand: number
  lastMovementAt: string
}

export interface MarketStockContext {
  access: CurrentUserMarketAccess
  products: MarketStockProduct[]
  canStart: boolean
}

export interface MarketStockStartResult {
  marketAccountId: string
  marketStoreId: string
  stockControlStartedAt: string
  inventoryItems: number
}

export type MarketInventoryDraftStatus = 'draft' | 'completed' | 'cancelled'

export interface MarketInventoryDraft {
  id: string
  marketAccountId: string
  marketStoreId: string
  status: MarketInventoryDraftStatus
  startedAt: string
  version: number
  createdAt: string
  updatedAt: string
  items: MarketInitialInventoryItem[]
}
