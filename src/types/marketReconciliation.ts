export interface ReconciliationCandidate {
  productId: string
  name: string
  sku: string | null
  ean: string | null
  unit: string
  externalProductId: string | null
  score: number
  matchReasons: string[]
}

export interface CatalogSearchResult {
  productId: string
  name: string
  sku: string | null
  ean: string | null
  unit: string
  externalProductId: string | null
}

export interface ReconciliationConfirmResult {
  purchaseItemId: string
  marketProductId: string
  reconciliationStatus: 'matched_manual'
}

export interface ReconciliationUndoResult {
  purchaseItemId: string
  reconciliationStatus: 'pending'
}

export interface ReprocessPurchasePendingResult {
  purchaseId: string
  itemsProcessed: number
  itemsMatched: number
  itemsStillPending: number
}
