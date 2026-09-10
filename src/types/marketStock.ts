import type { CurrentUserMarketAccess } from './market'

export interface MarketStockProduct {
  id: string
  name: string
  ean: string | null
  sku: string | null
  unit: string
  externalEans: string[]
  externalProductCodes: string[]
}

export type MarketInventoryReasonCode =
  | 'EXPIRED_LOSS'
  | 'DAMAGE'
  | 'THEFT_LOSS'
  | 'PREVIOUS_COUNT_ERROR'
  | 'UNREGISTERED_PURCHASE'
  | 'UNREGISTERED_TRANSFER'
  | 'INTERNAL_USE'
  | 'OTHER'

export interface MarketInitialInventoryItem {
  productId: string
  quantity: number
  // false = selecionado na contagem mas ainda sem quantidade física
  // informada pelo operador. Não confundir com quantity=0 (contagem
  // explícita de zero, isCounted=true) — quantity continua sempre um
  // número, nunca null; isCounted é quem carrega esse significado.
  isCounted: boolean
  // Motivo da divergência (obrigatório na finalização quando o saldo é
  // conhecido e diverge da contagem). reasonNote só é obrigatório para 'OTHER'.
  reasonCode: MarketInventoryReasonCode | null
  reasonNote: string | null
  // Concorrência POR ITEM (202609080005) — independente de
  // MarketInventoryDraft.version, que segue sendo só da sessão (started_at,
  // finalize/cancel). null = ainda não persistido no servidor (item novo,
  // só local). Não confundir com "não contado": um item pode já ter version
  // e ainda assim, mais tarde, voltar a isCounted=false.
  version: number | null
}

// Retorno de market_save_inventory_item/market_remove_inventory_item: nunca
// lança para conflito de version (é resultado normal do fluxo concorrente,
// não um erro) — devolve o estado atual do servidor para a UI decidir.
export interface MarketInventoryItemSaveSuccess {
  conflict: false
  // Contado como zero (isCounted=true, quantity=0) sempre é persistido,
  // em 'initial' ou 'cycle' — nunca null aqui (202609080005).
  item: MarketInitialInventoryItem
}
export interface MarketInventoryItemSaveConflict {
  conflict: true
  serverItem: MarketInitialInventoryItem | null // null = item foi removido por outro usuário desde a última leitura
}
export type MarketInventoryItemSaveResult = MarketInventoryItemSaveSuccess | MarketInventoryItemSaveConflict

export interface MarketInventoryItemRemoveSuccess { conflict: false; removed: true }
export type MarketInventoryItemRemoveResult = MarketInventoryItemRemoveSuccess | MarketInventoryItemSaveConflict

// Configuração opcional por produto/loja em market_store_products — não é
// item de sessão de inventário (não versiona, não gera movimento de estoque).
// minimumStock null = não configurado; 0 = mínimo explicitamente zero. Usado
// pelo campo "Estoque mínimo (opcional)" da tela de Estoque e pela regra
// BELOW_MINIMUM da Reposição Inteligente.
export interface MarketStoreProductSettings {
  productId: string
  minimumStock: number | null
}

export interface MarketStockBalanceRow {
  marketAccountId: string
  marketStoreId: string
  storeName: string
  stockControlStartedAt: string | null
  productId: string
  productName: string
  ean: string | null
  sku: string | null
  unit: string
  quantityOnHand: number
  lastMovementAt: string
}

export interface MarketStockContext {
  access: CurrentUserMarketAccess
  canStart: boolean
}

export interface MarketStockStartResult {
  marketAccountId: string
  marketStoreId: string
  stockControlStartedAt: string
  inventoryItems: number
}

export interface MarketCycleInventoryResult {
  marketAccountId: string
  marketStoreId: string
  inventoryType: 'cycle'
  inventorySessionId: string
  inventorySessionStatus: 'completed'
  inventorySessionVersion: number
  countedProducts: number
  adjustmentInProducts: number
  adjustmentOutProducts: number
  unchangedProducts: number
  adjustmentInQuantity: number
  adjustmentOutQuantity: number
}

export type MarketInventoryFinalizeResult = MarketStockStartResult | MarketCycleInventoryResult
export type MarketInventoryType = 'initial' | 'cycle'
export type MarketInventoryDraftStatus = 'draft' | 'completed' | 'cancelled'

export interface MarketInventoryDraft {
  id: string
  marketAccountId: string
  marketStoreId: string
  inventoryType: MarketInventoryType
  status: MarketInventoryDraftStatus
  startedAt: string
  version: number
  createdAt: string
  updatedAt: string
  items: MarketInitialInventoryItem[]
}

// Retorno de market_list_inventory_sessions (202609090001) — "Últimos
// inventários" da tela inicial de Estoque. Só sessões concluídas/canceladas
// (status nunca é 'draft' aqui — o rascunho ativo já tem seu próprio card,
// ver MarketInventoryDraft). Sem itens: a lista é só o resumo de cada
// conferência, o detalhe completo vem de MarketInventorySessionDetail.
export interface MarketInventorySessionSummary {
  id: string
  inventoryType: MarketInventoryType
  status: 'completed' | 'cancelled'
  startedAt: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
  countedProducts: number
}

// Item de MarketInventorySessionDetail — produto denormalizado (nome/EAN/SKU/
// unidade), porque o histórico precisa continuar legível mesmo que o produto
// tenha sido desativado depois desta conferência (ver comentário da RPC).
export interface MarketInventorySessionItem {
  productId: string
  productName: string
  ean: string | null
  sku: string | null
  unit: string
  quantity: number
  isCounted: boolean
  reasonCode: MarketInventoryReasonCode | null
  reasonNote: string | null
}

// Retorno de market_get_inventory_session (202609090001): a conferência
// específica com seus itens — representa aquele inventário, não o saldo
// atual da loja.
export interface MarketInventorySessionDetail {
  id: string
  marketAccountId: string
  marketStoreId: string
  inventoryType: MarketInventoryType
  status: MarketInventoryDraftStatus
  startedAt: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  cancelledAt: string | null
  items: MarketInventorySessionItem[]
}
