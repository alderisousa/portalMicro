import { supabase } from '../lib/supabase'
import type {
  CatalogSearchResult, ReconciliationCandidate, ReconciliationConfirmResult,
  ReconciliationUndoResult, ReprocessPurchasePendingResult,
} from '../types/marketReconciliation'

const errorMessages: Record<string, string> = {
  RECONCILE_PERMISSION_DENIED: 'Seu perfil não pode conciliar itens desta compra.',
  RECONCILE_ITEM_NOT_FOUND: 'Este item não foi encontrado.',
  RECONCILE_STOCK_ALREADY_ADVANCED: 'Este item já avançou para recebimento e não pode mais ser alterado.',
  RECONCILE_PURCHASE_NOT_ACCESSIBLE: 'Você não tem acesso a esta compra.',
  RECONCILE_PRODUCT_NOT_FOUND: 'Produto não encontrado no catálogo sincronizado.',
  RECONCILE_PRODUCT_INACTIVE: 'Este produto está inativo no catálogo sincronizado.',
  RECONCILE_PRODUCT_NOT_CURRENT: 'Este produto não é mais o vigente no catálogo Accesys desta conta.',
  RECONCILE_INVALID_EAN: 'Código de barras inválido.',
}

export class ReconciliationError extends Error {
  constructor(readonly code: string | undefined, message?: string) {
    super((code && errorMessages[code]) ?? message ?? 'Não foi possível concluir a conciliação.')
  }
}

function toReconciliationError(error: { message?: string }): ReconciliationError {
  const code = error.message && error.message in errorMessages ? error.message : undefined
  return new ReconciliationError(code, error.message)
}

export async function searchReconciliationCandidates(
  accountId: string, purchaseItemId: string, limit = 5,
): Promise<ReconciliationCandidate[]> {
  const { data, error } = await supabase.rpc('market_search_purchase_reconciliation_candidates', {
    p_market_account_id: accountId, p_purchase_item_id: purchaseItemId, p_limit: limit,
  })
  if (error) throw toReconciliationError(error)
  return (data ?? []) as ReconciliationCandidate[]
}

export async function searchCatalogProducts(
  accountId: string, query: string, limit = 20,
): Promise<CatalogSearchResult[]> {
  const { data, error } = await supabase.rpc('market_search_market_products', {
    p_market_account_id: accountId, p_query: query, p_limit: limit,
  })
  if (error) throw toReconciliationError(error)
  return (data ?? []) as CatalogSearchResult[]
}

// Usada pelo botao "Ler codigo de barras" no modal de conciliacao. O EAN lido
// e evidencia operacional transitoria - nunca e persistido no item fiscal.
export async function searchProductsByEan(accountId: string, ean: string): Promise<CatalogSearchResult[]> {
  const { data, error } = await supabase.rpc('market_search_purchase_reconciliation_by_ean', {
    p_market_account_id: accountId, p_ean: ean,
  })
  if (error) throw toReconciliationError(error)
  return (data ?? []) as CatalogSearchResult[]
}

export async function confirmPurchaseItemReconciliation(
  accountId: string, purchaseItemId: string, marketProductId: string, saveSupplierMapping: boolean,
): Promise<ReconciliationConfirmResult> {
  const { data, error } = await supabase.rpc('market_confirm_purchase_item_reconciliation', {
    p_market_account_id: accountId, p_purchase_item_id: purchaseItemId,
    p_market_product_id: marketProductId, p_save_supplier_mapping: saveSupplierMapping,
  })
  if (error) throw toReconciliationError(error)
  return data as ReconciliationConfirmResult
}

export async function undoPurchaseItemReconciliation(
  accountId: string, purchaseItemId: string,
): Promise<ReconciliationUndoResult> {
  const { data, error } = await supabase.rpc('market_undo_purchase_item_reconciliation', {
    p_market_account_id: accountId, p_purchase_item_id: purchaseItemId,
  })
  if (error) throw toReconciliationError(error)
  return data as ReconciliationUndoResult
}

export interface PossiblePackaging { quantity: number; unit: string }

// Deteccao meramente assistiva: nunca altera quantity/unit fiscais nem gera estoque.
// Reconhece o padrao real observado nas NFC-e SEFAZ-SP ao final da descricao, ex.:
// "... . DP0030UN" -> {quantity: 30, unit: "UN"}. Ignora o caso trivial de quantidade 1
// (ex. "UN0001UN"), que nao representa uma embalagem multipla e so geraria ruido.
export function detectPossiblePackaging(description: string | null): PossiblePackaging | null {
  if (!description) return null
  const match = /([A-Z]{2})(\d{4})([A-Z]{2})\s*$/i.exec(description.trim())
  if (!match) return null
  const quantity = Number.parseInt(match[2], 10)
  if (!Number.isFinite(quantity) || quantity <= 1) return null
  return { quantity, unit: match[3].toUpperCase() }
}

export async function reprocessPurchasePendingItems(
  accountId: string, purchaseId: string,
): Promise<ReprocessPurchasePendingResult> {
  const { data, error } = await supabase.rpc('market_reprocess_purchase_pending_items', {
    p_market_account_id: accountId, p_purchase_id: purchaseId,
  })
  if (error) throw toReconciliationError(error)
  return data as ReprocessPurchasePendingResult
}

export interface ReconciledProductSummary { id: string; name: string; sku: string | null; ean: string | null }

// So para exibir "produto correspondente" nas linhas ja conciliadas - RLS de
// market_products (market_is_member) ja garante o isolamento por conta.
export async function listMarketProductsByIds(accountId: string, ids: string[]): Promise<ReconciledProductSummary[]> {
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('market_products')
    .select('id,name,sku,ean')
    .eq('market_account_id', accountId)
    .in('id', ids)
  if (error) throw error
  return (data ?? []) as ReconciledProductSummary[]
}
