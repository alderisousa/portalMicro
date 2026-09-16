import { supabase } from '../lib/supabase'
import { listMarketProductsByIds } from './marketReconciliation'
import { groupReplenishmentCandidatesByStore } from '../utils/marketReplenishment'
import type { MarketStore } from '../types/market'
import type {
  MarketReplenishmentCandidate, MarketReplenishmentOrderDetail, MarketReplenishmentOverview, MarketReplenishmentRunSummary,
  MarketReplenishmentTriggerReason,
  ReplenishmentPurchaseLine,
  ReplenishmentSupplyLine,
  ReplenishmentDelivery,
  ReplenishmentOrderHistorySummary,
  ReplenishmentOrderHistoryItem,
} from '../types/marketReplenishment'

export async function getReplenishmentDeliveryHistory(accountId: string, storeId: string | null): Promise<ReplenishmentDelivery[]> {
  const { data, error } = await supabase.rpc('market_get_replenishment_delivery_history', { p_market_account_id: accountId, p_store_id: storeId })
  if (error) throw error
  return data as ReplenishmentDelivery[]
}

export async function getReplenishmentPurchasing(accountId: string, orderId: string | null): Promise<ReplenishmentPurchaseLine[]> {
  const { data, error } = await supabase.rpc('market_get_replenishment_purchasing', { p_market_account_id: accountId, p_order_id: orderId })
  if (error) throw error
  return data as ReplenishmentPurchaseLine[]
}

export async function setReplenishmentPurchased(accountId: string, orderId: string,
  changes: Array<{ declarationId: string; version: number; quantity: number | null }>, requestId: string): Promise<void> {
  const { error } = await supabase.rpc('market_set_replenishment_purchased', {
    p_market_account_id: accountId, p_order_id: orderId, p_changes: changes, p_request_id: requestId,
  })
  if (error) throw error
}

export async function linkReplenishmentPurchaseNf(accountId: string, orderId: string, lineId: string,
  itemId: string, quantity: number, requestId: string): Promise<void> {
  const { error } = await supabase.rpc('market_link_replenishment_purchase_nf', {
    p_market_account_id: accountId, p_order_id: orderId, p_declaration_id: lineId,
    p_purchase_item_id: itemId, p_quantity: quantity, p_request_id: requestId,
  })
  if (error) throw error
}

// Lista de ordens (sem p_order_id) ou detalhe por necessidade de uma ordem
// (com orderId) para a tela de Historico. Ver market_get_replenishment_order_history
// (202609150002) para a definicao de pendente/processado.
export async function getReplenishmentOrderHistory(accountId: string, storeId: string | null): Promise<ReplenishmentOrderHistorySummary[]> {
  const { data, error } = await supabase.rpc('market_get_replenishment_order_history', { p_market_account_id: accountId, p_order_id: null, p_store_id: storeId })
  if (error) throw error
  return data as ReplenishmentOrderHistorySummary[]
}

export async function getReplenishmentOrderHistoryDetail(accountId: string, orderId: string, storeId: string | null): Promise<ReplenishmentOrderHistoryItem[]> {
  const { data, error } = await supabase.rpc('market_get_replenishment_order_history', { p_market_account_id: accountId, p_order_id: orderId, p_store_id: storeId })
  if (error) throw error
  return data as ReplenishmentOrderHistoryItem[]
}

export async function getReplenishmentStoreSupply(accountId: string, orderId: string | null, storeId: string | null): Promise<ReplenishmentSupplyLine[]> {
  const { data, error } = await supabase.rpc('market_get_replenishment_store_supply', {
    p_market_account_id: accountId, p_order_id: orderId, p_store_id: storeId,
  })
  if (error) throw error
  return data as ReplenishmentSupplyLine[]
}

export async function executeReplenishmentStoreSupply(accountId: string, orderId: string, allocationId: string,
  operationLineId: string | null, sourceStoreId: string, quantity: number, requestId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('market_execute_replenishment_store_supply', {
    p_market_account_id: accountId, p_order_id: orderId, p_allocation_id: allocationId,
    p_warehouse_operation_line_id: operationLineId, p_source_store_id: sourceStoreId,
    p_quantity: quantity, p_request_id: requestId,
  })
  if (error) throw error
  return data
}

// Leitura direta (sem RPC): market_replenishment_runs/market_replenishment_candidates
// já têm policy de select própria (market_is_member / market_is_member +
// market_can_access_store, ver 202609100001-006), no mesmo padrão de leitura
// direta já usado em listMarketProductsByIds/marketPurchases.ts. Nenhuma
// escrita é feita por este serviço.

