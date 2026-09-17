import { supabase } from '../lib/supabase'
import type { MarketDuplicateGroup, MarketProductReadRow } from '../types/marketProducts'

// Agrupamento exclusivamente visual: não cria vínculos entre produtos/EANs.
export function groupDuplicateProducts(rows: MarketProductReadRow[]): MarketDuplicateGroup[] {
  const groups = new Map<string, MarketDuplicateGroup>()
  for (const row of rows) {
    const description = row.description?.trim().replace(/\s+/g, ' ').toLocaleUpperCase('pt-BR')
    const ean = row.ean?.trim()
    if (!description || !ean) continue
    let group = groups.get(description)
    if (!group) {
      group = { description, products: [] }
      groups.set(description, group)
    }
    group.products.push({ id: row.id, description: row.description!, ean })
  }
  return [...groups.values()]
    .filter((group) => new Set(group.products.map((product) => product.ean)).size >= 2)
    .sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'))
    .map((group) => ({ ...group, products: group.products.sort((a, b) => a.ean.localeCompare(b.ean)) }))
}

export async function listDuplicateMarketProducts(accountId: string, signal?: AbortSignal): Promise<MarketDuplicateGroup[]> {
  if (!accountId.trim()) throw new Error('Conta Market não informada.')
  const rows: MarketProductReadRow[] = []
  let lastId: string | undefined
  // Cursor por ID evita depender do limite total da API e de offsets crescentes.
  // Só termina com página vazia, inclusive se o servidor limitar a página a menos de 500.
  while (true) {
    let query = supabase.from('market_products')
      .select('id,description,ean')
      .eq('market_account_id', accountId)
      .eq('status', 'active')
      .not('ean', 'is', null)
      .order('id', { ascending: true })
      .limit(500)
    if (lastId) query = query.gt('id', lastId)
    if (signal) query = query.abortSignal(signal)
    const { data, error } = await query
    if (error) throw error
    const page = (data ?? []) as MarketProductReadRow[]
    if (!page.length) break
    rows.push(...page)
    lastId = page[page.length - 1].id
  }
  return groupDuplicateProducts(rows)
}
