import { getCurrentUserMarketAccess } from './market'
import { supabase } from '../lib/supabase'
import { MARKET_SALES_IMPORT_SOURCE_SYSTEM } from '../constants/marketSalesImport'
import type {
  MarketSalesImportAnalysis,
  MarketSalesImportBeginResult,
  MarketSalesImportConfirmationOutcome,
  MarketSalesImportConfirmationResult,
  MarketSalesImportContext,
} from '../types/marketSalesImport'

const MARKET_IMPORT_CONTEXT_PAGE_SIZE = 1000

async function getAllMarketProducts(accountId: string) {
  const products: Array<{ id: string; ean: string | null }> = []
  for (let from = 0; ; from += MARKET_IMPORT_CONTEXT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('market_products')
      .select('id, ean')
      .eq('market_account_id', accountId)
      .order('id')
      .range(from, from + MARKET_IMPORT_CONTEXT_PAGE_SIZE - 1)
    if (error) throw error
    products.push(...(data ?? []))
    if ((data?.length ?? 0) < MARKET_IMPORT_CONTEXT_PAGE_SIZE) return products
  }
}

async function getAllMarketProductMappings(accountId: string) {
  const mappings: Array<{ product_id: string; external_ean: string }> = []
  for (let from = 0; ; from += MARKET_IMPORT_CONTEXT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from('market_product_mappings')
      .select('product_id, external_ean')
      .eq('market_account_id', accountId)
      .eq('source_system', MARKET_SALES_IMPORT_SOURCE_SYSTEM)
      .not('external_ean', 'is', null)
      .order('id')
      .range(from, from + MARKET_IMPORT_CONTEXT_PAGE_SIZE - 1)
    if (error) throw error
    mappings.push(...(data ?? []).filter(
      (mapping): mapping is { product_id: string; external_ean: string } => Boolean(mapping.external_ean)
    ))
    if ((data?.length ?? 0) < MARKET_IMPORT_CONTEXT_PAGE_SIZE) return mappings
  }
}

export async function getMarketSalesImportContext(
  accountId: string
): Promise<MarketSalesImportContext> {
  const access = await getCurrentUserMarketAccess(accountId)
  if (!access || access.member_status !== 'active') {
    throw new Error('Seu vínculo com esta conta Market não está ativo.')
  }
  if (access.status !== 'pilot' && access.status !== 'active') {
    throw new Error(
      access.status === 'suspended'
        ? 'Esta conta Market está suspensa.'
        : 'Esta conta Market está cancelada.'
    )
  }
  const [products, productMappings] = await Promise.all([
    getAllMarketProducts(accountId),
    getAllMarketProductMappings(accountId),
  ])
  return {
    access,
    stores: access.stores.filter((store) => store.store_type === 'store'),
    canImport: ['owner', 'admin', 'manager', 'operator'].includes(access.role),
    products,
    productMappings,
  }
}

const persistenceErrorMessage = (error: unknown) => {
  const raw = typeof error === 'object' && error && 'message' in error ? String(error.message) : ''
  const known: Array<[string, string]> = [
    ['SALES_WAREHOUSE_NOT_ALLOWED', 'Galpões não podem receber vendas. Selecione somente lojas comerciais.'],
    ['STORE_NOT_FOUND', 'Uma ou mais lojas da planilha não existem nesta conta.'],
    ['STORE_NOT_ALLOWED', 'Você não possui acesso a uma ou mais lojas da planilha.'],
    ['STORE_INACTIVE', 'Uma ou mais lojas da planilha estão inativas.'],
    ['IMPORT_PERMISSION_DENIED', 'Você não possui permissão para confirmar esta importação.'],
    ['INVALID_FILE_HASH', 'Não foi possível validar a identificação do arquivo.'],
    ['INCOMPLETE_IMPORT', 'Nem todas as linhas chegaram ao servidor. Tente continuar a importação.'],
    ['STORE_ACCESS_CHANGED', 'O acesso a uma das lojas mudou durante a importação.'],
    ['RAW_DATA_REQUIRED', 'Uma linha não contém os dados originais obrigatórios.'],
    ['TOTALIZATION_ROW_REJECTED', 'A planilha contém uma linha de totalização entre as linhas comerciais.'],
    ['CHUNK_CONFLICT', 'Uma linha já enviada possui conteúdo diferente. Selecione novamente o arquivo original.'],
  ]
  return known.find(([code]) => raw.includes(code))?.[1] ?? 'Não foi possível confirmar a importação. Tente novamente.'
}

const rpc = async <T>(name: string, parameters: Record<string, unknown>): Promise<T> => {
  const { data, error } = await supabase.rpc(name, parameters)
  if (error) throw new Error(persistenceErrorMessage(error))
  return data as T
}

export async function confirmMarketSalesImport(
  accountId: string,
  analysis: MarketSalesImportAnalysis,
  acceptOverlap: boolean,
  onProgress: (persistedRows: number, totalRows: number) => void
): Promise<MarketSalesImportConfirmationOutcome> {
  const begin = await rpc<MarketSalesImportBeginResult>('market_begin_sales_import', {
    p_market_account_id: accountId,
    p_file_name: analysis.fileName,
    p_file_hash: analysis.fileHash,
    p_period_start: analysis.periodStart,
    p_period_end: analysis.periodEnd,
    p_source_system: MARKET_SALES_IMPORT_SOURCE_SYSTEM,
    p_total_rows: analysis.rows.length,
    p_store_codes: [...new Set(analysis.rows.map((row) => row.externalStoreCode))],
    p_accept_overlap: acceptOverlap,
  })
  if (begin.duplicate) return { type: 'duplicate', existing: begin }
  if (begin.overlapWarning && !begin.importId) return { type: 'overlap' }
  if (!begin.importId) throw new Error('Não foi possível iniciar a importação.')

  onProgress(begin.persistedRows ?? 0, analysis.rows.length)
  const chunkSize = 500
  for (let index = 0; index < analysis.rows.length; index += chunkSize) {
    const rows = analysis.rows.slice(index, index + chunkSize).map((row) => ({
      sourceRowNumber: row.sourceRowNumber,
      externalStoreCode: row.externalStoreCode,
      externalStoreName: row.externalStoreName,
      externalProductCode: null,
      externalEanRaw: row.externalEanRaw,
      barcodeNormalized: row.barcodeNormalized,
      description: row.description,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      totalAmount: row.totalAmount,
      totalCost: row.totalCost,
      profit: row.profit,
      markup: row.markup,
      markdown: row.markdown,
      rawData: row.rawData,
    }))
    const chunk = await rpc<{ persistedRows: number; totalRows: number }>(
      'market_append_sales_import_chunk',
      { p_market_account_id: accountId, p_import_id: begin.importId, p_rows: rows }
    )
    onProgress(chunk.persistedRows, chunk.totalRows)
  }

  const result = await rpc<MarketSalesImportConfirmationResult>(
    'market_finalize_sales_import',
    { p_market_account_id: accountId, p_import_id: begin.importId }
  )
  return { type: 'completed', result }
}