interface RunRow {
  id: string
  reference_date: string
  finished_at: string | null
  stores_processed: number
  products_selected: number
  critical_count: number
  high_count: number
  medium_count: number
  low_count: number
}

function toRunSummary(row: RunRow): MarketReplenishmentRunSummary {
  return {
    id: row.id,
    referenceDate: row.reference_date,
    finishedAt: row.finished_at,
    storesProcessed: row.stores_processed,
    productsSelected: row.products_selected,
    criticalCount: row.critical_count,
    highCount: row.high_count,
    mediumCount: row.medium_count,
    lowCount: row.low_count,
  }
}

// Último run com status='completed' e is_effective=true — exatamente o
// critério pedido. Nunca dispara o batch: só lê o que já foi persistido.
// Entre reference_date diferentes (reprocessamentos de datas antigas não
// afetam isto), o mais recente por reference_date/started_at é "o último".
async function getLatestEffectiveRun(accountId: string): Promise<MarketReplenishmentRunSummary | null> {
  const { data, error } = await supabase
    .from('market_replenishment_runs')
    .select('id, reference_date, finished_at, stores_processed, products_selected, critical_count, high_count, medium_count, low_count')
    .eq('market_account_id', accountId)
    .eq('status', 'completed')
    .eq('is_effective', true)
    .order('reference_date', { ascending: false })
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ? toRunSummary(data as RunRow) : null
}

interface CandidateRow {
  id: string
  store_id: string
  product_id: string
  current_stock: number | null
  minimum_stock: number | null
  coverage_days: number | null
  avg_daily_m7: number | null
  suggested_quantity: number | null
  warehouse_stock: number | null
  trigger_reasons: MarketReplenishmentTriggerReason[]
  priority_score: number
  priority_level: MarketReplenishmentCandidate['priorityLevel']
  rank_position: number
}

async function listCandidatesForRun(accountId: string, runId: string): Promise<Omit<MarketReplenishmentCandidate, 'productName'>[]> {
  const { data, error } = await supabase
    .from('market_replenishment_candidates')
    .select('id, store_id, product_id, current_stock, minimum_stock, coverage_days, avg_daily_m7, suggested_quantity, warehouse_stock, trigger_reasons, priority_score, priority_level, rank_position')
    .eq('market_account_id', accountId)
    .eq('run_id', runId)
  if (error) throw error
  return (data ?? []).map((row: CandidateRow) => ({
    id: row.id,
    storeId: row.store_id,
    productId: row.product_id,
    currentStock: row.current_stock,
    minimumStock: row.minimum_stock,
    coverageDays: row.coverage_days,
    avgDailyM7: row.avg_daily_m7,
    suggestedQuantity: row.suggested_quantity,
    warehouseStock: row.warehouse_stock,
    triggerReasons: row.trigger_reasons,
    priorityScore: row.priority_score,
    priorityLevel: row.priority_level,
    rankPosition: row.rank_position,
  }))
}

// Visão completa da tela de Abastecimento: último run efetivo + seus
// candidatos, com nome de produto resolvido e já agrupados/ordenados por
// loja (groupReplenishmentCandidatesByStore — nenhum novo algoritmo de
// prioridade, só as contagens critical/high/medium/low já persistidas por
// candidato). stores deve vir de CurrentUserMarketAccess.stores (já respeita
// o acesso do usuário) — este serviço não busca lojas por conta própria.
export async function getMarketReplenishmentOverview(
  accountId: string,
  stores: MarketStore[],
): Promise<MarketReplenishmentOverview> {
  const run = await getLatestEffectiveRun(accountId)
  if (!run) return { run: null, stores: [] }

  const candidates = await listCandidatesForRun(accountId, run.id)
  const productIds = Array.from(new Set(candidates.map((candidate) => candidate.productId)))
  const products = await listMarketProductsByIds(accountId, productIds)
  const productNameById = new Map(products.map((product) => [product.id, product.name]))

  const namedCandidates: MarketReplenishmentCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    productName: productNameById.get(candidate.productId) ?? 'Produto não encontrado',
  }))

  return { run, stores: groupReplenishmentCandidatesByStore(namedCandidates, stores) }
}

export async function generateMarketReplenishmentOrderDraft(accountId: string): Promise<string> {
  const { data, error } = await supabase.rpc('market_generate_replenishment_order_draft', {
    p_market_account_id: accountId,
  })
  if (error) throw error
  if (typeof data !== 'string') throw new Error('A lista de compras retornou um identificador inválido.')
  return data
}

export async function getMarketReplenishmentOrder(
  accountId: string,
  orderId: string | null = null,
): Promise<MarketReplenishmentOrderDetail | null> {
  const { data, error } = await supabase.rpc('market_get_replenishment_order', {
    p_market_account_id: accountId,
    p_order_id: orderId,
  })
  if (error) throw error
  return data as MarketReplenishmentOrderDetail | null
}

