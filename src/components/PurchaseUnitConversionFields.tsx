import type { MarketPurchaseItem } from '../types/marketPurchases'
import { purchaseStockQuantity, purchaseStockUnitCost } from '../utils/purchaseReview'
import { parseLooseNumber } from '../utils/purchaseOcrMath'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

// Nunca renderiza "?": ou a unidade de estoque é conhecida (produto
// conciliado, ver market_resolve_purchase_item_unit) ou mostramos uma
// mensagem explícita e desabilitamos a entrada de fator.
export function PurchaseUnitConversionFields({
  item, factorInput, onChangeFactor, saveForReuse, onChangeSaveForReuse, disabled = false,
}: {
  item: MarketPurchaseItem
  factorInput: string
  onChangeFactor: (value: string) => void
  saveForReuse: boolean
  onChangeSaveForReuse: (value: boolean) => void
  disabled?: boolean
}) {
  if (!item.marketProductId) {
    return <div className="market-conversion-fields">
      <p className="market-conversion-hint">Concilie o produto para definir a conversão para estoque.</p>
    </div>
  }
  if (!item.stockUnit) {
    return <div className="market-conversion-fields">
      <p className="market-conversion-hint market-conversion-hint-error">Unidade de estoque não identificada no produto conciliado.</p>
    </div>
  }
  const factor = parseLooseNumber(factorInput)
  const stockUnit = item.stockUnit
  const stockQuantity = factor === null || factor <= 0 ? null : purchaseStockQuantity(item.quantity, factor)
  const stockUnitCost = factor === null || factor <= 0 ? null : purchaseStockUnitCost(item.netAmount, item.quantity, factor)
  return <div className="market-conversion-fields">
    <dl className="market-conversion-stats">
      <div><dt>Documento</dt><dd>{item.quantity} {item.unit ?? ''}</dd></div>
      <div><dt>Unidade de estoque</dt><dd>{stockUnit}</dd></div>
    </dl>
    <label className="market-conversion-factor">
      <span>1 {item.unit ?? ''} = quantas {stockUnit}?</span>
      <input disabled={disabled} inputMode="decimal" value={factorInput}
        onChange={(event) => onChangeFactor(event.target.value)} />
    </label>
    <dl className="market-conversion-stats">
      <div><dt>Entrada prevista</dt><dd>{stockQuantity !== null ? `${stockQuantity} ${stockUnit}` : 'Aguardando conversão'}</dd></div>
      <div><dt>Custo unitário previsto</dt><dd>{stockUnitCost !== null ? `${currency.format(stockUnitCost)} / ${stockUnit}` : 'Aguardando conversão'}</dd></div>
    </dl>
    <label className="market-checkbox-inline">
      <input type="checkbox" disabled={disabled} checked={saveForReuse}
        onChange={(event) => onChangeSaveForReuse(event.target.checked)} />
      <span>Lembrar esta conversão para compras futuras deste fornecedor/código</span>
    </label>
  </div>
}
