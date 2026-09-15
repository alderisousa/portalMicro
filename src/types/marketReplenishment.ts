// Leitura read-only dos resultados já persistidos pelo batch de Reposição
// Inteligente (market_run_replenishment_batch, migrations 202609100001-015).
// Esta tela NUNCA recalcula regra, score ou prioridade — só apresenta o que
// já está gravado em market_replenishment_runs/market_replenishment_candidates.

export type MarketReplenishmentPriorityLevel = 'critical' | 'high' | 'medium' | 'low'

// Mesmos 5 códigos aceitos pelo check constraint de trigger_reasons em
// market_replenishment_candidates (202609100014: BELOW_MINIMUM substituiu
// ESSENTIAL_BELOW_MINIMUM).
export type MarketReplenishmentTriggerReason =
  | 'STOCKOUT'
  | 'BELOW_MINIMUM'
  | 'LOW_COVERAGE'
  | 'SALES_ACCELERATION'
  | 'ESSENTIAL_NO_RECENT_SALES'

// Cabeçalho do último run efetivo (market_replenishment_runs). Campos
// suficientes para o resumo compacto da tela — não inclui tudo que a tabela
// tem (ex.: algorithm_version, error_code) porque esta tela não precisa disso.
export interface MarketReplenishmentRunSummary {
  id: string
  referenceDate: string
  finishedAt: string | null
  storesProcessed: number
  productsSelected: number
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
}

// Um candidato persistido (market_replenishment_candidates) já com o nome do
// produto resolvido (join local via market_products, ver serviço). Todo
// campo nullable aqui É nullable na tabela de origem e permanece null —
// nunca convertido em zero só para caber no tipo.
export interface MarketReplenishmentCandidate {
  id: string
  storeId: string
  productId: string
  productName: string
  currentStock: number | null
  minimumStock: number | null
  coverageDays: number | null
  avgDailyM7: number | null
  suggestedQuantity: number | null
  warehouseStock: number | null
  triggerReasons: MarketReplenishmentTriggerReason[]
  priorityScore: number
  priorityLevel: MarketReplenishmentPriorityLevel
  rankPosition: number
}

// Candidatos de uma loja operacional, já ordenados por rankPosition (a mesma
// ordem persistida pelo batch — nenhum reordenamento de prioridade aqui).
// critical/high/medium/low são só a contagem dos candidatos abaixo, usada
// tanto para o resumo do card quanto para ordenar as lojas entre si.
export interface MarketReplenishmentStoreGroup {
  storeId: string
  storeName: string
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  candidates: MarketReplenishmentCandidate[]
}

// run null = nenhum run completed+is_effective encontrado para o Market
// ainda (ex.: batch nunca rodou). stores já vem filtrado a lojas
// store_type='store' e ordenado por necessidade de atenção.
export interface MarketReplenishmentOverview {
  run: MarketReplenishmentRunSummary | null
  stores: MarketReplenishmentStoreGroup[]
}

export type MarketReplenishmentOrderStatus =
  | 'draft'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'cancelled'

export type MarketReplenishmentOrderItemStatus = 'pending' | 'partial' | 'fulfilled' | 'cancelled'
export type MarketReplenishmentOrderItemSource = 'batch' | 'manual_review' | 'manual_purchase'
export type MarketReplenishmentAllocationStatus = 'pending' | 'allocated' | 'dispatched' | 'received' | 'cancelled'

export interface MarketReplenishmentOrderSummary {
  id: string
  marketAccountId: string
  runId: string
  status: MarketReplenishmentOrderStatus
  createdAt: string
  updatedAt: string
  approvedAt: string | null
  completedAt: string | null
  cancelledAt: string | null
}

export interface MarketReplenishmentOrderPrioritySummary {
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  prioritySort: number
  bestRankPosition: number | null
}

export interface MarketReplenishmentOrderLastSupplier {
  supplierName: string | null
  supplierDocument: string | null
  invoiceNumber: string | null
  invoiceSeries: string | null
  issuedAt: string | null
  receivedAt: string | null
  operationalAt: string | null
  unitCost: number | null
  purchaseId: string
  purchaseItemId: string
}

