import type { CurrentUserMarketAccess, MarketStore } from './market'

export type BarcodeStatus = 'valid' | 'invalid' | 'missing'
export type ImportResolutionStatus = 'resolved' | 'pending'
export type ImportPreviewRowStatus = 'ok' | 'product_pending' | 'store_pending' | 'store_not_allowed' | 'error'

export interface MarketSalesImportPreviewRow {
  sourceRowNumber: number
  externalStoreCode: string
  externalStoreName: string
  externalEanRaw: string
  barcodeNormalized: string | null
  barcodeStatus: BarcodeStatus
  description: string
  totalCost: number | null
  quantity: number | null
  unitPrice: number | null
  totalAmount: number | null
  profit: number | null
  markup: number | null
  markdown: number | null
  storeId: string | null
  productId: string | null
  storeResolutionStatus: ImportResolutionStatus
  productResolutionStatus: ImportResolutionStatus
  status: ImportPreviewRowStatus
  pendingReason: string | null
  errorCode: string | null
  errorMessage: string | null
  rawData: Record<string, unknown>
}

export interface MarketSalesImportStoreSummary {
  externalCode: string
  externalName: string
  storeId: string | null
  storeName: string | null
  status: 'resolved' | 'not_found' | 'not_allowed'
  rowCount: number
}

export interface MarketSalesImportStats {
  totalRows: number
  validRows: number
  pendingRows: number
  errorRows: number
  distinctStores: number
  recognizedStores: number
  unrecognizedStores: number
  distinctProducts: number
  validBarcodes: number
  invalidBarcodes: number
  missingBarcodes: number
  totalQuantity: number
  totalRevenue: number
  totalCost: number | null
  totalProfit: number | null
}

export interface MarketSalesImportAnalysis {
  fileName: string
  fileSize: number
  fileHash: string
  worksheetName: string
  headerRowNumber: number
  periodStart: string | null
  periodEnd: string | null
  warnings: string[]
  rows: MarketSalesImportPreviewRow[]
  stores: MarketSalesImportStoreSummary[]
  stats: MarketSalesImportStats
}

export interface MarketSalesImportContext {
  access: CurrentUserMarketAccess
  stores: MarketStore[]
  canImport: boolean
  products: Array<{ id: string; ean: string | null }>
  productMappings: Array<{ product_id: string; external_ean: string }>
}

export interface MarketSalesImportBeginResult {
  duplicate: boolean
  resume: boolean
  importId?: string
  persistedRows?: number
  overlapWarning?: boolean
  status?: string
  createdAt?: string
  periodStart?: string | null
  periodEnd?: string | null
}

export interface MarketSalesImportConfirmationResult {
  importId: string
  status: 'completed' | 'completed_with_pending'
  totalRows: number
  processedRows: number
  pendingRows: number
  errorRows: number
  productsCreated: number
  productsAssociated: number
  processedAt: string
}

export type MarketSalesImportConfirmationOutcome =
  | { type: 'overlap' }
  | { type: 'duplicate'; existing: MarketSalesImportBeginResult }
  | { type: 'completed'; result: MarketSalesImportConfirmationResult }

export class MarketSalesImportError extends Error {
  constructor(message: string, public details: string[] = []) {
    super(message)
    this.name = 'MarketSalesImportError'
  }
}
