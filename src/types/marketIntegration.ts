export type MarketIntegrationStatus = 'active' | 'inactive'

export interface MarketIntegrationConfiguration {
  id: string
  marketAccountId: string
  provider: 'accesys'
  baseUrl: string
  externalCompanyId: string
  username: string | null
  status: MarketIntegrationStatus | 'error'
  lastTestAt: string | null
  lastTestSucceeded: boolean | null
  lastTestError: string | null
  hasCredentials: boolean
}

export interface SaveMarketIntegrationInput {
  marketAccountId: string
  integrationId?: string
  externalCompanyId: string
  username: string
  password?: string
  status: MarketIntegrationStatus
}

export interface MarketProductCatalogPreview {
  providerHttpStatus: number
  rootType: 'object' | 'array'
  rootKeys: string[]
  collectionKey: string | null
  returnedCount: number
  productKeys: string[]
  paginationMetadata: Record<string, unknown>
  products: unknown[]
  requestedPage: number
  pageSize: number
}

export type MarketProductSyncStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
export interface MarketProductSyncRun {
  id: string
  marketAccountId: string
  integrationId: string
  status: MarketProductSyncStatus
  currentPage: number
  totalPages: number | null
  pageSize: number
  receivedCount: number
  createdCount: number
  updatedCount: number
  unchangedCount: number
  ignoredCount: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  heartbeatAt: string | null
  finishedAt: string | null
}

export type MarketSalesSyncStatus = 'running' | 'completed' | 'partial' | 'failed'

export interface MarketSalesSyncRequest {
  marketAccountId: string
  integrationId: string
  startDate: string
  endDate: string
  runId?: string
}

export interface MarketSalesSyncResult {
  syncRunId: string
  status: MarketSalesSyncStatus
  period: { startDate: string; endDate: string }
  pagesRead: number
  ordersRead: number
  ordersInserted: number
  ordersUpdated: number
  itemsProcessed: number
  paymentsProcessed: number
  skippedOrders: number
  currentDay: string | null
  lastCompletedDay: string | null
  totalDays: number
  completedDays: number
  continue: boolean
  unmappedSites: Array<{ externalStoreId: string; siteName: string | null }>
  errors: Array<{
    externalOrderId: string | null
    externalStoreId: string | null
    code: string
  }>
}
