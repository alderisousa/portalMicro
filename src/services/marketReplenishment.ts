import { supabase } from '../lib/supabase'
import { listMarketProductsByIds } from './marketReconciliation'
import { groupReplenishmentCandidatesByStore } from '../utils/marketReplenishment'
import type { MarketStore } from '../types/market'
import type {
  MarketReplenishmentCandidate, MarketReplenishmentOrderDetail, MarketReplenishmentOverview, MarketReplenishmentRunSummary,
  MarketReplenishmentTriggerReason,
} from '../types/marketReplenishment'

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

export async function approveMarketReplenishmentOrder(accountId: string, orderId: string): Promise<string> {
  const { data, error } = await supabase.rpc('market_approve_replenishment_order', {
    p_market_account_id: accountId,
    p_order_id: orderId,
  })
  if (error) throw error
  return data as string
}
