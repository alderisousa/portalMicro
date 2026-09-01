import { supabase } from '../lib/supabase'
import { getCurrentUserMarketAccess } from './market'
import type {
  MarketInitialInventoryItem,
  MarketInventoryDraft,
  MarketStockBalanceRow,
  MarketStockContext,
  MarketStockProduct,
  MarketStockStartResult,
} from '../types/marketStock'

async function listActiveProducts(accountId: string): Promise<MarketStockProduct[]> {
  const { data, error } = await supabase.rpc('market_get_stock_products', {
    p_market_account_id: accountId,
  })
  if (error) throw error
  return (data ?? []) as MarketStockProduct[]
}

export async function getMarketStockContext(accountId: string): Promise<MarketStockContext> {
  const access = await getCurrentUserMarketAccess(accountId)
  if (!access || access.member_status !== 'active') throw new Error('Seu vínculo com esta conta Market não está ativo.')
  if (access.status !== 'pilot' && access.status !== 'active') throw new Error('Esta conta Market não está disponível.')
  return {
    access,
    products: await listActiveProducts(accountId),
    canStart: access.role !== 'viewer',
  }
}

export async function startMarketStockControl(
  storeId: string,
  startedAt: string,
  items: MarketInitialInventoryItem[]
): Promise<MarketStockStartResult> {
  const { data, error } = await supabase.rpc('market_start_stock_control', {
    p_market_store_id: storeId,
    p_started_at: startedAt,
    p_items: items,
  })
  if (error) throw error
  return data as MarketStockStartResult
}

export async function getMarketStockBalance(
  accountId: string,
  storeId: string | null
): Promise<MarketStockBalanceRow[]> {
  const { data, error } = await supabase.rpc('market_get_stock_balance', {
    p_market_account_id: accountId,
    p_market_store_id: storeId,
  })
  if (error) throw error
  return (data ?? []) as MarketStockBalanceRow[]
}

export async function getMarketInventoryDraft(accountId: string, storeId: string): Promise<MarketInventoryDraft | null> {
  const { data, error } = await supabase.rpc('market_get_inventory_draft', {
    p_market_account_id: accountId,
    p_market_store_id: storeId,
  })
  if (error) throw error
  return data as MarketInventoryDraft | null
}

export async function saveMarketInventoryDraft(
  storeId: string,
  sessionId: string | null,
  expectedVersion: number | null,
  startedAt: string,
  items: MarketInitialInventoryItem[]
): Promise<MarketInventoryDraft> {
  const { data, error } = await supabase.rpc('market_save_inventory_draft', {
    p_market_store_id: storeId,
    p_inventory_session_id: sessionId,
    p_expected_version: expectedVersion,
    p_started_at: startedAt,
    p_items: items,
  })
  if (error) throw error
  return data as MarketInventoryDraft
}

export async function cancelMarketInventoryDraft(sessionId: string, expectedVersion: number): Promise<void> {
  const { error } = await supabase.rpc('market_cancel_inventory_draft', {
    p_inventory_session_id: sessionId,
    p_expected_version: expectedVersion,
  })
  if (error) throw error
}

export async function finalizeMarketInventoryDraft(sessionId: string, expectedVersion: number): Promise<MarketStockStartResult> {
  const { data, error } = await supabase.rpc('market_finalize_inventory_draft', {
    p_inventory_session_id: sessionId,
    p_expected_version: expectedVersion,
  })
  if (error) throw error
  return data as MarketStockStartResult
}
