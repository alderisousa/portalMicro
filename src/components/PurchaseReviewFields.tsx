import type { PurchaseReviewValues } from '../types/marketPurchases'
import { parseLooseNumber } from '../utils/purchaseOcrMath'
import { reviewValueChanged } from '../utils/purchaseReview'

const labels: Record<keyof PurchaseReviewValues, string> = {
  supplier_product_code: 'Código do fornecedor', barcode_raw: 'EAN/GTIN interpretado', description_raw: 'Descrição',
  quantity: 'Quantidade', unit: 'Unidade', unit_price: 'Valor unitário', gross_amount: 'Total da linha',
  net_amount: 'Valor líquido', discount_amount: 'Desconto da linha', freight_amount: 'Frete da linha', other_amount: 'Outras despesas da linha',
}
const textFields = new Set(['supplier_product_code','barcode_raw','description_raw','unit'])
const wideFields = new Set(['description_raw'])

export function PurchaseReviewFields({ values, original, onChange, disabled = false }: {
  values: PurchaseReviewValues; original: PurchaseReviewValues | null;
  onChange: (values: PurchaseReviewValues) => void; disabled?: boolean;
}) {
  return <div className="market-ocr-review-header-grid">
    {(Object.keys(labels) as Array<keyof PurchaseReviewValues>).map((key) => {
      const originalValue = original?.[key] ?? null
      const changed = reviewValueChanged(values[key], originalValue)
      return <label key={key} className={wideFields.has(key) ? 'market-ocr-review-field-wide' : undefined}>
        <span>{labels[key]}</span>
        <input key={`${key}-${disabled}`} disabled={disabled} defaultValue={values[key] === null ? '' : String(values[key]).replace(textFields.has(key) ? /$^/ : /\./, ',')}
          inputMode={textFields.has(key) ? 'text' : 'decimal'} onChange={(event) => {
            const raw = event.target.value
            onChange({ ...values, [key]: textFields.has(key) ? raw || null : parseLooseNumber(raw) })
          }} />
        {changed
          ? <small className="market-ocr-review-original is-changed">Original: {originalValue ?? 'não informado'}</small>
          : <small className="market-ocr-review-original">Sem alteração em relação ao original</small>}
        {(key === 'quantity' || key === 'unit_price') && <small className="market-ocr-review-precision-hint">{key === 'quantity' ? 'Até 4 casas decimais' : 'Até 5 casas decimais'}</small>}
      </label>
    })}
  </div>
}
