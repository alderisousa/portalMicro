import { supabase } from '../lib/supabase'
import type {
  MarketPurchase, MarketPurchaseDetail, MarketPurchaseImportRequest, MarketPurchaseImportResult,
  MarketPurchaseItem, MarketPurchaseListItem, MarketPurchaseProgress, MarketPurchaseStatus, PurchaseReviewValues,
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
  source_reference, created_by, created_at, updated_at, reviewed_at, reviewed_by
`

const purchaseItemColumns = `
  id, market_account_id, market_purchase_id, line_number, supplier_product_code,
  barcode_raw, barcode_normalized, description_raw, ncm, cfop, unit, quantity,
  unit_price, gross_amount, discount_amount, freight_amount, other_amount, net_amount,
  calculated_unit_cost, conversion_factor, stock_unit, stock_quantity, stock_unit_cost,
  market_product_id, reconciliation_status,
  reconciliation_confidence, reconciliation_method, reconciliation_notes,
  stock_entry_status, received_at, received_by, created_at, updated_at, original_data, reviewed_at, reviewed_by
`

function camelizeRow<T>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])
  ) as T
}

function reviewError(error: { message: string; code?: string }): Error {
  const messages: Record<string, string> = {
    PURCHASE_REVIEW_CONFLICT: 'O item mudou desde a abertura. Feche e atualize a compra antes de editar.',
    PURCHASE_REVIEW_MATCH_REQUIRED: 'Concilie o produto antes de confirmar a conferência. Ao corrigir código/EAN, salve e concilie novamente.',
    PURCHASE_REVIEW_MATH: 'Confira quantidade, valor unitário, total e despesas: os valores divergem.',
    PURCHASE_REVIEW_TOTALS: 'A soma dos itens diverge do total de produtos do documento.',
    PURCHASE_REVIEW_INCOMPLETE: 'Concilie e confira todos os itens antes de concluir a compra.',
    PURCHASE_REVIEW_LOCKED: 'Esta compra não está disponível para edição.',
    PURCHASE_ITEM_PRECISION: 'Use até 4 casas na quantidade, 5 no valor unitário e 2 nos totais e despesas.',
    RECONCILE_PERMISSION_DENIED: 'Seu perfil não permite conferir esta compra.',
    PURCHASE_DESTINATION_NOT_ALLOWED: 'Selecione um galpão ativo ao qual você tenha acesso.',
    PURCHASE_ITEM_CONVERSION_REQUIRED: 'Informe a conversão para a unidade de estoque antes de confirmar a conferência.',
    PURCHASE_ITEM_CONVERSION_INVALID: 'Informe um fator de conversão maior que zero, com até 6 casas decimais.',
    RECONCILE_PRODUCT_REQUIRED: 'Concilie o produto antes de informar a conversão de embalagem.',
    PURCHASE_DOCUMENT_INVALID: 'O documento interpretado está incompleto ou em formato inesperado.',
    PURCHASE_ITEMS_INVALID: 'A lista de itens é inválida ou excede o limite permitido.',
    PURCHASE_ITEM_INVALID: 'Um dos itens tem quantidade, descrição ou valor inválido. Revise antes de salvar.',
    PURCHASE_ACCESS_KEY_INVALID: 'A chave de acesso informada não tem 44 dígitos.',
    PURCHASE_ACCOUNT_NOT_AVAILABLE: 'Esta conta Market não está disponível para importar compras no momento.',
    PURCHASE_SOURCE_TYPE_INVALID: 'Origem do documento não reconhecida.',
    PURCHASE_RECEIVE_NO_READY_ITEMS: 'Nenhum item novo está pronto para entrada (conciliado, com conversão e custo unitário resolvidos, e conferido).',
    PURCHASE_DELETE_NOT_ALLOWED: 'Esta nota já possui item conciliado, conferido ou recebido e não pode mais ser excluída.',
  }
  return new Error(error.code === 'PGRST202' || error.code === '42703'
    ? 'A atualização de conferência precisa ser aplicada manualmente no banco antes de usar este recurso.'
    : messages[error.message] ?? error.message)
}

export async function savePurchaseItemReview(accountId: string, item: MarketPurchaseItem, values: PurchaseReviewValues, confirm: boolean) {
  const { error } = await supabase.rpc('market_save_purchase_item_review', {
    p_market_account_id: accountId, p_purchase_item_id: item.id, p_values: values,
    p_expected_updated_at: item.updatedAt, p_confirm: confirm,
  })
  if (error) throw reviewError(error)
}

export async function savePurchaseItemConversion(
  accountId: string, item: MarketPurchaseItem, conversionFactor: number, saveForReuse: boolean
) {
  const { error } = await supabase.rpc('market_save_purchase_item_conversion', {
    p_market_account_id: accountId, p_purchase_item_id: item.id, p_conversion_factor: conversionFactor,
    p_expected_updated_at: item.updatedAt, p_save_for_reuse: saveForReuse,
  })
  if (error) throw reviewError(error)
}

export async function completePurchaseReview(accountId: string, purchaseId: string) {
  const { error } = await supabase.rpc('market_complete_purchase_review', { p_market_account_id: accountId, p_purchase_id: purchaseId })
  if (error) throw reviewError(error)
}

export interface ReceivePurchaseItemsResult {
  purchaseId: string
  itemsReceivedNow: number
  itemsReceivedTotal: number
  itemsTotal: number
  purchaseStatus: MarketPurchaseStatus
}

// Único botão de entrada: processa automaticamente todos os itens ainda não
// recebidos que já estejam conciliados + com conversão resolvida + conferidos.
// Sem seleção manual de linha; RPC revalida tudo de novo (nunca confia neste
// service nem em contagens client-side para decidir o que efetivamente entra).
export async function receivePurchaseReadyItems(accountId: string, purchaseId: string): Promise<ReceivePurchaseItemsResult> {
  const { data, error } = await supabase.rpc('market_receive_purchase_items', { p_market_account_id: accountId, p_purchase_id: purchaseId })
  if (error) throw reviewError(error)
  return data as ReceivePurchaseItemsResult
}

// Só permitido quando a compra ainda está intocada (nenhum item conciliado,
// conferido ou recebido) — a RPC revalida o estado real dos itens; esta
// função nunca decide sozinha se a exclusão é segura.
export async function deleteImportedPurchase(accountId: string, purchaseId: string): Promise<void> {
  const { error } = await supabase.rpc('market_delete_purchase_staging', { p_market_account_id: accountId, p_purchase_id: purchaseId })
  if (error) throw reviewError(error)
}

export async function importPdfPurchase(accountId: string, destinationStoreId: string, reference: string, document: unknown, original: unknown): Promise<string> {
  const { data, error } = await supabase.rpc('market_import_pdf_purchase_staging', {
    p_market_account_id: accountId, p_destination_store_id: destinationStoreId,
    p_source_reference: reference, p_document: document, p_original: original,
  })
  if (error) throw reviewError(error)
  return data as string
}

// Mesmo RPC de staging do PDF (market_import_pdf_purchase_staging), só muda
// p_source_type: mesma conciliação/conversão/conferência depois, sem fluxo
// paralelo. p_source_type omitido continua default 'pdf' — importPdfPurchase
// acima não precisou mudar.
export async function importAiTextPurchase(accountId: string, destinationStoreId: string, reference: string, document: unknown, original: unknown): Promise<string> {
  const { data, error } = await supabase.rpc('market_import_pdf_purchase_staging', {
    p_market_account_id: accountId, p_destination_store_id: destinationStoreId,
    p_source_reference: reference, p_document: document, p_original: original, p_source_type: 'ai_text',
  })
  if (error) throw reviewError(error)
  return data as string
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

// Leitura de UM item direto do banco (usada ao abrir o diálogo de conferência):
// nunca confia num snapshot recebido por prop, que pode estar desatualizado
// (ex.: card ainda não reaberto após conciliação/reprocessamento/backfill).
export async function getMarketPurchaseItem(accountId: string, itemId: string): Promise<MarketPurchaseItem | null> {
  const { data, error } = await supabase
    .from('market_purchase_items')
    .select(purchaseItemColumns)
    .eq('market_account_id', accountId)
    .eq('id', itemId)
    .maybeSingle()
  if (error) throw error
  return data ? camelizeRow<MarketPurchaseItem>(data) : null
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
