import { useState } from 'react'
import type { PurchaseReviewValues } from '../types/marketPurchases'
import { parseLooseNumber } from '../utils/purchaseOcrMath'
import { reviewValueChanged, shouldSuggestNetAmountFromGross } from '../utils/purchaseReview'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

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
  // O input de net_amount é não controlado (defaultValue) para não atrapalhar
  // a digitação nos outros campos. "Usar total da linha" preenche values via
  // onChange (igual a qualquer outra edição — não salva, não confere, não
  // recebe) mas precisa forçar esse input específico a remontar para mostrar
  // o novo valor; os demais campos continuam remontando só quando `disabled` muda.
  const [netAmountFillToken, setNetAmountFillToken] = useState(0)
  return <div className="market-ocr-review-header-grid">
    {(Object.keys(labels) as Array<keyof PurchaseReviewValues>).map((key) => {
      const originalValue = original?.[key] ?? null
      const changed = reviewValueChanged(values[key], originalValue)
      const showUseGrossAsNet = key === 'net_amount' && shouldSuggestNetAmountFromGross(values)
      return <label key={key} className={wideFields.has(key) ? 'market-ocr-review-field-wide' : undefined}>
        <span>{labels[key]}</span>
        <input key={`${key}-${disabled}${key === 'net_amount' ? `-${netAmountFillToken}` : ''}`} disabled={disabled}
          defaultValue={values[key] === null ? '' : String(values[key]).replace(textFields.has(key) ? /$^/ : /\./, ',')}
          inputMode={textFields.has(key) ? 'text' : 'decimal'} onChange={(event) => {
            const raw = event.target.value
            onChange({ ...values, [key]: textFields.has(key) ? raw || null : parseLooseNumber(raw) })
          }} />
        {showUseGrossAsNet && <button type="button" className="market-ocr-review-field-suggestion" disabled={disabled}
          onClick={() => { onChange({ ...values, net_amount: values.gross_amount }); setNetAmountFillToken((token) => token + 1) }}>
          Usar total da linha ({currency.format(values.gross_amount as number)})
        </button>}
        {changed
          ? <small className="market-ocr-review-original is-changed">Original: {originalValue ?? 'não informado'}</small>
          : <small className="market-ocr-review-original">Sem alteração em relação ao original</small>}
        {(key === 'quantity' || key === 'unit_price') && <small className="market-ocr-review-precision-hint">{key === 'quantity' ? 'Até 4 casas decimais' : 'Até 5 casas decimais'}</small>}
      </label>
    })}
  </div>
}
