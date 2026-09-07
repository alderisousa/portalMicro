import { useState } from 'react'
import type { PurchaseReviewValues } from '../types/marketPurchases'
import { reviewProblems, reviewValueChanged } from '../utils/purchaseReview'
import { importAiTextPurchase, importPdfPurchase } from '../services/marketPurchases'
import { PurchaseReviewFields } from './PurchaseReviewFields'
import { parseLooseNumber } from '../utils/purchaseOcrMath'

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const itemSummary = (item: PurchaseReviewValues) => {
  const code = item.supplier_product_code || item.barcode_raw
  const quantityUnit = [item.quantity, item.unit].filter(Boolean).join(' ')
  const priceTotal = [item.unit_price !== null ? currency.format(item.unit_price) : null, item.gross_amount !== null ? currency.format(item.gross_amount) : null]
    .filter(Boolean).join(' · ')
  return [code, [quantityUnit, priceTotal].filter(Boolean).join(' · ')].filter(Boolean).join(' — ')
}
const headerLabels: Record<string, string> = { supplierName:'Fornecedor',supplierCnpj:'CNPJ',documentNumber:'Número',series:'Série',issueDate:'Data (DD/MM/AAAA)',accessKey:'Chave fiscal',productsTotal:'Total produtos',discount:'Desconto',freight:'Frete',otherExpenses:'Outras despesas',invoiceTotal:'Total documento' }
const numericHeaderKeys = ['productsTotal','discount','freight','otherExpenses','invoiceTotal']

export interface PurchaseStagingDocument { header: Record<string, unknown>; items: PurchaseReviewValues[] }

// Etapa de revisão humana compartilhada por TODAS as origens que alimentam o
// mesmo staging (hoje: PDF e Texto IA). Cada origem só precisa converter seu
// formato para {header,items} (ver pdfStagingDocument/aiTextStagingDocument)
// antes de chegar aqui — evita duas telas de revisão divergindo com o tempo.
export function PurchaseStagingReview({
  original, accountId, destinationStoreId, reference, sourceType, pageCount = 1, warnings, onImported,
}: {
  original: PurchaseStagingDocument
  accountId: string
  destinationStoreId: string
  reference: string
  sourceType: 'pdf' | 'ai_text'
  pageCount?: number
  warnings?: string[]
  onImported: (id: string) => void
}) {
  const [draft, setDraft] = useState(() => structuredClone(original))
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    if (busy || saved || pageCount !== 1) return
    setBusy(true); setError(null)
    try {
      const importer = sourceType === 'ai_text' ? importAiTextPurchase : importPdfPurchase
      const id = await importer(accountId, destinationStoreId, reference, draft, original)
      setSaved(true); onImported(id)
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar o documento.') }
    finally { setBusy(false) }
  }
  return <section className="market-ocr-review">
    <h3>{sourceType === 'ai_text' ? 'Revisar dados extraídos pela IA' : 'Interpretar documento PDF'}</h3>
    <p>Salve no staging para conciliar e conferir cada item. Leitura válida ou match automático não significam conferência humana.</p>
    {!!warnings?.length && <div className="admin-message" role="status">
      <p>A IA informou {warnings.length} {warnings.length === 1 ? 'ponto que precisa' : 'pontos que precisam'} de atenção. Revise os dados abaixo; isso não impede a importação.</p>
      <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </div>}
    <div className="market-ocr-review-header-grid">{Object.entries(headerLabels).map(([key,label]) => {
      const changed = reviewValueChanged(draft.header[key] ?? null, original.header[key] ?? null)
      return <label key={key} className={key === 'supplierName' ? 'market-ocr-review-field-wide' : undefined}>{label}
        <input disabled={busy || saved} defaultValue={(draft.header[key] as string | number | null | undefined) ?? ''} onChange={(event) => {
          const raw = event.target.value
          const numeric = numericHeaderKeys.includes(key)
          setDraft({ ...draft, header: { ...draft.header, [key]: raw === '' ? null : numeric ? parseLooseNumber(raw) : raw } })
        }} />
        {changed
          ? <small className="market-ocr-review-original is-changed">Original: {(original.header[key] as string | number | null | undefined) ?? 'não informado'}</small>
          : <small className="market-ocr-review-original">Sem alteração em relação ao original</small>}
      </label>
    })}</div>
    {draft.items.map((item,index) => <details key={index} className="market-purchase-item-card">
      <summary>
        <strong>Item {index+1} — {item.description_raw || 'sem descrição'}</strong>
        <span className="market-purchase-item-summary-line">{itemSummary(item)}</span>
        <span className={`market-row-status ${reviewProblems(item).length ? 'needs_review' : 'matched_auto'}`}>{reviewProblems(item).length ? 'Revisar valores' : 'Leitura consistente'} · não conferido</span>
      </summary>
      <PurchaseReviewFields values={item} original={original.items[index]} disabled={busy || saved}
        onChange={(values) => setDraft({ ...draft, items: draft.items.map((row,i) => i===index ? values : row) })} />
    </details>)}
    {error && <p role="alert">{error}</p>}
    {pageCount !== 1 && <p role="status">Este documento possui várias páginas. A consolidação precisa ser implementada antes de salvar a compra completa; nesta etapa, a persistência aceita uma página/documento por vez.</p>}
    {saved ? <p role="status">Documento salvo no staging. Continue a conciliação e a conferência na lista de compras.</p>
      : <button type="button" className="button" disabled={busy || pageCount !== 1 || !destinationStoreId || !draft.items.length} onClick={() => void save()}>{busy ? 'Salvando...' : 'Salvar e carregar para conciliação'}</button>}
  </section>
}
