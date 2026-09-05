// Modelo estruturado do documento extraido por OCR (Sprint 5D.2 — ainda PoC local,
// sem gravacao em market_purchases/market_purchase_items). Cada campo individual
// carrega seu proprio estado de resolucao, para nunca inventar um valor ausente e
// sempre deixar claro o que veio do OCR, o que o usuario corrigiu e o que ainda
// precisa de revisao humana.

export type FieldStatus = 'resolved_ocr' | 'resolved_user' | 'pending_review'

export interface OcrField<T> {
  value: T | null
  status: FieldStatus
  // Confianca 0-100 quando a origem for OCR (media dos tokens usados para este
  // campo); null quando o usuario define/edita o valor ou quando o campo ficou
  // pendente sem nenhum candidato encontrado.
  confidence: number | null
}

export function pendingField<T>(): OcrField<T> {
  return { value: null, status: 'pending_review', confidence: null }
}

export function ocrField<T>(value: T, confidence: number | null): OcrField<T> {
  return { value, status: 'resolved_ocr', confidence }
}

export function userField<T>(value: T | null): OcrField<T> {
  return value === null ? pendingField<T>() : { value, status: 'resolved_user', confidence: null }
}

export interface PurchaseOcrHeader {
  supplierName: OcrField<string>
  supplierCnpj: OcrField<string>
  documentNumber: OcrField<string>
  series: OcrField<string>
  issueDate: OcrField<string>
  accessKey: OcrField<string>
  productsTotal: OcrField<number>
  discount: OcrField<number>
  freight: OcrField<number>
  otherExpenses: OcrField<number>
  invoiceTotal: OcrField<number>
}

export function emptyHeader(): PurchaseOcrHeader {
  return {
    supplierName: pendingField(), supplierCnpj: pendingField(), documentNumber: pendingField(),
    series: pendingField(), issueDate: pendingField(), accessKey: pendingField(),
    productsTotal: pendingField(), discount: pendingField(), freight: pendingField(),
    otherExpenses: pendingField(), invoiceTotal: pendingField(),
  }
}

// OK: quantidade x valor unitario bate com o total da linha (dentro da tolerancia).
// REVISAR: os tres valores existem mas a conta nao fecha.
// INCOMPLETA: falta pelo menos um dos tres valores para sequer conferir a conta.
export type PurchaseItemLineStatus = 'ok' | 'review' | 'incomplete'

export interface PurchaseOcrItem {
  id: string
  supplierCode: OcrField<string>
  barcode: OcrField<string>
  description: OcrField<string>
  quantity: OcrField<number>
  unit: OcrField<string>
  unitPrice: OcrField<number>
  lineTotal: OcrField<number>
  lineStatus: PurchaseItemLineStatus
  // quantity * unitPrice recalculado (em centavos) — null quando falta algum dos dois.
  computedTotalCents: number | null
  // Texto bruto da linha de origem no OCR, sempre preservado para auditoria/depuracao,
  // mesmo quando a linha nao pode ser dividida em campos com seguranca.
  rawSourceText: string
}

export interface PurchaseOcrDocument {
  header: PurchaseOcrHeader
  items: PurchaseOcrItem[]
}
