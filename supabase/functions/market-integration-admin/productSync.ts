export type AccesysCatalogItem = Record<string, unknown>

export type MappedAccesysProduct = {
  externalProductId: string
  externalSku: string | null
  validGtin: string | null
  description: string | null
  unit: string | null
  externalInactive: boolean
}

const textValue = (value: unknown) => {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized || null
}

export const normalizeGtinCandidate = (value: unknown) => {
  const normalized = textValue(value)?.replace(/[\s.-]/g, '') ?? null
  return normalized && /^\d+$/.test(normalized) ? normalized : null
}

export const isValidGtin = (value: string | null) => {
  if (!value || ![8, 12, 13, 14].includes(value.length) || !/^\d+$/.test(value)) return false
  const check = Number(value.at(-1))
  let sum = 0
  let position = 0
  for (let index = value.length - 2; index >= 0; index -= 1) {
    sum += Number(value[index]) * (position % 2 === 0 ? 3 : 1)
    position += 1
  }
  return (10 - (sum % 10)) % 10 === check
}

export const mapAccesysProduct = (item: AccesysCatalogItem): MappedAccesysProduct | null => {
  const externalProductId = textValue(item.id)
  if (!externalProductId) return null
  const externalSku = textValue(item.sku)
  const gtinCandidate = normalizeGtinCandidate(externalSku)
  return {
    externalProductId,
    externalSku,
    validGtin: isValidGtin(gtinCandidate) ? gtinCandidate : null,
    description: textValue(item.description),
    unit: textValue(item.unity),
    externalInactive: item.isInactive === true || item.isInactiveProduct === true,
  }
}

export type ProductSyncRun = {
  id: string
  marketAccountId: string
  integrationId: string
  status: 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'
  currentPage: number
  totalPages: number | null
  pageSize: number
  receivedCount: number
  createdCount: number
  updatedCount: number
  unchangedCount: number
  ignoredCount: number
  errorCode: string | null
  errorMessage: string | null
  startedAt: string
  heartbeatAt: string | null
  finishedAt: string | null
}

export const mapProductSyncRun = (row: Record<string, unknown>): ProductSyncRun => ({
  id: String(row.id), marketAccountId: String(row.market_account_id), integrationId: String(row.integration_id),
  status: row.status as ProductSyncRun['status'], currentPage: Number(row.current_page),
  totalPages: row.total_pages === null ? null : Number(row.total_pages), pageSize: Number(row.page_size),
  receivedCount: Number(row.received_count), createdCount: Number(row.created_count),
  updatedCount: Number(row.updated_count), unchangedCount: Number(row.unchanged_count),
  ignoredCount: Number(row.ignored_count), errorCode: row.error_code as string | null,
  errorMessage: row.error_message as string | null, startedAt: String(row.started_at),
  heartbeatAt: row.heartbeat_at as string | null, finishedAt: row.finished_at as string | null,
})
