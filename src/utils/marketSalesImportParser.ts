import type { MarketStore } from '../types/market'
import {
  MarketSalesImportError,
  type BarcodeStatus,
  type MarketSalesImportAnalysis,
  type MarketSalesImportPreviewRow,
  type MarketSalesImportStoreSummary,
} from '../types/marketSalesImport'

const MAX_FILE_SIZE = 10 * 1024 * 1024
const headerNames = {
  externalStoreCode: 'site id', externalStoreName: 'nome', externalEanRaw: 'barras',
  description: 'descrição', totalCost: 'custo total', quantity: 'quantidade total',
  unitPrice: 'valor un', totalAmount: 'valor total', profit: 'lucro', markup: 'markup', markdown: 'markdown',
} as const
const requiredHeaders = ['externalStoreCode', 'externalStoreName', 'externalEanRaw', 'description', 'quantity', 'totalAmount'] as const
type HeaderKey = keyof typeof headerNames

export interface ParseMarketSalesImportOptions {
  file: File
  stores: MarketStore[]
  hasAllStoresAccess: boolean
  products: Array<{ id: string; ean: string | null }>
  productMappings: Array<{ product_id: string; external_ean: string }>
}

const normalizeHeader = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR')
const normalizeStoreCode = (value: string) => value.trim().replace(/\.0+$/, '')
const isTotalizationMarker = (value: string) => /^totais?\s*:?$/i.test(value.trim())
const isTotalizationRow = (storeCode: string, storeName: string) =>
  isTotalizationMarker(storeCode) || (!storeCode && isTotalizationMarker(storeName))
const toIsoDate = (day: number, month: number, year: number) => {
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
    : null
}

export function parseLocalizedDecimal(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const text = String(value).trim()
  if (!text) return null
  const negativeByParentheses = /^\(.*\)$/.test(text)
  let normalized = text.replace(/[R$%\s]/g, '').replace(/[()]/g, '')
  if (normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.')
  const parsed = Number(normalized)
  if (!Number.isFinite(parsed)) return undefined
  return negativeByParentheses ? -Math.abs(parsed) : parsed
}

export function analyzeBarcode(rawValue: string): { normalized: string | null; status: BarcodeStatus } {
  const raw = rawValue.trim()
  if (!raw) return { normalized: null, status: 'missing' }
  const normalized = /^[\d\s.\-]+$/.test(raw) ? raw.replace(/[^\d]/g, '') : raw
  if (!/^\d+$/.test(normalized) || ![8, 12, 13, 14].includes(normalized.length)) return { normalized, status: 'invalid' }
  const digits = normalized.split('').map(Number)
  const checkDigit = digits.pop()!
  let sum = 0
  for (let index = digits.length - 1, position = 0; index >= 0; index--, position++) {
    sum += digits[index] * (position % 2 === 0 ? 3 : 1)
  }
  return { normalized, status: (10 - (sum % 10)) % 10 === checkDigit ? 'valid' : 'invalid' }
}

const hashFile = async (buffer: ArrayBuffer) => {
  const hash = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const displayValue = (cell: { value: unknown; text: string }): unknown => {
  const value = cell.value
  if (value instanceof Date) return cell.text || value.toISOString()
  if (typeof value === 'object' && value !== null) {
    if ('result' in value) return (value as { result?: unknown }).result ?? cell.text
    if ('richText' in value) return cell.text
    if ('text' in value) return (value as { text?: unknown }).text ?? cell.text
  }
  return value ?? ''
}

const textValue = (value: unknown) => value === null || value === undefined ? '' : String(value).trim()

export const resolveMarketSalesImportPreviewProduct = (
  barcodeNormalized: string | null,
  barcodeStatus: BarcodeStatus,
  productByBarcode: ReadonlyMap<string, { id: string }>,
  mappedProductIds: ReadonlyMap<string, ReadonlySet<string>>
) => {
  const mappedIds = barcodeNormalized ? mappedProductIds.get(barcodeNormalized) : undefined
  const mappingConflict = Boolean(mappedIds && mappedIds.size > 1)
  const mappedProductId = mappedIds?.size === 1 ? [...mappedIds][0] : null
  const catalogProduct = barcodeStatus === 'valid' && barcodeNormalized ? productByBarcode.get(barcodeNormalized) ?? null : null
  const conflict = mappingConflict || Boolean(mappedProductId && catalogProduct && mappedProductId !== catalogProduct.id)
  return { productId: conflict ? null : mappedProductId ?? catalogProduct?.id ?? null, conflict }
}

export const findMarketSalesImportPeriod = (metadataRows: string[][]) => {
  const datePattern = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/g
  const semanticRows = metadataRows.filter((row) => /per[ií]odo|data\s+inicial|data\s+final/i.test(row.join(' ')))
  const dates: string[] = []
  for (const row of semanticRows) {
    for (const match of row.join(' ').matchAll(datePattern)) {
      const iso = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))
      if (iso) dates.push(iso)
    }
  }
  // O relatório pode repetir a data inicial em mais de uma célula/linha.
  // Usar os limites cronológicos impede que a repetição vire periodEnd e
  // também preserva corretamente relatórios com período de um único dia.
  dates.sort()
  return { periodStart: dates[0] ?? null, periodEnd: dates.at(-1) ?? null }
}