export async function updateMarketReplenishmentAllocationReview(
  accountId: string,
  orderId: string,
  allocationId: string,
  warehouseQuantity: number,
  purchaseQuantity: number,
): Promise<string> {
  const { data, error } = await supabase.rpc('market_update_replenishment_allocation_review', {
    p_market_account_id: accountId,
    p_order_id: orderId,
    p_allocation_id: allocationId,
    p_warehouse_quantity: warehouseQuantity,
    p_purchase_quantity: purchaseQuantity,
  })
  if (error) throw error
  return data as string
}

export async function addMarketReplenishmentOrderManualItem(
  accountId: string,
  orderId: string,
  productId: string,
  purchaseQuantity: number,
  storeId: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('market_add_replenishment_order_manual_item', {
    p_market_account_id: accountId,
    p_order_id: orderId,
    p_product_id: productId,
    p_purchase_quantity: purchaseQuantity,
    p_store_id: storeId,
  })
  if (error) throw error
  return data as string
}

export async function cancelMarketReplenishmentOrderItemReview(
  accountId: string,
  orderId: string,
  orderItemId: string,
  cancellationReason = 'Retirado durante a revisão pré-compra',
): Promise<string> {
  const { data, error } = await supabase.rpc('market_cancel_replenishment_order_item_review', {
    p_market_account_id: accountId,
    p_order_id: orderId,
    p_order_item_id: orderItemId,
    p_cancellation_reason: cancellationReason,
  })
  if (error) throw error
  return data as string
}

// Libera UMA loja dentro da ordem consolidada (202609150003): revisa/valida
// somente as allocations ativas dessa loja e cria as operation_lines dela,
// sem exigir que as demais lojas da mesma ordem tambem estejam prontas.
// Idempotente por p_request_id; reinvocar para uma loja ja liberada cobre
// allocations novas (ex.: item manual incluido depois) sem duplicar nada.
export async function releaseMarketReplenishmentOrderStore(
  accountId: string,
  orderId: string,
  storeId: string,
  requestId?: string,
): Promise<string> {
  const { data, error } = await supabase.rpc('market_release_replenishment_order_store', {
    p_market_account_id: accountId,
    p_order_id: orderId,
    p_store_id: storeId,
    ...(requestId ? { p_request_id: requestId } : {}),
  })
  if (error) throw error
  return data as string
}

export async function approveMarketReplenishmentOrder(accountId: string, orderId: string): Promise<string> {
  const { data, error } = await supabase.rpc('market_approve_replenishment_order', {
    p_market_account_id: accountId,
    p_order_id: orderId,
  })
  if (error) throw error
  return data as string
}

export async function getReplenishmentClosurePreview(accountId: string, orderId: string): Promise<import('../types/marketReplenishment').ReplenishmentClosurePreview> {
  const { data, error } = await supabase.rpc('market_get_replenishment_closure_preview', { p_market_account_id: accountId, p_order_id: orderId })
  if (error) throw error
  return data
}
export async function closeReplenishmentOrder(accountId: string, orderId: string, requestId: string, reason: string | null = null): Promise<import('../types/marketReplenishment').ReplenishmentClosurePreview> {
  const { data, error } = await supabase.rpc('market_close_replenishment_order', { p_market_account_id: accountId, p_order_id: orderId, p_request_id: requestId, p_reason: reason })
  if (error) throw error
  return data
}
export async function closeAndCreateReplenishmentOrder(accountId: string, orderId: string, requestId: string, reason: string | null = null): Promise<import('../types/marketReplenishment').ReplenishmentNewCycleResult> {
  const { data, error } = await supabase.rpc('market_close_and_create_replenishment_order', { p_market_account_id: accountId, p_order_id: orderId, p_request_id: requestId, p_reason: reason })
  if (error) throw error
  return data
}
export async function getReplenishmentSupplyBatchPreview(accountId: string, orderId: string): Promise<import('../types/marketReplenishment').ReplenishmentSupplyBatchPreview> {
  const { data, error } = await supabase.rpc('market_get_replenishment_supply_batch_preview', { p_market_account_id: accountId, p_order_id: orderId })
  if (error) throw error
  return data
}
export async function executeReplenishmentSupplyBatch(accountId: string, orderId: string, items: ReplenishmentSupplyLine[], requestId: string): Promise<unknown> {
  const { data, error } = await supabase.rpc('market_execute_replenishment_supply_batch', { p_market_account_id: accountId, p_order_id: orderId, p_items: items, p_request_id: requestId })
  if (error) throw error
  return data
}
