import { AlertCircle, CheckCircle2, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  pendingField, userField,
  type FieldStatus, type PurchaseOcrDocument, type PurchaseOcrHeader, type PurchaseOcrItem,
} from '../types/purchaseOcr'
import {
  assessOverallReading, buildDocumentSummary, buildReconciliationPayload, centsToBRL,
  evaluateReconciliationReadiness, parseLooseNumber, recalculateItem,
} from '../utils/purchaseOcrMath'

// Tela de revisao do documento estruturado extraido por OCR (Sprint 5D.2 — ainda
// PoC local). NAO grava nada: "Carregar para conciliação" so monta e mostra o
// payload que uma proxima etapa (fora deste checkpoint) usaria para alimentar o
// pipeline real de compras/conciliacao. Cada pagina (PhotoPage) tem a sua propria
// instancia desta tela — consolidacao entre paginas fica para depois (ver Sprint 5D
// item 11: BRF Folha 1/2 sera usada para validar essa evolucao).
interface Props {
  document: PurchaseOcrDocument
  // Rotulo de origem exigido pela Sprint 5D.2.1 (ex.: "Foto / imagem — OCR local",
  // "PDF — texto extraído localmente", "PDF escaneado — OCR local").
  origin: string
  ocrConfidence: number | null
  // false para PDF com camada de texto (nao houve reconhecimento de caractere) —
  // ver assessOverallReading em purchaseOcrMath.ts.
  confidenceApplicable?: boolean
  imageQualityWarningsCount: number
}

const HEADER_TEXT_FIELDS: Array<{ key: keyof PurchaseOcrHeader; label: string }> = [
  { key: 'supplierName', label: 'Fornecedor' },
  { key: 'supplierCnpj', label: 'CNPJ' },
  { key: 'documentNumber', label: 'Número' },
  { key: 'series', label: 'Série' },
  { key: 'issueDate', label: 'Data' },
  { key: 'accessKey', label: 'Chave fiscal' },
]

const HEADER_MONEY_FIELDS: Array<{ key: 'productsTotal' | 'discount' | 'freight' | 'otherExpenses' | 'invoiceTotal'; label: string }> = [
  { key: 'productsTotal', label: 'Total dos produtos' },
  { key: 'discount', label: 'Desconto' },
  { key: 'freight', label: 'Frete' },
  { key: 'otherExpenses', label: 'Outras despesas' },
  { key: 'invoiceTotal', label: 'Total da nota' },
]

const formatDraft = (value: number | null): string => (value === null ? '' : String(value).replace('.', ','))

const STATUS_LABEL: Record<FieldStatus, string> = {
  resolved_ocr: 'Lido pelo OCR', resolved_user: 'Editado', pending_review: 'Pendente',
}
const STATUS_CLASS: Record<FieldStatus, string> = {
  resolved_ocr: 'is-ocr', resolved_user: 'is-user', pending_review: 'is-pending',
}

