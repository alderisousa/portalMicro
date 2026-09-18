import { supabase } from '../lib/supabase'
import type { MarketMemberRole, MarketStore } from '../types/market'

export interface StoreProductParameters {
  minimum_stock: number | null
  is_essential: boolean
  minimum_margin_pct: number | null
}

export const canEditStoreProductParameters = (role: MarketMemberRole) => ['owner', 'admin', 'manager', 'operator'].includes(role)
export const operationalStores = (stores: MarketStore[]) => stores.filter(store => store.store_type === 'store' && store.status === 'active')
const columns = 'minimum_stock,is_essential,minimum_margin_pct'

export function parseStoreProductParameters(stock: string, essential: boolean, margin: string): StoreProductParameters {
  function optionalNumber(raw: string, label: string, max: number) {
    if (!raw.trim()) return null
    const value = Number(raw.replace(',', '.'))
    if (!Number.isInteger(value) || value < 0 || value > max) {
      throw new Error(`${label}: informe um número inteiro de 0 a ${max}, ou deixe vazio.`)
    }
    return value
  }
  return {
    minimum_stock: optionalNumber(stock, 'Estoque mínimo', 99999999999),
    is_essential: essential,
    minimum_margin_pct: optionalNumber(margin, 'Margem mínima desejada', 100),
  }
}

export interface StoreProductExportRow extends StoreProductParameters {
  id: string
  product: { name: string; ean: string | null; sku: string | null }
}

export async function listStoreProductParametersForExport(accountId: string, store: MarketStore): Promise<StoreProductExportRow[]> {
  if (store.store_type !== 'store' || store.status !== 'active' || store.market_account_id !== accountId) throw new Error('Selecione uma loja operacional.')
  const rows: StoreProductExportRow[] = []
  let cursor: string | undefined
  while (true) {
    let query = supabase.from('market_store_products')
      .select(`id,${columns},product:market_products!inner(name,ean,sku)`)
      .eq('market_account_id', accountId).eq('market_store_id', store.id)
      .or('minimum_stock.not.is.null,is_essential.eq.true,minimum_margin_pct.not.is.null')
      .order('id').limit(500)
    if (cursor) query = query.gt('id', cursor)
    const { data, error } = await query
    if (error) throw error
    const page = (data ?? []) as unknown as StoreProductExportRow[]
    if (!page.length) return rows
    rows.push(...page)
    cursor = page[page.length - 1].id
  }
}

export async function getStoreProductParameters(accountId: string, storeId: string, productId: string): Promise<StoreProductParameters> {
  const { data, error } = await supabase.from('market_store_products').select(columns)
    .eq('market_account_id', accountId).eq('market_store_id', storeId).eq('product_id', productId).maybeSingle()
  if (error) throw error
  return data ?? { minimum_stock: null, is_essential: false, minimum_margin_pct: null }
}

export async function saveStoreProductParameters(accountId: string, storeId: string, productId: string, values: StoreProductParameters): Promise<StoreProductParameters> {
  const validated = parseStoreProductParameters(values.minimum_stock === null ? '' : String(values.minimum_stock), values.is_essential,
    values.minimum_margin_pct === null ? '' : String(values.minimum_margin_pct))
  if (typeof validated.is_essential !== 'boolean') throw new Error('Informe se o produto é essencial.')
  // Mesmo upsert por loja/produto usado pelo estoque mínimo existente.
  // Somente os três parâmetros: preço, custo, status e demais colunas são preservados.
  const { data, error } = await supabase.from('market_store_products').upsert({
    market_account_id: accountId, market_store_id: storeId, product_id: productId,
    ...validated,
  }, { onConflict: 'market_store_id,product_id' }).select(columns).single()
  if (error) throw error
  return data
}
