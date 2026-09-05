import type { PurchaseOcrDocument, PurchaseOcrHeader, PurchaseOcrItem, PurchaseItemLineStatus } from '../types/purchaseOcr'

// Aceita tanto virgula quanto ponto decimal (o usuario pode digitar de qualquer
// jeito); pontos antes de uma virgula sao tratados como separador de milhar.
export function parseLooseNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const normalized = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

// Toda comparacao monetaria deste modulo e feita em centavos (inteiros), nunca
// comparando floats diretamente — evita falsos "REVISAR" por erro de ponto
// flutuante (ex.: 15 * 7.59 em JS pode dar 113.85000000000001).
export const toCents = (value: number): number => Math.round(value * 100)

const currencyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
export const centsToBRL = (cents: number): string => currencyFormatter.format(cents / 100)

// Tolerancia de arredondamento entre o total calculado (quantidade x valor unitario)
// e o total impresso na linha — algumas notas arredondam o valor unitario antes de
// multiplicar. Ponto de partida para calibrar com fotos reais.
const LINE_TOTAL_TOLERANCE_CENTS = 2
// Tolerancia entre a soma dos itens e o total de produtos do cabecalho.
const DOCUMENT_TOTAL_TOLERANCE_CENTS = 5

export function evaluateItemLine(item: Pick<PurchaseOcrItem, 'quantity' | 'unitPrice' | 'lineTotal'>): {
  lineStatus: PurchaseItemLineStatus
  computedTotalCents: number | null
} {
  const quantity = item.quantity.value
  const unitPrice = item.unitPrice.value
  const lineTotal = item.lineTotal.value

  if (quantity === null || unitPrice === null) {
    return { lineStatus: 'incomplete', computedTotalCents: null }
  }
  const computedTotalCents = Math.round(quantity * toCents(unitPrice))
  if (lineTotal === null) {
    return { lineStatus: 'incomplete', computedTotalCents }
  }
  const diff = Math.abs(computedTotalCents - toCents(lineTotal))
  return { lineStatus: diff <= LINE_TOTAL_TOLERANCE_CENTS ? 'ok' : 'review', computedTotalCents }
}

// Recalcula lineStatus/computedTotalCents de um item — chamar sempre apos qualquer
// edicao manual de quantidade/valor unitario/total da linha.
export function recalculateItem(item: PurchaseOcrItem): PurchaseOcrItem {
  const { lineStatus, computedTotalCents } = evaluateItemLine(item)
  return { ...item, lineStatus, computedTotalCents }
}

export type DocumentTotalsStatus = 'match' | 'mismatch' | 'unavailable'

export interface DocumentTotalsSummary {
  itemsIdentified: number
  itemsOk: number
  itemsReview: number
  itemsIncomplete: number
  // Itens cujo total de linha existe e entra na soma (ok + review); incompletos ficam de fora.
  itemsUsableForSum: number
  sumOfItemsCents: number | null
  productsTotalCents: number | null
  differenceCents: number | null
  status: DocumentTotalsStatus
}

// Soma os lineTotal dos itens validos/revisados (nao dos incompletos, que nao tem
// total algum) e compara com productsTotal do cabecalho — nunca com invoiceTotal,
// que pode incluir frete/desconto/impostos/outras despesas (conceito diferente).
export function evaluateDocumentTotals(header: PurchaseOcrHeader, items: PurchaseOcrItem[]): DocumentTotalsSummary {
  const itemsOk = items.filter((item) => item.lineStatus === 'ok').length
  const itemsReview = items.filter((item) => item.lineStatus === 'review').length
  const itemsIncomplete = items.filter((item) => item.lineStatus === 'incomplete').length
  const usableItems = items.filter((item) => item.lineTotal.value !== null)

  const sumOfItemsCents = usableItems.length
    ? usableItems.reduce((sum, item) => sum + toCents(item.lineTotal.value as number), 0)
    : null

  const productsTotalCents = header.productsTotal.value !== null ? toCents(header.productsTotal.value) : null

  let status: DocumentTotalsStatus = 'unavailable'
  let differenceCents: number | null = null
  if (productsTotalCents !== null && sumOfItemsCents !== null) {
    differenceCents = sumOfItemsCents - productsTotalCents
    status = Math.abs(differenceCents) <= DOCUMENT_TOTAL_TOLERANCE_CENTS ? 'match' : 'mismatch'
  }

  return {
    itemsIdentified: items.length, itemsOk, itemsReview, itemsIncomplete,
    itemsUsableForSum: usableItems.length, sumOfItemsCents, productsTotalCents, differenceCents, status,
  }
}