function FieldStatusTag({ status }: { status: FieldStatus }) {
  return <span className={`market-ocr-review-field-tag ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
}

const ITEM_LINE_LABEL: Record<PurchaseOcrItem['lineStatus'], string> = { ok: 'OK', review: 'Revisar', incomplete: 'Incompleta' }
const ITEM_LINE_CLASS: Record<PurchaseOcrItem['lineStatus'], string> = { ok: 'is-ok', review: 'is-review', incomplete: 'is-incomplete' }

export function PurchaseOcrReview({ document: initialDocument, origin, ocrConfidence, confidenceApplicable = true, imageQualityWarningsCount }: Props) {
  const [document, setDocument] = useState<PurchaseOcrDocument>(initialDocument)
  const [confirmedAgainstOriginal, setConfirmedAgainstOriginal] = useState(false)
  const [payloadPreview, setPayloadPreview] = useState<string | null>(null)
  const [itemDrafts, setItemDrafts] = useState<Record<string, { quantity: string; unit: string; unitPrice: string; lineTotal: string }>>(() => (
    Object.fromEntries(initialDocument.items.map((item) => [item.id, {
      quantity: formatDraft(item.quantity.value), unit: item.unit.value ?? '',
      unitPrice: formatDraft(item.unitPrice.value), lineTotal: formatDraft(item.lineTotal.value),
    }]))
  ))
  const [headerMoneyDrafts, setHeaderMoneyDrafts] = useState<Record<string, string>>(() => (
    Object.fromEntries(HEADER_MONEY_FIELDS.map(({ key }) => [key, formatDraft(initialDocument.header[key].value)]))
  ))

  const totals = useMemo(() => buildDocumentSummary(document), [document])
  const assessment = useMemo(() => assessOverallReading({
    ocrConfidence, confidenceApplicable, imageQualityWarningsCount, header: document.header, items: document.items, totals,
  }), [ocrConfidence, confidenceApplicable, imageQualityWarningsCount, document, totals])
  const readiness = useMemo(() => evaluateReconciliationReadiness({
    ocrFailed: false, imageUnreadable: false, header: document.header, items: document.items, totals,
    userConfirmedAgainstOriginal: confirmedAgainstOriginal,
  }), [document, totals, confirmedAgainstOriginal])

  const updateHeaderText = (key: keyof PurchaseOcrHeader, raw: string) => {
    setDocument((prev) => ({ ...prev, header: { ...prev.header, [key]: raw.trim() ? userField(raw) : pendingField() } }))
  }

  const updateHeaderMoney = (key: typeof HEADER_MONEY_FIELDS[number]['key'], raw: string) => {
    setHeaderMoneyDrafts((prev) => ({ ...prev, [key]: raw }))
    const parsed = parseLooseNumber(raw)
    setDocument((prev) => ({ ...prev, header: { ...prev.header, [key]: parsed === null ? pendingField() : userField(parsed) } }))
  }

  const updateItemText = (itemId: string, key: 'supplierCode' | 'barcode' | 'description', raw: string) => {
    setDocument((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === itemId ? { ...item, [key]: raw.trim() ? userField(raw) : pendingField() } : item)),
    }))
  }

  const updateItemUnit = (itemId: string, raw: string) => {
    setItemDrafts((prev) => ({ ...prev, [itemId]: { ...prev[itemId], unit: raw } }))
    setDocument((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === itemId ? { ...item, unit: raw.trim() ? userField(raw.toUpperCase()) : pendingField() } : item)),
    }))
  }

  const updateItemNumber = (itemId: string, key: 'quantity' | 'unitPrice' | 'lineTotal', raw: string) => {
    setItemDrafts((prev) => ({ ...prev, [itemId]: { ...prev[itemId], [key]: raw } }))
    const parsed = parseLooseNumber(raw)
    setDocument((prev) => ({
      ...prev,
      items: prev.items.map((item) => (item.id === itemId ? recalculateItem({ ...item, [key]: parsed === null ? pendingField() : userField(parsed) }) : item)),
    }))
  }

  const removeItem = (itemId: string) => {
    setDocument((prev) => ({ ...prev, items: prev.items.filter((item) => item.id !== itemId) }))
    setItemDrafts((prev) => { const next = { ...prev }; delete next[itemId]; return next })
  }

  const addManualItem = () => {
    const id = crypto.randomUUID()
    setItemDrafts((prev) => ({ ...prev, [id]: { quantity: '', unit: '', unitPrice: '', lineTotal: '' } }))
    setDocument((prev) => ({
      ...prev,
      items: [...prev.items, {
        id, supplierCode: pendingField(), barcode: pendingField(), description: pendingField(),
        quantity: pendingField(), unit: pendingField(), unitPrice: pendingField(), lineTotal: pendingField(),
        lineStatus: 'incomplete', computedTotalCents: null, rawSourceText: '',
      }],
    }))
  }

  const handleLoadToReconciliation = () => {
    if (!readiness.ready) return
    setPayloadPreview(JSON.stringify(buildReconciliationPayload(document), null, 2))
  }

  // Cada campo e construido separadamente (nao um bloco unico) para render tanto
  // como colunas de verdade na tabela desktop quanto como pares label+valor no
  // card mobile — sem duplicar a logica de onChange.
  const buildItemInputs = (item: PurchaseOcrItem) => {
    const drafts = itemDrafts[item.id] ?? { quantity: '', unit: '', unitPrice: '', lineTotal: '' }
    return {
      code: <input value={item.supplierCode.value || item.barcode.value || ''} placeholder="Código/EAN"
        onChange={(event) => updateItemText(item.id, item.barcode.value ? 'barcode' : 'supplierCode', event.target.value)} />,
      description: <input value={item.description.value ?? ''} placeholder="Descrição" onChange={(event) => updateItemText(item.id, 'description', event.target.value)} />,
      quantity: <input value={drafts.quantity} placeholder="Qtd." inputMode="decimal" onChange={(event) => updateItemNumber(item.id, 'quantity', event.target.value)} />,
      unit: <input value={drafts.unit} placeholder="Un." onChange={(event) => updateItemUnit(item.id, event.target.value)} />,
      unitPrice: <input value={drafts.unitPrice} placeholder="Valor unit." inputMode="decimal" onChange={(event) => updateItemNumber(item.id, 'unitPrice', event.target.value)} />,
      lineTotal: <input value={drafts.lineTotal} placeholder="Total" inputMode="decimal" onChange={(event) => updateItemNumber(item.id, 'lineTotal', event.target.value)} />,
    }
  }

  const renderItemTableRow = (item: PurchaseOcrItem) => {
    const f = buildItemInputs(item)
    return <tr key={item.id} className={`market-ocr-review-item-row ${ITEM_LINE_CLASS[item.lineStatus]}`}>
      <td>{f.code}</td>
      <td className="market-ocr-review-desc-cell">{f.description}</td>
      <td>{f.quantity}</td>
      <td>{f.unit}</td>
      <td>{f.unitPrice}</td>
      <td>{f.lineTotal}</td>
      <td><span className={`market-ocr-review-item-status ${ITEM_LINE_CLASS[item.lineStatus]}`}>{ITEM_LINE_LABEL[item.lineStatus]}</span></td>
      <td><button type="button" className="button button-small button-outline" onClick={() => removeItem(item.id)}><Trash2 size={14} /></button></td>
    </tr>
  }

  const renderItemCard = (item: PurchaseOcrItem) => {
    const f = buildItemInputs(item)
    return <article key={item.id} className={`market-ocr-review-item-card ${ITEM_LINE_CLASS[item.lineStatus]}`}>
      <div className="market-ocr-review-item-card-head">
        <span className={`market-ocr-review-item-status ${ITEM_LINE_CLASS[item.lineStatus]}`}>{ITEM_LINE_LABEL[item.lineStatus]}</span>
        <button type="button" className="button button-small button-outline" onClick={() => removeItem(item.id)}><Trash2 size={14} /> Remover</button>
      </div>
      <div className="market-ocr-review-item-card-grid">
        <label>Código/EAN {f.code}</label>
        <label>Descrição {f.description}</label>
        <label>Quantidade {f.quantity}</label>
        <label>Unidade {f.unit}</label>
        <label>Valor unitário {f.unitPrice}</label>
        <label>Total {f.lineTotal}</label>
      </div>
    </article>
  }

  return <div className="market-ocr-review">
    <div className="market-ocr-review-origin">Origem: {origin}</div>
    <h3>Dados do documento</h3>
    <div className="market-ocr-review-header-grid">
      {HEADER_TEXT_FIELDS.map(({ key, label }) => <label key={key} className="market-ocr-review-field">
        <span>{label} <FieldStatusTag status={document.header[key].status} /></span>
        <input value={document.header[key].value ?? ''} onChange={(event) => updateHeaderText(key, event.target.value)} placeholder={label} />
      </label>)}
      {HEADER_MONEY_FIELDS.map(({ key, label }) => <label key={key} className="market-ocr-review-field">
        <span>{label} <FieldStatusTag status={document.header[key].status} /></span>
        <input value={headerMoneyDrafts[key] ?? ''} inputMode="decimal" onChange={(event) => updateHeaderMoney(key, event.target.value)} placeholder="0,00" />
      </label>)}
    </div>

    <h3>Itens identificados</h3>
    <div className="market-ocr-review-items-table-wrap">
      <table className="market-ocr-review-items-table">
        <thead><tr><th>Código/EAN</th><th>Descrição</th><th>Qtd.</th><th>Un.</th><th>Valor unit.</th><th>Total</th><th>Status</th><th /></tr></thead>
        <tbody>{document.items.map((item) => renderItemTableRow(item))}</tbody>
      </table>
    </div>
    <div className="market-ocr-review-items-cards">{document.items.map((item) => renderItemCard(item))}</div>
    {!document.items.length && <p className="market-ocr-review-empty">Nenhum item identificado nesta imagem.</p>}
    <button type="button" className="button button-small button-outline" onClick={addManualItem}>Adicionar item manualmente</button>

    <div className="market-ocr-review-summary">
      <h3>Conferência do total de produtos</h3>
      <dl>
        <div><dt>Itens identificados</dt><dd>{totals.itemsIdentified}</dd></div>
        <div><dt>OK</dt><dd>{totals.itemsOk}</dd></div>
        <div><dt>Revisar</dt><dd>{totals.itemsReview}</dd></div>
        <div><dt>Incompletos</dt><dd>{totals.itemsIncomplete}</dd></div>
        <div><dt>Soma dos itens</dt><dd>{totals.sumOfItemsCents !== null ? centsToBRL(totals.sumOfItemsCents) : '-'}</dd></div>
        <div><dt>Total dos produtos (documento)</dt><dd>{totals.productsTotalCents !== null ? centsToBRL(totals.productsTotalCents) : 'não encontrado'}</dd></div>
        <div><dt>Diferença</dt><dd>{totals.differenceCents !== null ? centsToBRL(totals.differenceCents) : '-'}</dd></div>
      </dl>
      <p className={`market-ocr-review-totals-status is-${totals.status}`}>
        {totals.status === 'match' ? 'VALORES CONFEREM' : totals.status === 'mismatch' ? 'DIFERENÇA ENCONTRADA' : 'TOTAL DE PRODUTOS NÃO ENCONTRADO NO DOCUMENTO'}
      </p>
    </div>

    <div className="market-ocr-review-assessment">
      <h3>Validação da leitura</h3>
      <p className={`market-ocr-review-assessment-label is-${assessment.level}`}>{assessment.label}</p>
      <ul>{assessment.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
    </div>

    <label className="market-ocr-review-confirm">
      <input type="checkbox" checked={confirmedAgainstOriginal} onChange={(event) => setConfirmedAgainstOriginal(event.target.checked)} />
      Conferi os dados com o documento original.
    </label>
    <p className="market-ocr-review-confirm-hint">Confira os dados extraídos com a nota original antes de continuar.</p>

    {!readiness.ready && <ul className="market-ocr-review-pending-reasons">
      {readiness.reasons.map((reason, index) => <li key={index}><AlertCircle size={14} /> {reason}</li>)}
    </ul>}

    <button type="button" className="button" disabled={!readiness.ready} onClick={handleLoadToReconciliation}>Carregar para conciliação</button>

    {payloadPreview && <div className="market-ocr-review-payload">
      <p><CheckCircle2 size={15} /> Payload preparado — nada foi gravado ainda. Esta é só uma prévia do que seria enviado à conciliação numa próxima etapa.</p>
      <pre>{payloadPreview}</pre>
    </div>}
  </div>
}
