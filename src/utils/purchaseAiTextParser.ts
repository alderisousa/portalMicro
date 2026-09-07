import type { PurchaseReviewValues } from '../types/marketPurchases'
import { AI_TEXT_SCHEMA_VERSION, type AiTextPurchaseDocument, type AiTextPurchaseDocumentHeader, type AiTextPurchaseItem } from '../types/purchaseAiText'

export { AI_TEXT_SCHEMA_VERSION }

export type AiTextParseResult =
  | { ok: true; data: AiTextPurchaseDocument }
  | { ok: false; error: string }

type FieldResult<T> = { ok: true; value: T } | { ok: false; error: string }

// Só remove o cercado ```/```json quando ele envolve a resposta INTEIRA
// (âncoras ^/$ no texto já aparado). Texto antes/depois do bloco não casa
// aqui e cai no fallback abaixo, que rejeita por não começar/terminar com
// chaves — é assim que "texto + fence" e "só o fence" são diferenciados.
const FENCE_RE = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n?```$/

function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(FENCE_RE)
  return fenced ? fenced[1].trim() : trimmed
}

const asStringOrNull = (value: unknown, field: string): FieldResult<string | null> => {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value === 'string') return { ok: true, value }
  // Defensivo: se a IA devolver um código como número (não deveria, o prompt
  // pede string), preserva como texto em vez de rejeitar — mas isto não
  // desfaz eventual perda de precisão que já teria ocorrido no JSON original.
  if (typeof value === 'number' && Number.isFinite(value)) return { ok: true, value: String(value) }
  return { ok: false, error: `Campo "${field}" inválido: deveria ser texto.` }
}

const asNumberOrNull = (value: unknown, field: string): FieldResult<number | null> => {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `Campo "${field}" inválido: deveria ser um número.` }
  if (value < 0) return { ok: false, error: `Campo "${field}" inválido: não pode ser negativo.` }
  return { ok: true, value }
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const asIsoDateOrNull = (value: unknown, field: string): FieldResult<string | null> => {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: `Campo "${field}" inválido: data deveria ser texto no formato AAAA-MM-DD.` }
  const match = value.match(ISO_DATE_RE)
  if (!match) return { ok: false, error: `Campo "${field}" inválido: use o formato AAAA-MM-DD.` }
  const [, y, m, d] = match
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  if (date.getUTCFullYear() !== Number(y) || date.getUTCMonth() !== Number(m) - 1 || date.getUTCDate() !== Number(d)) {
    return { ok: false, error: `Campo "${field}" inválido: data inexistente.` }
  }
  return { ok: true, value }
}

function validateHeader(raw: Record<string, unknown>): FieldResult<AiTextPurchaseDocumentHeader> {
  const supplierName = asStringOrNull(raw.supplier_name, 'document.supplier_name'); if (!supplierName.ok) return supplierName
  const supplierCnpj = asStringOrNull(raw.supplier_cnpj, 'document.supplier_cnpj'); if (!supplierCnpj.ok) return supplierCnpj
  const invoiceNumber = asStringOrNull(raw.invoice_number, 'document.invoice_number'); if (!invoiceNumber.ok) return invoiceNumber
  const series = asStringOrNull(raw.series, 'document.series'); if (!series.ok) return series
  const issueDate = asIsoDateOrNull(raw.issue_date, 'document.issue_date'); if (!issueDate.ok) return issueDate
  const accessKey = asStringOrNull(raw.access_key, 'document.access_key'); if (!accessKey.ok) return accessKey
  // products_total = valor MONETÁRIO total dos produtos, nunca quantidade de
  // itens/volumes (v1 usava "items_total", ambíguo o suficiente para IAs
  // reais confundirem contagem com valor — ver smoke tests JMS/Gaivota/Pompéia).
  const productsTotal = asNumberOrNull(raw.products_total, 'document.products_total'); if (!productsTotal.ok) return productsTotal
  const invoiceTotal = asNumberOrNull(raw.invoice_total, 'document.invoice_total'); if (!invoiceTotal.ok) return invoiceTotal
  return {
    ok: true,
    value: {
      supplier_name: supplierName.value, supplier_cnpj: supplierCnpj.value, invoice_number: invoiceNumber.value,
      series: series.value, issue_date: issueDate.value, access_key: accessKey.value,
      products_total: productsTotal.value, invoice_total: invoiceTotal.value,
    },
  }
}

function validateItem(raw: unknown, index: number): FieldResult<AiTextPurchaseItem> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: `Item ${index + 1} inválido: deveria ser um objeto.` }
  const item = raw as Record<string, unknown>
  if (typeof item.description !== 'string' || !item.description.trim()) return { ok: false, error: `Item ${index + 1}: descrição é obrigatória.` }
  const code = asStringOrNull(item.supplier_product_code, `items[${index}].supplier_product_code`); if (!code.ok) return code
  const barcode = asStringOrNull(item.barcode, `items[${index}].barcode`); if (!barcode.ok) return barcode
  const unit = asStringOrNull(item.unit, `items[${index}].unit`); if (!unit.ok) return unit
  const quantity = asNumberOrNull(item.quantity, `items[${index}].quantity`); if (!quantity.ok) return quantity
  const unitPrice = asNumberOrNull(item.unit_price, `items[${index}].unit_price`); if (!unitPrice.ok) return unitPrice
  const grossAmount = asNumberOrNull(item.gross_amount, `items[${index}].gross_amount`); if (!grossAmount.ok) return grossAmount
  const netAmount = asNumberOrNull(item.net_amount, `items[${index}].net_amount`); if (!netAmount.ok) return netAmount
  const lineNumber = typeof item.line_number === 'number' && Number.isInteger(item.line_number) && item.line_number > 0 ? item.line_number : index + 1
  return {
    ok: true,
    value: {
      line_number: lineNumber, supplier_product_code: code.value, barcode: barcode.value,
      description: item.description, quantity: quantity.value, unit: unit.value,
      unit_price: unitPrice.value, gross_amount: grossAmount.value, net_amount: netAmount.value,
    },
  }
}

// Validação defensiva: aceita JSON puro ou cercado em ```/```json, rejeita
// qualquer outra coisa com mensagem clara. Nunca tenta "consertar" JSON
// quebrado nem interpretar texto livre. Ausência vira null, nunca 0/"".
export function parseAiTextResponse(raw: string): AiTextParseResult {
  if (!raw || !raw.trim()) return { ok: false, error: 'Cole a resposta da IA antes de validar.' }
  const text = extractJsonText(raw)
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return { ok: false, error: 'A resposta precisa ser um único objeto JSON, sem texto antes ou depois (o bloco ```json``` é aceito).' }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch { return { ok: false, error: 'Não foi possível interpretar o JSON. Verifique se não há texto fora do objeto, vírgulas sobrando ou aspas inválidas.' } }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'A resposta precisa ser um objeto JSON no formato esperado.' }
  }
  const root = parsed as Record<string, unknown>
  if (root.schema_version !== AI_TEXT_SCHEMA_VERSION) {
    return { ok: false, error: `Versão do formato não suportada (schema_version esperado: "${AI_TEXT_SCHEMA_VERSION}").` }
  }
  if (typeof root.document !== 'object' || root.document === null || Array.isArray(root.document)) {
    return { ok: false, error: 'Campo "document" ausente ou inválido na resposta da IA.' }
  }
  if (!Array.isArray(root.items) || root.items.length === 0) {
    return { ok: false, error: 'Nenhum item encontrado na resposta da IA.' }
  }
  const header = validateHeader(root.document as Record<string, unknown>)
  if (!header.ok) return header
  const items: AiTextPurchaseItem[] = []
  for (let index = 0; index < root.items.length; index++) {
    const item = validateItem(root.items[index], index)
    if (!item.ok) return item
    items.push(item.value)
  }
  const warnings = Array.isArray(root.warnings) ? root.warnings.filter((warning): warning is string => typeof warning === 'string') : []
  return { ok: true, data: { schema_version: AI_TEXT_SCHEMA_VERSION, document: header.value, items, warnings } }
}

function isoDateToBrDate(iso: string): string | null {
  const match = iso.match(ISO_DATE_RE)
  if (!match) return null
  const [, y, m, d] = match
  return `${d}/${m}/${y}`
}

// Mesma forma {header,items} que pdfStagingDocument produz a partir do PDF —
// é o que PurchaseStagingReview/market_import_pdf_purchase_staging esperam,
// independente da origem. header usa as mesmas chaves camelCase do staging;
// items já nasce no formato PurchaseReviewValues (snake_case), sem embutir
// suposição alguma de conversão de embalagem (isso é etapa posterior).
export function aiTextStagingDocument(data: AiTextPurchaseDocument): { header: Record<string, unknown>; items: PurchaseReviewValues[] } {
  const header = {
    supplierName: data.document.supplier_name,
    supplierCnpj: data.document.supplier_cnpj,
    documentNumber: data.document.invoice_number,
    series: data.document.series,
    issueDate: data.document.issue_date ? isoDateToBrDate(data.document.issue_date) : null,
    accessKey: data.document.access_key,
    productsTotal: data.document.products_total,
    discount: null,
    freight: null,
    otherExpenses: null,
    invoiceTotal: data.document.invoice_total,
  }
  const items: PurchaseReviewValues[] = data.items.map((item) => ({
    supplier_product_code: item.supplier_product_code,
    barcode_raw: item.barcode,
    description_raw: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unit_price: item.unit_price,
    gross_amount: item.gross_amount,
    // Texto IA: net_amount ausente fica null (não inventamos valor líquido
    // aqui). Diferente do PDF (pdfStagingDocument), que sempre iguala
    // net=gross porque o parser de PDF nunca separou os dois — regra própria
    // e intencionalmente não compartilhada com esta origem.
    net_amount: item.net_amount,
    discount_amount: 0,
    freight_amount: 0,
    other_amount: 0,
  }))
  return { header, items }
}