// Parametros centralizados da avaliacao geral de leitura — ajustar so aqui conforme
// calibrarmos com mais documentos reais. Ponto de partida, nao calibrado ainda.
export const READING_QUALITY_THRESHOLDS = {
  ocrConfidenceGood: 70,
  ocrConfidenceReviewFloor: 60,
  minResolvedHeaderFields: 2,
  maxIncompleteItemsRatio: 0.3,
}

export type OverallReadingLevel = 'good' | 'needs_review' | 'weak'

export interface OverallReadingAssessment {
  level: OverallReadingLevel
  label: string
  reasons: string[]
}

const HEADER_KEY_FIELDS: Array<keyof PurchaseOcrHeader> = ['supplierName', 'supplierCnpj', 'documentNumber', 'accessKey']

function countResolvedHeaderFields(header: PurchaseOcrHeader): number {
  return HEADER_KEY_FIELDS.filter((key) => header[key].value !== null).length
}

// A decisao NAO depende so da confianca media do Tesseract: uma leitura de 68% com
// estrutura consistente pode valer mais do que uma de 80% cuja tabela saiu picada.
// Por isso o nivel base (pela confianca) pode ser subido ou rebaixado por sinais
// estruturais (cabecalho resolvido, itens pendentes, consistencia matematica).
export function assessOverallReading(input: {
  ocrConfidence: number | null
  // false para texto extraido direto de um PDF (sem reconhecimento de caractere,
  // logo "confianca de OCR" nao se aplica) — ver Sprint 5D.2.1. Nesses casos o
  // nivel parte neutro (PRECISA CONFERIR) e so sobe/desce por sinais estruturais,
  // nunca "confiavel automaticamente" so por ter camada de texto.
  confidenceApplicable?: boolean
  imageQualityWarningsCount: number
  header: PurchaseOcrHeader
  items: PurchaseOcrItem[]
  totals: DocumentTotalsSummary
}): OverallReadingAssessment {
  const { ocrConfidence, confidenceApplicable = true, imageQualityWarningsCount, header, items, totals } = input
  const reasons: string[] = []

  let level: OverallReadingLevel
  if (!confidenceApplicable) {
    level = 'needs_review'
    reasons.push('Texto extraído diretamente do documento (sem reconhecimento de caractere) — revisão continua obrigatória.')
  } else if (ocrConfidence === null) {
    level = 'weak'
    reasons.push('Confiança do OCR não disponível.')
  } else if (ocrConfidence >= READING_QUALITY_THRESHOLDS.ocrConfidenceGood) {
    level = 'good'
    reasons.push(`Confiança média do OCR boa (${Math.round(ocrConfidence)}%).`)
  } else if (ocrConfidence >= READING_QUALITY_THRESHOLDS.ocrConfidenceReviewFloor) {
    level = 'needs_review'
    reasons.push(`Confiança média do OCR intermediária (${Math.round(ocrConfidence)}%).`)
  } else {
    level = 'weak'
    reasons.push(`Confiança média do OCR baixa (${Math.round(ocrConfidence)}%).`)
  }

  const resolvedHeaderFields = countResolvedHeaderFields(header)
  const headerOk = resolvedHeaderFields >= READING_QUALITY_THRESHOLDS.minResolvedHeaderFields
  if (!headerOk) reasons.push(`Poucos campos de cabeçalho identificados (${resolvedHeaderFields}/${HEADER_KEY_FIELDS.length}).`)

  const incompleteRatio = items.length ? totals.itemsIncomplete / items.length : 1
  const itemsOk = items.length > 0 && incompleteRatio <= READING_QUALITY_THRESHOLDS.maxIncompleteItemsRatio
  if (!items.length) reasons.push('Nenhum item identificado na imagem.')
  else if (incompleteRatio > READING_QUALITY_THRESHOLDS.maxIncompleteItemsRatio) {
    reasons.push(`Muitos itens incompletos (${totals.itemsIncomplete}/${items.length}).`)
  }

  const mathOk = items.every((item) => item.lineStatus !== 'review')
  if (!mathOk) reasons.push('Há itens com inconsistência matemática (quantidade × valor unitário ≠ total).')

  const totalsOk = totals.status !== 'mismatch'
  if (totals.status === 'mismatch' && totals.differenceCents !== null) {
    reasons.push(`Soma dos itens diverge do total de produtos em ${centsToBRL(Math.abs(totals.differenceCents))}.`)
  }

  if (imageQualityWarningsCount > 0) reasons.push(`A imagem apresentou ${imageQualityWarningsCount} aviso(s) de qualidade.`)

  // Estrutura consistente pode subir um nivel; estrutura ruim pode descer um nivel —
  // nunca os dois ao mesmo tempo (evita oscilar de forma confusa).
  const structureGood = headerOk && itemsOk && mathOk && totalsOk && imageQualityWarningsCount === 0
  const structureBad = !headerOk || !itemsOk || !mathOk || totals.status === 'mismatch'

  const levels: OverallReadingLevel[] = ['weak', 'needs_review', 'good']
  let levelIndex = levels.indexOf(level)
  if (structureGood && levelIndex < levels.length - 1) levelIndex += 1
  else if (structureBad && levelIndex > 0) levelIndex -= 1
  level = levels[levelIndex]

  const labelByLevel: Record<OverallReadingLevel, string> = {
    good: 'LEITURA BOA', needs_review: 'PRECISA CONFERIR', weak: 'LEITURA FRACA',
  }
  return { level, label: labelByLevel[level], reasons }
}

