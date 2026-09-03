import type { MarketSalesSyncResult } from './marketIntegration'

export type MarketSalesRefreshResult = MarketSalesSyncResult

export interface MarketSalesSyncStatus {
  runId: string
  status: 'running' | 'completed' | 'partial' | 'failed'
  periodStart: string
  periodEnd: string
  nextDay: string | null
  lastCompletedDay: string | null
  totalDays: number
  completedDays: number
  pagesRead: number
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

export interface MarketSalesSyncContext {
  integrationAvailable: boolean
  sync: MarketSalesSyncStatus | null
}
