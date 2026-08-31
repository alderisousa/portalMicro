export type MarketDashboardQuality = 'updated' | 'consolidated' | 'stale' | 'incomplete' | 'overlap' | 'no_data'

export interface MarketDashboardGap { startDate: string; endDate: string }

export interface MarketCommercialStore { id: string; name: string; externalCode: string | null }
export interface MarketCommercialTotals { revenue: number; cost: number; profit: number; quantity: number; margin: number | null }
export interface MarketStorePerformance extends MarketCommercialTotals { storeId: string; storeName: string; externalCode: string | null }
export interface MarketProductRankingItem {
  product_key: string
  product_id: string | null
  product_name: string
  identifier: string | null
  quantity: number
  revenue: number
  profit: number
}
export interface MarketCommercialDashboardData {
  accountName: string
  periodStart: string | null
  periodEnd: string | null
  importCount: number
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