export interface MarketReplenishmentOrderAllocation {
  id: string
  storeId: string
  storeName: string
  candidateId: string | null
  status: MarketReplenishmentAllocationStatus
  suggestedQuantity: number | null
  adjustedQuantity: number | null
  warehouseAllocatedQuantity: number | null
  purchaseNeededQuantity: number | null
  priorityLevel: MarketReplenishmentPriorityLevel | null
  rankPosition: number | null
  // Preenchido quando a loja desta allocation ja foi liberada
  // (market_replenishment_order_store_releases, na approval_revision
  // atual). Allocation liberada fica congelada: nao pode mais ser revisada.
  releasedAt: string | null
}

export interface MarketReplenishmentOrderItem {
  id: string
  productId: string
  productName: string
  sku: string | null
  ean: string | null
  unit: string
  status: MarketReplenishmentOrderItemStatus
  source: MarketReplenishmentOrderItemSource
  totalSuggestedQuantity: number | null
  warehouseStockSnapshot: number | null
  suggestedPurchaseQuantity: number | null
  adjustedPurchaseQuantity: number | null
  effectivePurchaseQuantity: number | null
  purchasedQuantity: number
  warehouseSurplusQuantity: number
  reviewCancelledAt: string | null
  reviewCancelledBy: string | null
  reviewCancellationReason: string | null
  priority: MarketReplenishmentOrderPrioritySummary
  lastSupplier: MarketReplenishmentOrderLastSupplier | null
  allocations: MarketReplenishmentOrderAllocation[]
}

export interface MarketReplenishmentOrderDetail {
  isStale?: boolean
  order: MarketReplenishmentOrderSummary
  items: MarketReplenishmentOrderItem[]
}

export interface ReplenishmentPurchaseLine {
  orderId: string
  orderStatus: MarketReplenishmentOrderStatus
  remainingToBuy: number
  awaitingQuantity: number
  committedQuantity: number
  canCorrect: boolean
  id: string
  productId: string
  productName: string
  targetQuantity: number
  purchasedQuantity: number | null
  version: number
  stores: Array<{ allocationId: string; storeId: string; storeName: string; targetQuantity: number; purchasedQuantity: number; receivedQuantity: number; awaitingQuantity: number; deliveredQuantity: number; remainingPhysical: number }>
  linked: boolean
  coveredQuantity: number
  receivedQuantity: number
  invoices: Array<{ itemId: string; invoiceNumber: string | null; warehouseName: string; availableQuantity: number; received: boolean }>
}

export interface ReplenishmentSupplyLine {
  orderId: string
  id: string
  operationLineId: string | null
  allocationId: string
  productId: string
  productName: string
  storeId: string
  storeName: string
  sourceStoreId: string
  sourceStoreName: string
  targetQuantity: number
  confirmedQuantity: number
  remainingQuantity: number
  warehouseBalance: number
  executedQuantity: number
  suggestedQuantity: number
}

export interface ReplenishmentDelivery {
  id: string
  productName: string
  storeName: string
  sourceStoreName: string
  quantity: number
}

export type ReplenishmentOrderHistorySituation = 'partial' | 'completed'

// Resumo de uma ordem para a tela de Historico (market_get_replenishment_order_history,
// sem p_order_id). totalItems/processedItems/pendingItems contam necessidades
// (produto x loja) com necessidade real (target>0), nunca produtos soltos —
// ver market_replenishment_physical_needs_internal. situation deriva da
// entrega fisica real, não do status comercial da ordem (uma ordem pode virar
// 'completed' comercialmente com entrega Galpão->Loja ainda pendente).
export interface ReplenishmentOrderHistorySummary {
  id: string
  status: MarketReplenishmentOrderStatus
  createdAt: string
  approvedAt: string | null
  completedAt: string | null
  totalItems: number
  processedItems: number
  pendingItems: number
  situation: ReplenishmentOrderHistorySituation
}

// Detalhe de uma ordem para a tela de Historico (market_get_replenishment_order_history,
// com p_order_id): uma linha por necessidade (produto x loja). status
// 'processed' exige entrega Galpão->Loja efetiva (deliveredQuantity>=targetQuantity),
// nunca apenas "comprado".
export interface ReplenishmentOrderHistoryItem {
  allocationId: string
  productId: string
  productName: string
  storeId: string
  storeName: string
  targetQuantity: number
  deliveredQuantity: number
  remainingQuantity: number
  status: 'pending' | 'processed'
}
