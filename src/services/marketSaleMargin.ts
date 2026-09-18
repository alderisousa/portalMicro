import { supabase } from '../lib/supabase'
import type { MarketMemberRole } from '../types/market'

export const canAccessMarketSaleMargin = (role: MarketMemberRole) => ['owner', 'admin', 'manager', 'operator'].includes(role)

export interface SaleMarginRow {
  product_id: string
  product_name: string
  ean: string | null
  code: string | null
  cost: number
  cost_source: 'COMPRA GIROMICRO' | 'ACCESYS'
  purchase_date: string | null
  supplier_name: string | null
  invoice_number: string | null
  sale_price: number
  current_margin_pct: number
  desired_margin_pct: number
  difference_pp: number
}

export async function getMarketSaleMargin(accountId: string, storeId: string): Promise<SaleMarginRow[]> {
  const { data, error } = await supabase.rpc('market_get_sale_margin_analysis', {
    p_market_account_id: accountId, p_store_id: storeId,
  })
  if (error) throw new Error(error.code === 'PGRST202'
    ? 'A consulta de margem de venda ainda precisa ser aplicada no banco.'
    : 'Não foi possível consultar a margem de venda. Confira seu acesso e tente novamente.')
  return (data ?? []) as SaleMarginRow[]
}
