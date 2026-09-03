export type MarketDashboardQuality = 'updated' | 'consolidated' | 'stale' | 'incomplete' | 'overlap' | 'no_data'

export interface MarketDashboardGap { startDate: string; endDate: string }

export interface MarketCommercialStore { id: string; name: string; externalCode: string | null }
export interface MarketCommercialTotals { revenue: number; cost: number | null; profit: number | null; quantity: number; margin: number | null; orderCount?: number | null }
export interface MarketStorePerformance extends MarketCommercialTotals { storeId: string; storeName: string; externalCode: string | null }
export interface MarketProductRankingItem {
  product_key: string
  product_id: string | null
  product_name: string
  identifier: string | null
  quantity: number
  revenue: number | null
  profit: number | null
}
export interface MarketCommercialDashboardData {
  source: 'import' | 'sync'
  accountName: string
  periodStart: string | null
  periodEnd: string | null
  importCount: number
  orderCount: number | null
  costAvailable: boolean
  hasOverlap: boolean
  hasGaps: boolean
  gapCount: number
  gaps: MarketDashboardGap[]
  quality: MarketDashboardQuality
  stores: MarketCommercialStore[]
  totals: MarketCommercialTotals | null
  storePerformance: MarketStorePerformance[]
  topByQuantity: MarketProductRankingItem[]
  topByRevenue: MarketProductRankingItem[]
  topByProfit: MarketProductRankingItem[]
  negativeProfit: MarketProductRankingItem[]
}
