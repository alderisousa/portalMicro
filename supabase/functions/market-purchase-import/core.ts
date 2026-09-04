export class PurchaseImportError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message)
  }
}

export type PurchaseImportSourceType = 'qrcode_url' | 'access_key'
export type PurchaseImportMode = 'import' | 'reimport'

export interface NormalizedNfeItem {
  lineNumber: number
  supplierProductCode?: string
  barcode?: string
  description: string
  ncm?: string
  cfop?: string
  unit?: string
  quantity: number
  unitPrice?: number
  grossAmount?: number
  discountAmount?: number
  freightAmount?: number
  otherAmount?: number
  netAmount?: number
}

export interface NormalizedNfe {
  provider: string
  accessKey: string
  invoiceNumber?: string
  series?: string
  issuedAt?: string
  supplier: { name?: string; document?: string }
  totals: {
    productsAmount?: number
    freightAmount?: number
    discountAmount?: number
    otherAmount?: number
    totalAmount?: number
  }
  items: NormalizedNfeItem[]
}

const ACCESS_KEY = /^\d{44}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function normalizeAccessKey(value: string): string {
  const key = value.replace(/\D/g, '')
  if (!ACCESS_KEY.test(key)) throw new PurchaseImportError('INVALID_ACCESS_KEY', 'A chave da NF-e deve conter 44 dígitos.', 400)
  const body = key.slice(0, 43)
  let weight = 2
  let sum = 0
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * weight
    weight = weight === 9 ? 2 : weight + 1
  }
  const remainder = sum % 11
  const digit = remainder === 0 || remainder === 1 ? 0 : 11 - remainder
  if (digit !== Number(key[43])) throw new PurchaseImportError('INVALID_ACCESS_KEY', 'O dígito verificador da chave da NF-e é inválido.', 400)
  return key
}

function allowedHostname(hostname: string, allowedHosts: string[]): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return allowedHosts.some((host) => normalized === host || normalized.endsWith(`.${host}`))
}

export function accessKeyFromQrUrl(value: string, allowedHosts: string[]): string {
  let url: URL
  try { url = new URL(value) } catch { throw new PurchaseImportError('INVALID_QR_URL', 'URL do QR Code inválida.', 400) }
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHostname(url.hostname, allowedHosts)) {
    throw new PurchaseImportError('QR_URL_NOT_ALLOWED', 'O domínio do QR Code não é permitido.', 400)
  }
  const candidates = [url.searchParams.get('p')?.split('|')[0], url.searchParams.get('chNFe'), url.searchParams.get('chave'), url.pathname]
  for (const candidate of candidates) {
    const match = candidate?.match(/\d{44}/)?.[0]
    if (match) return normalizeAccessKey(match)
  }
  throw new PurchaseImportError('ACCESS_KEY_NOT_FOUND', 'Não foi possível extrair a chave da NF-e desta URL.', 400)
}

const finiteNonNegative = (value: unknown, field: string): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 0) throw new PurchaseImportError('INVALID_PROVIDER_RESPONSE', `Valor inválido em ${field}.`, 502)
  return number
}

const optionalText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function normalizeProviderDocument(payload: unknown, expectedKey: string, provider: string): NormalizedNfe {
  const source = record(payload)
  const supplier = record(source.supplier)
  const totals = record(source.totals)
  const accessKey = normalizeAccessKey(String(source.accessKey ?? expectedKey))
  if (accessKey !== expectedKey) throw new PurchaseImportError('PROVIDER_KEY_MISMATCH', 'O provider retornou uma NF-e diferente da solicitada.', 502)
  if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > 1000) {
    throw new PurchaseImportError('INVALID_PROVIDER_RESPONSE', 'O provider não retornou itens válidos.', 502)
  }
  const items = source.items.map((raw, index): NormalizedNfeItem => {
    const item = record(raw)
    const quantity = finiteNonNegative(item.quantity, `items[${index}].quantity`)
    const description = optionalText(item.description)
    const lineNumber = Number(item.lineNumber ?? index + 1)
    if (!description || !quantity || !Number.isInteger(lineNumber) || lineNumber <= 0) {
      throw new PurchaseImportError('INVALID_PROVIDER_RESPONSE', `Item ${index + 1} inválido.`, 502)
    }
    return {
      lineNumber, description, quantity,
      supplierProductCode: optionalText(item.supplierProductCode), barcode: optionalText(item.barcode),
      ncm: optionalText(item.ncm), cfop: optionalText(item.cfop), unit: optionalText(item.unit),
      unitPrice: finiteNonNegative(item.unitPrice, `items[${index}].unitPrice`),
      grossAmount: finiteNonNegative(item.grossAmount, `items[${index}].grossAmount`),
      discountAmount: finiteNonNegative(item.discountAmount, `items[${index}].discountAmount`),
      freightAmount: finiteNonNegative(item.freightAmount, `items[${index}].freightAmount`),
      otherAmount: finiteNonNegative(item.otherAmount, `items[${index}].otherAmount`),
      netAmount: finiteNonNegative(item.netAmount, `items[${index}].netAmount`),
    }
  })
  if (new Set(items.map((item) => item.lineNumber)).size !== items.length) {
    throw new PurchaseImportError('INVALID_PROVIDER_RESPONSE', 'O provider retornou números de item duplicados.', 502)
  }
  const issuedAt = optionalText(source.issuedAt)
  if (issuedAt && Number.isNaN(Date.parse(issuedAt))) throw new PurchaseImportError('INVALID_PROVIDER_RESPONSE', 'Data de emissão inválida.', 502)
  return {
    provider, accessKey, invoiceNumber: optionalText(source.invoiceNumber), series: optionalText(source.series), issuedAt,
    supplier: { name: optionalText(supplier.name), document: optionalText(supplier.document) },
    totals: {
      productsAmount: finiteNonNegative(totals.productsAmount, 'totals.productsAmount'),
      freightAmount: finiteNonNegative(totals.freightAmount, 'totals.freightAmount'),
      discountAmount: finiteNonNegative(totals.discountAmount, 'totals.discountAmount'),
      otherAmount: finiteNonNegative(totals.otherAmount, 'totals.otherAmount'),
      totalAmount: finiteNonNegative(totals.totalAmount, 'totals.totalAmount'),
    }, items,
  }
}

export function parseImportRequest(input: unknown) {
  const body = record(input)
  const marketAccountId = String(body.marketAccountId ?? '')
  const destinationStoreId = String(body.destinationStoreId ?? '')
  const sourceType = body.sourceType
  const sourceValue = typeof body.sourceValue === 'string' ? body.sourceValue.trim() : ''
  const mode: PurchaseImportMode = body.mode === 'reimport' ? 'reimport' : 'import'
  if (!UUID.test(marketAccountId) || !UUID.test(destinationStoreId) || !sourceValue || (sourceType !== 'qrcode_url' && sourceType !== 'access_key')) {
    throw new PurchaseImportError('INVALID_REQUEST', 'Dados de importação inválidos.', 400)
  }
  return { marketAccountId, destinationStoreId, sourceType: sourceType as PurchaseImportSourceType, sourceValue, mode }
}