export async function parseMarketSalesImport({ file, stores, hasAllStoresAccess, products, productMappings }: ParseMarketSalesImportOptions): Promise<MarketSalesImportAnalysis> {
  if (!file.name.toLocaleLowerCase().endsWith('.xlsx')) throw new MarketSalesImportError('Selecione um arquivo no formato XLSX.')
  if (file.size > MAX_FILE_SIZE) throw new MarketSalesImportError('A planilha excede o limite de 10 MB.')
  const buffer = await file.arrayBuffer()
  const fileHash = await hashFile(buffer)
  let workbook: import('exceljs').Workbook
  try {
    const ExcelJS = await import('exceljs')
    workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(
      new Uint8Array(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]
    )
  } catch (error) {
    console.error('Falha ao interpretar XLSX:', error)
    throw new MarketSalesImportError('Não foi possível ler a planilha. Verifique se o arquivo XLSX não está corrompido.')
  }

  let worksheet: import('exceljs').Worksheet | null = null
  let headerRowNumber = 0
  let headerMap = new Map<HeaderKey, number>()
  for (const candidate of workbook.worksheets) {
    const limit = Math.min(candidate.rowCount, 100)
    for (let rowNumber = 1; rowNumber <= limit; rowNumber++) {
      const row = candidate.getRow(rowNumber)
      const normalizedCells = new Map<string, number>()
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => normalizedCells.set(normalizeHeader(cell.text), columnNumber))
      const mapped = new Map<HeaderKey, number>()
      for (const [key, label] of Object.entries(headerNames) as [HeaderKey, string][]) {
        const column = normalizedCells.get(label)
        if (column) mapped.set(key, column)
      }
      if (['externalStoreCode', 'externalStoreName', 'externalEanRaw', 'description'].every((key) => mapped.has(key as HeaderKey))) {
        worksheet = candidate; headerRowNumber = rowNumber; headerMap = mapped; break
      }
    }
    if (worksheet) break
  }
  if (!worksheet) throw new MarketSalesImportError('Não foi possível reconhecer o formato da planilha.', ['Cabeçalho com Site Id, Nome, Barras e Descrição não localizado.'])
  const missing = requiredHeaders.filter((key) => !headerMap.has(key)).map((key) => headerNames[key])
  if (missing.length) throw new MarketSalesImportError('Não foi possível reconhecer o formato da planilha.', missing.map((name) => `Coluna não encontrada: ${name}`))

  const metadataRows: string[][] = []
  for (let index = 1; index < headerRowNumber; index++) {
    const values: string[] = []
    worksheet.getRow(index).eachCell({ includeEmpty: false }, (cell) => values.push(cell.text.trim()))
    metadataRows.push(values)
  }
  const period = findMarketSalesImportPeriod(metadataRows)
  const warnings = period.periodStart && period.periodEnd ? [] : ['Período completo do relatório não identificado.']
  const storeByCode = new Map(stores.filter((store) => store.status === 'active' && store.external_code).map((store) => [normalizeStoreCode(store.external_code!), store]))
  const productByBarcode = new Map(
    products.filter((product): product is { id: string; ean: string } => Boolean(product.ean)).map((product) => [product.ean.trim(), product])
  )
  const mappedProductIds = new Map<string, Set<string>>()
  for (const mapping of productMappings) {
    const code = mapping.external_ean.trim()
    if (!code) continue
    const productIds = mappedProductIds.get(code) ?? new Set<string>()
    productIds.add(mapping.product_id)
    mappedProductIds.set(code, productIds)
  }
  const rows: MarketSalesImportPreviewRow[] = []

  for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const sourceRow = worksheet.getRow(rowNumber)
    const originalHeaders = worksheet.getRow(headerRowNumber)
    const rawData: Record<string, unknown> = {}
    originalHeaders.eachCell({ includeEmpty: false }, (cell, columnNumber) => { rawData[cell.text.trim() || `Coluna ${columnNumber}`] = displayValue(sourceRow.getCell(columnNumber)) })
    const valueFor = (key: HeaderKey) => displayValue(sourceRow.getCell(headerMap.get(key)!))
    const externalStoreCodeRaw = textValue(valueFor('externalStoreCode'))
    const externalStoreName = textValue(valueFor('externalStoreName'))
    if (isTotalizationRow(externalStoreCodeRaw, externalStoreName)) continue
    const externalStoreCode = normalizeStoreCode(externalStoreCodeRaw)
    const externalEanRaw = textValue(valueFor('externalEanRaw'))
    const description = textValue(valueFor('description'))
    if (![externalStoreCode, externalStoreName, externalEanRaw, description, textValue(valueFor('quantity')), textValue(valueFor('totalAmount'))].some(Boolean)) continue
    const quantity = parseLocalizedDecimal(valueFor('quantity'))
    const totalAmount = parseLocalizedDecimal(valueFor('totalAmount'))
    const totalCost = headerMap.has('totalCost') ? parseLocalizedDecimal(valueFor('totalCost')) : null
    const unitPrice = headerMap.has('unitPrice') ? parseLocalizedDecimal(valueFor('unitPrice')) : null
    const profit = headerMap.has('profit') ? parseLocalizedDecimal(valueFor('profit')) : null
    const markup = headerMap.has('markup') ? parseLocalizedDecimal(valueFor('markup')) : null
    const markdown = headerMap.has('markdown') ? parseLocalizedDecimal(valueFor('markdown')) : null
    const numericError = quantity === undefined || totalAmount === undefined
    const barcode = analyzeBarcode(externalEanRaw)
    const productResolution = resolveMarketSalesImportPreviewProduct(barcode.normalized, barcode.status, productByBarcode, mappedProductIds)
    const productId = productResolution.productId
    const store = storeByCode.get(externalStoreCode) ?? null
    const storeReason = store ? null : hasAllStoresAccess ? 'STORE_NOT_FOUND' : 'STORE_NOT_ALLOWED'
    const productReason = productId ? null : productResolution.conflict ? 'PRODUCT_IDENTIFIER_CONFLICT' : barcode.status === 'missing' ? 'MISSING_PRODUCT_CODE' : barcode.status === 'invalid' ? 'NOT_VALIDATED_GTIN' : 'PRODUCT_NOT_FOUND'
    const errorCode = numericError ? 'INVALID_REQUIRED_NUMBER' : null
    const pendingReason = storeReason ?? productReason
    const status = numericError ? 'error' : storeReason === 'STORE_NOT_ALLOWED' ? 'store_not_allowed' : storeReason ? 'store_pending' : productReason ? 'product_pending' : 'ok'
    rows.push({ sourceRowNumber: rowNumber, externalStoreCode, externalStoreName, externalEanRaw, barcodeNormalized: barcode.normalized, barcodeStatus: barcode.status, description, totalCost: totalCost === undefined ? null : totalCost, quantity: quantity === undefined ? null : quantity, unitPrice: unitPrice === undefined ? null : unitPrice, totalAmount: totalAmount === undefined ? null : totalAmount, profit: profit === undefined ? null : profit, markup: markup === undefined ? null : markup, markdown: markdown === undefined ? null : markdown, storeId: store?.id ?? null, productId, storeResolutionStatus: store ? 'resolved' : 'pending', productResolutionStatus: productReason ? 'pending' : 'resolved', status, pendingReason, errorCode, errorMessage: numericError ? 'Quantidade Total ou Valor Total possui valor inválido.' : null, rawData })
    if (rows.length % 1000 === 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
  }
  if (!rows.length) throw new MarketSalesImportError('A planilha não possui linhas comerciais para analisar.')

  const storeSummaries = new Map<string, MarketSalesImportStoreSummary>()
  const productKeys = new Set<string>()
  for (const row of rows) {
    const key = row.externalStoreCode || row.externalStoreName || 'SEM_LOJA'
    const existing = storeSummaries.get(key)
    if (existing) existing.rowCount++
    else storeSummaries.set(key, { externalCode: row.externalStoreCode, externalName: row.externalStoreName, storeId: row.storeId, storeName: stores.find((store) => store.id === row.storeId)?.name ?? null, status: row.storeId ? 'resolved' : row.pendingReason === 'STORE_NOT_ALLOWED' ? 'not_allowed' : 'not_found', rowCount: 1 })
    productKeys.add(row.barcodeNormalized || `${row.externalEanRaw}|${row.description}`.toLocaleLowerCase('pt-BR'))
  }
  const sumNullable = (key: 'totalCost' | 'profit') => { const values = rows.map((row) => row[key]).filter((value): value is number => value !== null); return values.length ? values.reduce((sum, value) => sum + value, 0) : null }
  const stats = {
    totalRows: rows.length, validRows: rows.filter((row) => row.status !== 'error').length,
    pendingRows: rows.filter((row) => row.status !== 'ok' && row.status !== 'error').length,
    errorRows: rows.filter((row) => row.status === 'error').length,
    distinctStores: storeSummaries.size, recognizedStores: [...storeSummaries.values()].filter((store) => store.status === 'resolved').length,
    unrecognizedStores: [...storeSummaries.values()].filter((store) => store.status !== 'resolved').length,
    distinctProducts: productKeys.size, validBarcodes: rows.filter((row) => row.barcodeStatus === 'valid').length,
    invalidBarcodes: rows.filter((row) => row.barcodeStatus === 'invalid').length,
    missingBarcodes: rows.filter((row) => row.barcodeStatus === 'missing').length,
    totalQuantity: rows.reduce((sum, row) => sum + (row.quantity ?? 0), 0),
    totalRevenue: rows.reduce((sum, row) => sum + (row.totalAmount ?? 0), 0), totalCost: sumNullable('totalCost'), totalProfit: sumNullable('profit'),
  }
  return { fileName: file.name, fileSize: file.size, fileHash, worksheetName: worksheet.name, headerRowNumber, ...period, warnings, rows, stores: [...storeSummaries.values()], stats }
}