export interface ReconciliationReadiness {
  ready: boolean
  reasons: string[]
}

// Unica funcao que decide se o botao "Carregar para conciliação" pode ser habilitado
// — nao espalhar essa logica pelo JSX. Nenhum destes criterios grava nada; so libera
// a preparacao do payload local.
export function evaluateReconciliationReadiness(input: {
  ocrFailed: boolean
  imageUnreadable: boolean
  header: PurchaseOcrHeader
  items: PurchaseOcrItem[]
  totals: DocumentTotalsSummary
  userConfirmedAgainstOriginal: boolean
}): ReconciliationReadiness {
  const { ocrFailed, imageUnreadable, header, items, totals, userConfirmedAgainstOriginal } = input
  const reasons: string[] = []

  if (ocrFailed || imageUnreadable) reasons.push('A leitura desta imagem falhou — refaça a análise antes de continuar.')

  const resolvedHeaderFields = countResolvedHeaderFields(header)
  if (resolvedHeaderFields < READING_QUALITY_THRESHOLDS.minResolvedHeaderFields) {
    reasons.push('Complete ao menos o fornecedor/CNPJ e o número/chave do documento no cabeçalho.')
  }

  if (items.length === 0) reasons.push('Nenhum item identificado — adicione ao menos um item.')

  const incompleteItems = items.filter((item) => item.lineStatus === 'incomplete').length
  if (incompleteItems > 0) reasons.push(`Existem ${incompleteItems} item(ns) incompleto(s) — preencha quantidade, valor unitário e total.`)

  const reviewItems = items.filter((item) => item.lineStatus === 'review').length
  if (reviewItems > 0) reasons.push(`Existem ${reviewItems} item(ns) com inconsistência matemática — corrija antes de continuar.`)

  if (totals.status === 'mismatch') reasons.push('A soma dos itens não confere com o total de produtos do documento.')

  if (!userConfirmedAgainstOriginal) reasons.push('Confirme que conferiu os dados extraídos com o documento original.')

  return { ready: reasons.length === 0, reasons }
}

export function buildDocumentSummary(document: PurchaseOcrDocument): DocumentTotalsSummary {
  return evaluateDocumentTotals(document.header, document.items)
}

// Payload local, so para diagnostico/preview neste checkpoint — nada aqui grava em
// market_purchases/market_purchase_items. So deve ser chamado quando a leitura for
// considerada pronta (ver evaluateReconciliationReadiness), entao os campos criticos
// ja estao resolvidos (por OCR ou pelo usuario); mesmo assim os tipos permanecem
// nullable porque nada aqui impede a funcao de ser chamada fora dessa condicao.
export function buildReconciliationPayload(document: PurchaseOcrDocument) {
  return {
    header: {
      supplierName: document.header.supplierName.value,
      supplierCnpj: document.header.supplierCnpj.value,
      documentNumber: document.header.documentNumber.value,
      series: document.header.series.value,
      issueDate: document.header.issueDate.value,
      accessKey: document.header.accessKey.value,
      productsTotal: document.header.productsTotal.value,
      discount: document.header.discount.value,
      freight: document.header.freight.value,
      otherExpenses: document.header.otherExpenses.value,
      invoiceTotal: document.header.invoiceTotal.value,
    },
    items: document.items.map((item) => ({
      supplierCode: item.supplierCode.value,
      barcode: item.barcode.value,
      description: item.description.value,
      quantity: item.quantity.value,
      unit: item.unit.value,
      unitPrice: item.unitPrice.value,
      lineTotal: item.lineTotal.value,
    })),
  }
}
