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

export type MarketSalesSyncStatus = 'completed' | 'partial' | 'failed'

export interface MarketSalesSyncRequest {
  marketAccountId: string
  integrationId: string
  startDate: string
  endDate: string
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
  unmappedSites: Array<{ externalStoreId: string; siteName: string | null }>
  errors: Array<{
    externalOrderId: string | null
    externalStoreId: string | null
    code: string
  }>
}
