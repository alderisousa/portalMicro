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
  // Quantos outros itens da MESMA compra foram reconhecidos automaticamente
  // (mapping/EAN) porque este item acabou de persistir um de/para. 0 quando
  // "usar esta correspondência" não foi marcado ou não havia código do
  // fornecedor para ancorar o mapping.
  itemsAutoResolved: number
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
