import type { MarketSalesSyncResult } from './marketIntegration'

export type MarketSalesRefreshResult = MarketSalesSyncResult

export interface MarketSalesSyncStatus {
  runId: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  periodStart: string
  periodEnd: string
  startedAt: string
  heartbeatAt: string | null
  finishedAt: string | null
  ordersRead: number
  ordersInserted: number
  ordersUpdated: number
  itemsProcessed: number
  paymentsProcessed: number
  skippedOrders: number
  errorMessage: string | null
}
