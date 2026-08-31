import { supabase } from '../lib/supabase'
import type { MarketCommercialDashboardData } from '../types/marketCommercialDashboard'

export async function getMarketCommercialDashboard(accountId: string, storeId: string | null): Promise<MarketCommercialDashboardData> {
  const { data, error } = await supabase.rpc('market_get_commercial_dashboard', {
    p_market_account_id: accountId,
    p_market_store_id: storeId,
  })
  if (error) throw error
  return data as MarketCommercialDashboardData
}
