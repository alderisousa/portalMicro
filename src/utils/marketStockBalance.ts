import type { MarketInitialInventoryItem, MarketInventoryReasonCode, MarketStockBalanceRow } from '../types/marketStock'

// Mesma normalização usada em MarketStockDashboard (findMarketStockProducts):
// NFD + remoção dos diacríticos combinantes (faixa Unicode 0x0300-0x036f).
// Construído via String.fromCharCode para evitar caracteres combinantes
// literais no código-fonte deste arquivo — mesmo range, mesmo resultado.
const diacritics = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g')
const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(diacritics, '')

// Busca local sobre o saldo já carregado (descrição ou EAN/GTIN) — sem
// depender do catálogo completo de produtos, que só é buscado quando a
// contagem de inventário começa. Query vazia devolve tudo: é a listagem
// padrão da tela de saldo, não um autocomplete que só aparece ao digitar.
export function findMarketStockBalance(balance: MarketStockBalanceRow[], query: string): MarketStockBalanceRow[] {
  const term = normalizeSearch(query)
  if (!term) return balance
  return balance.filter((row) => normalizeSearch(row.productName).includes(term) || (row.ean ? normalizeSearch(row.ean).includes(term) : false))
}

export interface StockCountComparison {
  // false quando o produto não tem nenhum registro em balanceByProduct (nunca
  // teve movimento de estoque neste local) — nunca inventamos "saldo 0" para
  // esse caso, ver compareStockCount.
  known: boolean
  currentQuantity: number
  countedQuantity: number
  difference: number
}

// Compara a contagem de um item com o saldo atual do MESMO local — sempre a
// partir de balanceByProduct (derivado 1:1 de market_get_stock_balance/
// market_stock_balance, já carregado para a tela de contagem). Usada tanto
// para itens já presentes no draft quanto para itens localizados durante a
// contagem (busca por nome, EAN/GTIN, código externo/SKU ou scanner): todos
// resolvem produto para o mesmo productId e passam pela mesma função aqui —
// nenhuma segunda fonte/lógica de saldo. `known: false` quando o produto não
// tem nenhuma linha de saldo (nunca movimentou neste local): currentQuantity
// e difference ficam 0 apenas por tipagem, mas não devem ser exibidos —
// quem chama deve mostrar um estado explícito (ex.: "Saldo não registrado").
export function compareStockCount(balanceByProduct: Map<string, number>, productId: string, countedQuantity: number): StockCountComparison {
  const known = balanceByProduct.has(productId)
  const currentQuantity = balanceByProduct.get(productId) ?? 0
  return { known, currentQuantity, countedQuantity, difference: countedQuantity - currentQuantity }
}

// Mesmo critério usado por market_finalize_inventory_draft (202609080003):
// motivo só é exigido quando o saldo é CONHECIDO (nunca por inventoryType)
// e a contagem já foi informada e diverge dele. Saldo desconhecido = está
// estabelecendo a primeira referência, não é perda/ganho a justificar.
export function requiresDivergenceReason(comparison: StockCountComparison, isCounted: boolean): boolean {
  return comparison.known && isCounted && comparison.difference !== 0
}

// Mesma regra de obrigatoriedade da RPC: reasonCode sempre necessário quando
// o item diverge; reasonNote só quando reasonCode for 'OTHER'.
export function isReasonMissing(item: Pick<MarketInitialInventoryItem, 'reasonCode' | 'reasonNote'>): boolean {
  if (!item.reasonCode) return true
  if (item.reasonCode === 'OTHER') return !item.reasonNote?.trim()
  return false
}

export type ReasonSign = 'IN' | 'OUT' | 'BOTH'

// Classificação única do sentido de cada motivo — mesma matriz usada pela
// validação da RPC (market_finalize_inventory_draft, 202609080004). Único
// lugar onde essa matriz existe no frontend; não duplicar em componentes.
export const reasonSignByCode: Record<MarketInventoryReasonCode, ReasonSign> = {
  EXPIRED_LOSS: 'OUT',
  DAMAGE: 'OUT',
  THEFT_LOSS: 'OUT',
  INTERNAL_USE: 'OUT',
  UNREGISTERED_PURCHASE: 'IN',
  PREVIOUS_COUNT_ERROR: 'BOTH',
  UNREGISTERED_TRANSFER: 'BOTH',
  OTHER: 'BOTH',
}

// Sentido da diferença: quem sobrou (IN, vira ADJUSTMENT_IN) vs quem faltou
// (OUT, vira ADJUSTMENT_OUT). Diferença zero não tem sentido — null.
export function differenceSign(difference: number): 'IN' | 'OUT' | null {
  if (difference > 0) return 'IN'
  if (difference < 0) return 'OUT'
  return null
}

// Diferença zero nunca é "inválida" aqui — quem decide se motivo é exigido
// é requiresDivergenceReason; esta função só avalia coerência de sentido.
export function isReasonCodeAllowedForDifference(reasonCode: MarketInventoryReasonCode, difference: number): boolean {
  const sign = differenceSign(difference)
  if (!sign) return true
  const allowed = reasonSignByCode[reasonCode]
  return allowed === 'BOTH' || allowed === sign
}

// Único ponto de decisão de quando um motivo já selecionado deixa de fazer
// sentido e precisa ser limpo: sem contagem, saldo desconhecido, diferença
// zerada, ou motivo incoerente com o sentido atual da diferença. Usado tanto
// ao editar a quantidade (updateQuantity) quanto ao sanear um rascunho
// retomado (resumeDraft) — mesma regra, um único lugar.
export function reasonNeedsReset(
  reasonCode: MarketInventoryReasonCode | null,
  comparison: StockCountComparison,
  isCounted: boolean,
): boolean {
  if (!reasonCode) return false
  if (!isCounted || !comparison.known || comparison.difference === 0) return true
  return !isReasonCodeAllowedForDifference(reasonCode, comparison.difference)
}
