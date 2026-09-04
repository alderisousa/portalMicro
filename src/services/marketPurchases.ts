import { supabase } from '../lib/supabase'
import type {
  MarketPurchase, MarketPurchaseDetail, MarketPurchaseImportRequest, MarketPurchaseImportResult,
  MarketPurchaseItem, MarketPurchaseListItem, MarketPurchaseProgress, MarketPurchaseStatus,
} from '../types/marketPurchases'

// Espelha (do lado do cliente, só para UX) a mesma regra que market_reimport_purchase_staging
// revalida com lock dentro da transação: reimportação só é oferecida enquanto a compra
// segue 'imported' e nenhum item saiu de reconciliation_status/stock_entry_status 'pending'.
// Esta função NUNCA é a autoridade de segurança — é só para decidir se mostramos o
// diálogo de confirmação; o backend bloqueia de qualquer forma se a condição mudou.
export function isPurchaseReimportEligible(status: MarketPurchaseStatus, items: MarketPurchaseItem[]): boolean {
  return status === 'imported' && items.every((item) => item.reconciliationStatus === 'pending' && item.stockEntryStatus === 'pending')
}

const purchaseColumns = `
  id, market_account_id, destination_store_id, supplier_name, supplier_document,
  invoice_number, invoice_series, invoice_key, issued_at, received_at, total_amount,
  products_amount, freight_amount, discount_amount, other_amount, status, source_type,
  source_reference, created_by, created_at, updated_at
`

const purchaseItemColumns = `
  id, market_account_id, market_purchase_id, line_number, supplier_product_code,
  barcode_raw, barcode_normalized, description_raw, ncm, cfop, unit, quantity,
  unit_price, gross_amount, discount_amount, freight_amount, other_amount, net_amount,
  calculated_unit_cost, market_product_id, reconciliation_status,
  reconciliation_confidence, reconciliation_method, reconciliation_notes,
  stock_entry_status, created_at, updated_at
`

function camelizeRow<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])
  ) as T
}

export async function listMarketPurchases(accountId: string): Promise<MarketPurchase[]> {
  const { data, error } = await supabase
    .from('market_purchases')
    .select(purchaseColumns)
    .eq('market_account_id', accountId)
    .order('issued_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map((row) => camelizeRow<MarketPurchase>(row))
}

export async function listMarketPurchaseSummaries(accountId: string): Promise<MarketPurchaseListItem[]> {
  const purchases = await listMarketPurchases(accountId)
  if (!purchases.length) return []
  const { data, error } = await supabase.from('market_purchase_items')
    .select('market_purchase_id,reconciliation_status,stock_entry_status')
    .eq('market_account_id', accountId).in('market_purchase_id', purchases.map((purchase) => purchase.id))
  if (error) throw error
  const progress = new Map<string, MarketPurchaseProgress>()
  for (const row of data ?? []) {
    const current = progress.get(row.market_purchase_id) ?? { totalItems: 0, reconciledItems: 0, receivedItems: 0, pendingItems: 0 }
    current.totalItems += 1
    if (['matched_auto', 'matched_manual', 'mapped'].includes(row.reconciliation_status)) current.reconciledItems += 1
    if (row.stock_entry_status === 'received') current.receivedItems += 1
    progress.set(row.market_purchase_id, current)
  }
  return purchases.map((purchase) => {
    const counts = progress.get(purchase.id) ?? { totalItems: 0, reconciledItems: 0, receivedItems: 0, pendingItems: 0 }
    counts.pendingItems = counts.totalItems - counts.reconciledItems
    return { ...purchase, ...counts }
  })
}

export class MarketPurchaseImportError extends Error {
  constructor(message: string, readonly code = 'PURCHASE_IMPORT_FAILED') { super(message) }
}

export async function importMarketPurchase(input: MarketPurchaseImportRequest): Promise<MarketPurchaseImportResult> {
  const { data, error } = await supabase.functions.invoke('market-purchase-import', { body: input })
  if (error) {
    const context = (error as { context?: Response }).context
    const payload = context ? await context.clone().json().catch(() => null) as { error?: { code?: string; message?: string } } | null : null
    throw new MarketPurchaseImportError(payload?.error?.message ?? 'Não foi possível importar a NF-e.', payload?.error?.code)
  }
  return data as MarketPurchaseImportResult
}

// Leitura sob demanda dos itens de uma compra (usada ao expandir um card na listagem).
// Reaproveita as mesmas colunas e a mesma policy de RLS de getMarketPurchase — isolamento
// por market_account_id e por perfil (owner/admin/manager/viewer) já é garantido pela
// policy market_purchase_items_select da migration 001; nenhuma RPC nova foi necessária.
export async function listMarketPurchaseItems(accountId: string, purchaseId: string): Promise<MarketPurchaseItem[]> {
  const { data, error } = await supabase
    .from('market_purchase_items')
    .select(purchaseItemColumns)
    .eq('market_account_id', accountId)
    .eq('market_purchase_id', purchaseId)
    .order('line_number')

  if (error) throw error
  return (data ?? []).map((row) => camelizeRow<MarketPurchaseItem>(row))
}

export async function getMarketPurchase(accountId: string, purchaseId: string): Promise<MarketPurchaseDetail | null> {
  const { data: purchase, error: purchaseError } = await supabase
    .from('market_purchases')
    .select(purchaseColumns)
    .eq('market_account_id', accountId)
    .eq('id', purchaseId)
    .maybeSingle()

  if (purchaseError) throw purchaseError
  if (!purchase) return null

  const { data: items, error: itemsError } = await supabase
    .from('market_purchase_items')
    .select(purchaseItemColumns)
    .eq('market_account_id', accountId)
    .eq('market_purchase_id', purchaseId)
    .order('line_number')

  if (itemsError) throw itemsError
  return {
    ...camelizeRow<MarketPurchase>(purchase),
    items: (items ?? []).map((row) => camelizeRow<MarketPurchaseItem>(row)),
  }
}

export function getMarketPurchaseProgress(items: MarketPurchaseItem[]): MarketPurchaseProgress {
  const reconciledItems = items.filter((item) =>
    ['matched_auto', 'matched_manual', 'mapped'].includes(item.reconciliationStatus)
  ).length
  const receivedItems = items.filter((item) => item.stockEntryStatus === 'received').length
  return {
    totalItems: items.length,
    reconciledItems,
    receivedItems,
    pendingItems: items.length - reconciledItems,
  }
}
