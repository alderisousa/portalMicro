import { supabase } from '../lib/supabase'
import { getCurrentUserMarketAccess } from './market'
import type {
  MarketInitialInventoryItem,
  MarketInventoryDraft,
  MarketInventoryFinalizeResult,
  MarketInventoryItemRemoveResult,
  MarketInventoryItemSaveResult,
  MarketInventoryReasonCode,
  MarketInventorySessionDetail,
  MarketInventorySessionSummary,
  MarketStockBalanceRow,
  MarketStockContext,
  MarketStockProduct,
  MarketStockStartResult,
  MarketStoreProductSettings,
} from '../types/marketStock'

export async function listActiveProducts(accountId: string): Promise<MarketStockProduct[]> {
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

export async function finalizeMarketInventoryDraft(sessionId: string, expectedVersion: number): Promise<MarketInventoryFinalizeResult> {
  const { data, error } = await supabase.rpc('market_finalize_inventory_draft', {
    p_inventory_session_id: sessionId,
    p_expected_version: expectedVersion,
  })
  if (error) throw error
  return data as MarketInventoryFinalizeResult
}

// Unidade de concorrência = UM produto (202609080005). expectedItemVersion
// null = "acredito que este item ainda não existe" (item novo, nunca salvo).
// Nunca lança para conflito de version — devolve {conflict:true, serverItem}
// para a UI decidir; lança só para erros reais (auth/permissão/sessão indisponível).
export async function saveMarketInventoryItem(
  sessionId: string,
  productId: string,
  quantity: number,
  isCounted: boolean,
  reasonCode: MarketInventoryReasonCode | null,
  reasonNote: string | null,
  expectedItemVersion: number | null,
): Promise<MarketInventoryItemSaveResult> {
  const { data, error } = await supabase.rpc('market_save_inventory_item', {
    p_inventory_session_id: sessionId,
    p_product_id: productId,
    p_quantity: quantity,
    p_is_counted: isCounted,
    p_reason_code: reasonCode,
    p_reason_note: reasonNote,
    p_expected_item_version: expectedItemVersion,
  })
  if (error) throw error
  return data as MarketInventoryItemSaveResult
}

// 202609090001 — "Últimos inventários" da tela inicial de Estoque. Só
// sessões concluídas/canceladas (o rascunho ativo continua vindo de
// getMarketInventoryDraft, não daqui).
export async function listMarketInventorySessions(accountId: string, storeId: string): Promise<MarketInventorySessionSummary[]> {
  const { data, error } = await supabase.rpc('market_list_inventory_sessions', {
    p_market_account_id: accountId,
    p_market_store_id: storeId,
  })
  if (error) throw error
  return (data ?? []) as MarketInventorySessionSummary[]
}

// 202609090001 — detalhe de uma conferência específica (itens/quantidades
// daquele inventário, não o saldo atual da loja).
export async function getMarketInventorySession(sessionId: string): Promise<MarketInventorySessionDetail> {
  const { data, error } = await supabase.rpc('market_get_inventory_session', {
    p_inventory_session_id: sessionId,
  })
  if (error) throw error
  return data as MarketInventorySessionDetail
}

// Estoque mínimo (opcional) por produto/loja — configuração independente da
// sessão de inventário: não é item de contagem, não versiona, nunca gera
// movimento de estoque. RLS de market_store_products (mesma do resto do
// catálogo por loja, ver market_store_products_select na migration 001) já
// exige acesso à loja; nenhuma RPC nova foi necessária para leitura.
export async function listMarketStoreProductSettings(accountId: string, storeId: string): Promise<MarketStoreProductSettings[]> {
  const { data, error } = await supabase
    .from('market_store_products')
    .select('product_id, minimum_stock')
    .eq('market_account_id', accountId)
    .eq('market_store_id', storeId)
  if (error) throw error
  return (data ?? []).map((row) => ({
    productId: row.product_id as string,
    minimumStock: row.minimum_stock === null ? null : Number(row.minimum_stock),
  }))
}

// Upsert mínimo por (market_store_id, product_id) — mesma unique constraint
// da tabela (migration 001). Cria a row só se ainda não existir (produto
// nunca configurado nesta loja); numa row já existente, o ON CONFLICT DO
// UPDATE do PostgREST só toca nas colunas presentes no payload, então
// sale_price/status/is_essential nunca são sobrescritos. RLS de
// market_store_products_write (mesma migration) já exige acesso à loja e
// papel owner/admin/manager/operator — a mesma alçada que já controla o
// resto da tela de Estoque.
export async function saveMarketStoreProductMinimumStock(
  accountId: string,
  storeId: string,
  productId: string,
  minimumStock: number | null,
): Promise<void> {
  const { error } = await supabase
    .from('market_store_products')
    .upsert(
      { market_account_id: accountId, market_store_id: storeId, product_id: productId, minimum_stock: minimumStock },
      { onConflict: 'market_store_id,product_id' },
    )
  if (error) throw error
}

export async function removeMarketInventoryItem(
  sessionId: string,
  productId: string,
  expectedItemVersion: number | null,
): Promise<MarketInventoryItemRemoveResult> {
  const { data, error } = await supabase.rpc('market_remove_inventory_item', {
    p_inventory_session_id: sessionId,
    p_product_id: productId,
    p_expected_item_version: expectedItemVersion,
  })
  if (error) throw error
  return data as MarketInventoryItemRemoveResult
}
