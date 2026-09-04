export type MarketPurchaseStatus =
  | 'imported'
  | 'reconciling'
  | 'pending'
  | 'ready'
  | 'receiving'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type MarketPurchaseSourceType = 'qrcode' | 'nfe' | 'xml' | 'pdf' | 'image' | 'import' | 'api'

export type MarketPurchaseItemReconciliationStatus =
  | 'pending'
  | 'matched_auto'
  | 'matched_manual'
  | 'mapped'
  | 'not_found'
  | 'needs_review'

export type MarketPurchaseItemStockEntryStatus = 'pending' | 'ready' | 'received' | 'ignored' | 'blocked'

export interface MarketPurchaseItem {
  id: string
  marketAccountId: string
  marketPurchaseId: string
  lineNumber: number
  supplierProductCode: string | null
  barcodeRaw: string | null
  barcodeNormalized: string | null
  descriptionRaw: string | null
  ncm: string | null
  cfop: string | null
  unit: string | null
  quantity: number
  unitPrice: number | null
  grossAmount: number | null
  discountAmount: number
  freightAmount: number
  otherAmount: number
  netAmount: number | null
  calculatedUnitCost: number | null
  marketProductId: string | null
  reconciliationStatus: MarketPurchaseItemReconciliationStatus
  reconciliationConfidence: number | null
  reconciliationMethod: string | null
  reconciliationNotes: string | null
  stockEntryStatus: MarketPurchaseItemStockEntryStatus
  createdAt: string
  updatedAt: string
}

export interface MarketPurchase {
  id: string
  marketAccountId: string
  destinationStoreId: string
  supplierName: string | null
  supplierDocument: string | null
  invoiceNumber: string | null
  invoiceSeries: string | null
  invoiceKey: string | null
  issuedAt: string | null
  receivedAt: string | null
  totalAmount: number | null
  productsAmount: number | null
  freightAmount: number | null
  discountAmount: number | null
  otherAmount: number | null
  status: MarketPurchaseStatus
  sourceType: MarketPurchaseSourceType
  sourceReference: string | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export interface MarketPurchaseDetail extends MarketPurchase {
  items: MarketPurchaseItem[]
}

export interface MarketPurchaseProgress {
  totalItems: number
  reconciledItems: number
  receivedItems: number
  pendingItems: number
}

export interface MarketPurchaseListItem extends MarketPurchase, MarketPurchaseProgress {}

export type MarketPurchaseImportSourceType = 'qrcode_url' | 'access_key'
export type MarketPurchaseImportMode = 'import' | 'reimport'

export interface MarketPurchaseImportRequest {
  marketAccountId: string
  destinationStoreId: string
  sourceType: MarketPurchaseImportSourceType
  sourceValue: string
  // Omitido/'import': fluxo normal (idempotente, retorna duplicate:true se ja existir).
  // 'reimport': substitui atomicamente uma compra existente e reimportavel (ver
  // isPurchaseReimportEligible) — o backend revalida a elegibilidade de qualquer forma.
  mode?: MarketPurchaseImportMode
}

export interface MarketPurchaseImportResult {
  purchaseId: string
  invoiceKey: string
  invoiceNumber: string | null
  supplierName: string | null
  itemCount: number
  reconciliation: { matched: number; pending: number }
  status: MarketPurchaseStatus
  duplicate: boolean
}

export interface MarketPurchaseImportDraft {
  purchase: Omit<MarketPurchase, 'id' | 'createdBy' | 'createdAt' | 'updatedAt'>
  items: Array<Omit<MarketPurchaseItem, 'id' | 'marketPurchaseId' | 'createdAt' | 'updatedAt' | 'calculatedUnitCost'>>
  rawPayload?: unknown
}
