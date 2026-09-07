import type { MarketPurchaseItem, PurchaseReviewValues } from '../types/marketPurchases'
import type { PurchaseOcrDocument } from '../types/purchaseOcr'
import { analyzeBarcode } from './marketSalesImportParser'

export function itemReviewValues(item: MarketPurchaseItem): PurchaseReviewValues {
  return {
    supplier_product_code: item.supplierProductCode, barcode_raw: item.barcodeRaw,
    description_raw: item.descriptionRaw, quantity: item.quantity, unit: item.unit,
    unit_price: item.unitPrice, gross_amount: item.grossAmount, net_amount: item.netAmount,
    discount_amount: item.discountAmount, freight_amount: item.freightAmount, other_amount: item.otherAmount,
  }
}

export const canReviewPurchaseItem = (item: MarketPurchaseItem) => item.stockEntryStatus === 'pending'

const RECONCILED_STATUSES = new Set(['matched_auto', 'matched_manual', 'mapped'])
export const isPurchaseItemReconciled = (item: Pick<MarketPurchaseItem, 'reconciliationStatus'>) =>
  RECONCILED_STATUSES.has(item.reconciliationStatus)

// Espelha o critério de prontidão para recebimento já validado no banco
// (market_receive_purchase_items): conciliado + conversão resolvida + custo
// unitário de estoque resolvido + conferido + ainda não recebido. Não geramos
// entrada de estoque sem custo de aquisição — stock_unit_cost pode ficar null
// mesmo com a conversão resolvida quando o documento não trouxe net_amount
// (comum no Texto IA, que não promove gross_amount a net_amount sozinho). Só
// UX (rótulo do botão, números da confirmação) — a RPC sempre revalida tudo
// de novo, inclusive se o produto continua ativo/vigente no Accesys.
export function isPurchaseItemReadyToReceive(item: MarketPurchaseItem): boolean {
  return item.stockEntryStatus === 'pending'
    && item.marketProductId !== null
    && isPurchaseItemReconciled(item)
    && item.conversionFactor !== null
    && item.stockUnit !== null
    && item.stockUnitCost !== null
    && isHumanReviewed(item)
}

// "Intocado": nenhuma conciliação, conferência ou recebimento aconteceu ainda
// — mesma condição que market_delete_purchase_staging exige antes de excluir
// a nota. Só UX; a RPC revalida o estado real de cada item.
export function isPurchaseItemUntouched(item: MarketPurchaseItem): boolean {
  return item.reconciliationStatus === 'pending' && !isHumanReviewed(item) && item.stockEntryStatus === 'pending'
}

// "Usar total da linha como valor líquido" (PurchaseReviewFields): sugestão
// discreta e explícita, nunca fallback automático — só aparece quando
// net_amount ainda não foi informado e há um total bruto para sugerir. Nunca
// sobrescreve um net_amount já existente. Preencher não confere nem salva
// sozinho: o operador ainda revisa, salva e reconfirma a conferência.
export function shouldSuggestNetAmountFromGross(values: Pick<PurchaseReviewValues, 'net_amount' | 'gross_amount'>): boolean {
  return values.net_amount === null && values.gross_amount !== null
}

// Conversão de embalagem->estoque: dado adicional sobre o item, nunca sobre o
// documento. Só é exigível depois que o produto foi conciliado (antes disso
// não há unidade de estoque para comparar). Saber o fator não é conferir o
// item — reviewedAt/reviewedBy continuam controlando isso separadamente.
export function purchaseConversionRequired(item: Pick<MarketPurchaseItem, 'marketProductId' | 'conversionFactor' | 'stockUnit'>): boolean {
  return Boolean(item.marketProductId) && (item.conversionFactor === null || item.stockUnit === null)
}
export function purchaseStockQuantity(quantity: number, conversionFactor: number | null): number | null {
  return conversionFactor === null ? null : Math.round(quantity * conversionFactor * 1e4) / 1e4
}
export function purchaseStockUnitCost(netAmount: number | null, quantity: number, conversionFactor: number | null): number | null {
  if (netAmount === null || conversionFactor === null || quantity * conversionFactor === 0) return null
  return Math.round((netAmount / (quantity * conversionFactor)) * 1e6) / 1e6
}
export const isHumanReviewed = (item: MarketPurchaseItem) => Boolean(item.reviewedAt && item.reviewedBy)

// Usado para decidir se "Original: X" precisa aparecer com destaque (ver
// PurchaseReviewFields/PurchasePdfReview): ruído visual quando igual, sinal
// claro quando diferente.
export function reviewValueChanged(current: unknown, original: unknown): boolean {
  if (current === original) return false
  if (current === null || original === null) return true
  if (typeof current === 'number' && typeof original === 'number') return Math.abs(current - original) > 1e-9
  return String(current).trim() !== String(original).trim()
}
export function reviewProblems(values: PurchaseReviewValues): string[] {
  const problems: string[] = []
  if (!values.description_raw?.trim()) problems.push('Informe a descrição.')
  if (!values.unit?.trim()) problems.push('Informe a unidade.')
  if (values.quantity === null || !Number.isFinite(values.quantity) || values.quantity <= 0) problems.push('Informe uma quantidade maior que zero.')
  for (const key of ['unit_price', 'gross_amount', 'net_amount', 'discount_amount', 'freight_amount', 'other_amount'] as const) {
    const value = values[key]
    if (value !== null && (!Number.isFinite(value) || value < 0)) problems.push('Os valores devem ser números não negativos.')
  }
  if (values.unit_price === null || values.gross_amount === null) problems.push('Informe valor unitário e total da linha.')
  if (values.quantity !== null && Math.abs(values.quantity - Math.round(values.quantity * 1e4) / 1e4) > 1e-9) problems.push('Quantidade aceita até quatro casas decimais.')
  if (values.unit_price !== null && Math.abs(values.unit_price - Math.round(values.unit_price * 1e5) / 1e5) > 1e-9) problems.push('Valor unitário aceita até cinco casas decimais.')
  if (values.quantity !== null && values.unit_price !== null && values.gross_amount !== null
    && Math.abs(Math.round(values.quantity * values.unit_price * 100) - Math.round(values.gross_amount * 100)) > 2) problems.push('Quantidade × valor unitário diverge do total da linha.')
  if (values.net_amount !== null && values.gross_amount !== null
    && Math.abs(Math.round((values.gross_amount - values.discount_amount + values.freight_amount + values.other_amount) * 100) - Math.round(values.net_amount * 100)) > 2) problems.push('Valor líquido diverge do total com descontos e despesas.')
  return problems
}

export function pdfStagingDocument(document: PurchaseOcrDocument) {
  const header = Object.fromEntries(Object.entries(document.header).map(([key, field]) => [key, field.value]))
  const items: PurchaseReviewValues[] = document.items.map((item) => {
    const code = item.supplierCode.value ?? item.barcode.value
    const candidate = item.barcode.value ?? code ?? ''
    const barcode = analyzeBarcode(candidate)
    return { supplier_product_code: code, barcode_raw: item.barcode.value ?? (barcode.status === 'valid' ? barcode.normalized : null),
      description_raw: item.description.value, quantity: item.quantity.value, unit: item.unit.value,
      unit_price: item.unitPrice.value, gross_amount: item.lineTotal.value, net_amount: item.lineTotal.value,
      discount_amount: 0, freight_amount: 0, other_amount: 0 }
  })
  return { header, items }
}
