export type ProviderConfiguration = {
  provider: string
  baseUrl: string
  externalCompanyId: string
  username: string
  password: string
}

export type ProviderTestResult = {
  succeeded: true
}

export type ProductCatalogPreview = {
  providerHttpStatus: number
  rootType: 'object' | 'array'
  rootKeys: string[]
  collectionKey: string | null
  returnedCount: number
  productKeys: string[]
  paginationMetadata: Record<string, unknown>
  products: unknown[]
  requestedPage: number
  pageSize: number
}

export type AccesysProductPage = {
  records: number
  page: number
  pages: number
  items: Record<string, unknown>[]
}

export class ProviderError extends Error {
  readonly code: 'INVALID_PROVIDER' | 'INVALID_PROVIDER_URL' | 'AUTHENTICATION_FAILED' |
    'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT'
  readonly status: number

  constructor(
    code: 'INVALID_PROVIDER' | 'INVALID_PROVIDER_URL' | 'AUTHENTICATION_FAILED' |
      'PROVIDER_UNAVAILABLE' | 'PROVIDER_TIMEOUT',
    message: string,
    status: number,
  ) {
    super(message)
    this.code = code
    this.status = status
  }
}

const ACCESYS_HOST = 'apigateway.accesyslab.com.br'
const REQUEST_TIMEOUT_MS = 10_000

export const normalizeAndValidateProviderUrl = (provider: string, value: string) => {
  if (provider !== 'accesys') {
    throw new ProviderError('INVALID_PROVIDER', 'Provider não suportado.', 400)
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ProviderError('INVALID_PROVIDER_URL', 'URL do provider inválida.', 400)
  }

  if (
    url.protocol !== 'https:' || url.hostname !== ACCESYS_HOST || url.port ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new ProviderError('INVALID_PROVIDER_URL', 'URL não permitida para o provider.', 400)
  }
  return `https://${ACCESYS_HOST}`
}

export const providerFetch = async (
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProviderError('PROVIDER_TIMEOUT', 'O provider não respondeu no prazo esperado.', 504)
    }
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Não foi possível acessar o provider.', 502)
  } finally {
    clearTimeout(timeout)
  }
}

const readToken = async (response: Response) => {
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  const candidates = [payload?.token, payload?.accessToken, payload?.access_token]
  const token = candidates.find((value) => typeof value === 'string' && value.length > 0)
  return typeof token === 'string' ? token : null
}

const sensitiveKey = /token|password|secret|authorization|ciphertext|credential/i
const paginationKey = /page|size|total|record|count|next|previous|first|last/i

const sanitizedProviderValue = (value: unknown, depth = 0): unknown => {
  if (depth > 8) return '[depth limited]'
  if (Array.isArray(value)) return value.map((entry) => sanitizedProviderValue(entry, depth + 1))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    sensitiveKey.test(key) ? '[redacted]' : sanitizedProviderValue(entry, depth + 1),
  ]))
}

const authenticateAccesys = async (
  configuration: ProviderConfiguration,
  fetcher: typeof fetch,
) => {
  const baseUrl = normalizeAndValidateProviderUrl('accesys', configuration.baseUrl)
  const loginResponse = await providerFetch(fetcher, `${baseUrl}/oar/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: configuration.username, password: configuration.password }),
  })
  if (loginResponse.status === 401 || loginResponse.status === 403) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'Usuário ou senha rejeitados pelo provider.', 422)
  }
  if (!loginResponse.ok) throw new ProviderError('PROVIDER_UNAVAILABLE', 'O provider recusou a autenticação.', 502)
  const token = await readToken(loginResponse)
  if (!token) throw new ProviderError('AUTHENTICATION_FAILED', 'Resposta de autenticação inválida.', 422)
  return { baseUrl, token }
}

export const fetchAccesysProductPage = async (
  configuration: ProviderConfiguration,
  page: number,
  pageSize: number,
  fetcher: typeof fetch = fetch,
): Promise<{ httpStatus: number; catalog: AccesysProductPage }> => {
  const { baseUrl, token } = await authenticateAccesys(configuration, fetcher)
  const productsUrl = new URL('/oar/sites/products/search', baseUrl)
  productsUrl.searchParams.set('companyId', configuration.externalCompanyId)
  productsUrl.searchParams.set('pageSize', String(pageSize))
  productsUrl.searchParams.set('page', String(page))
  const response = await providerFetch(fetcher, productsUrl.toString(), {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'A sessÃ£o do provider nÃ£o foi aceita.', 422)
  }
  if (!response.ok) throw new ProviderError('PROVIDER_UNAVAILABLE', 'A Accesys recusou a consulta de produtos.', 502)
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!payload || !Number.isInteger(payload.records) || !Number.isInteger(payload.page) ||
    !Number.isInteger(payload.pages) || !Array.isArray(payload.items) || payload.page !== page ||
    (payload.pages as number) < 0 || page < 1 || (payload.pages as number) > 0 && page > (payload.pages as number)) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Resposta de catÃ¡logo invÃ¡lida.', 502)
  }
  const items = payload.items.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === 'object' && !Array.isArray(item))
  if (items.length !== payload.items.length) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Resposta de catÃ¡logo invÃ¡lida.', 502)
  }
  return { httpStatus: response.status, catalog: {
    records: payload.records as number, page: payload.page as number,
    pages: payload.pages as number, items,
  } }
}

export const previewAccesysProducts = async (
  configuration: ProviderConfiguration,
  page: number,
  pageSize: number,
  fetcher: typeof fetch = fetch,
): Promise<ProductCatalogPreview> => {
  const { baseUrl, token } = await authenticateAccesys(configuration, fetcher)
  const productsUrl = new URL('/oar/sites/products/search', baseUrl)
  productsUrl.searchParams.set('companyId', configuration.externalCompanyId)
  productsUrl.searchParams.set('pageSize', String(pageSize))
  productsUrl.searchParams.set('page', String(page))
  const response = await providerFetch(fetcher, productsUrl.toString(), {
    method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  if (response.status === 401 || response.status === 403) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'A sessão do provider não foi aceita.', 422)
  }
  if (!response.ok) throw new ProviderError('PROVIDER_UNAVAILABLE', 'A Accesys recusou a consulta de produtos.', 502)
  const payload = await response.json().catch(() => undefined)
  if (!payload || (typeof payload !== 'object')) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Resposta de catálogo inválida.', 502)
  }

  const rootType = Array.isArray(payload) ? 'array' : 'object'
  const root = rootType === 'object' ? payload as Record<string, unknown> : null
  const rootKeys = root ? Object.keys(root) : []
  const preferredCollections = ['content', 'items', 'data', 'results', 'products']
  const collectionKey = root
    ? preferredCollections.find((key) => Array.isArray(root[key])) ?? rootKeys.find((key) => Array.isArray(root[key])) ?? null
    : null
  const records = Array.isArray(payload) ? payload : collectionKey ? root![collectionKey] as unknown[] : []
  const products = records.slice(0, 2).map((product) => sanitizedProviderValue(product))
  const productKeys = [...new Set(records.slice(0, 5).flatMap((product) =>
    product && typeof product === 'object' && !Array.isArray(product) ? Object.keys(product) : []
  ))]
  const paginationMetadata = root ? Object.fromEntries(
    Object.entries(root)
      .filter(([key, value]) => key !== collectionKey && paginationKey.test(key) && !Array.isArray(value))
      .map(([key, value]) => [key, sanitizedProviderValue(value)]),
  ) : {}

  return {
    providerHttpStatus: response.status,
    rootType,
    rootKeys,
    collectionKey,
    returnedCount: records.length,
    productKeys,
    paginationMetadata,
    products,
    requestedPage: page,
    pageSize,
  }
}

export const testAccesysConnection = async (
  configuration: ProviderConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> => {
  const { baseUrl, token } = await authenticateAccesys(configuration, fetcher)

  const productsUrl = new URL('/oar/sites/products/search', baseUrl)
  productsUrl.searchParams.set('companyId', configuration.externalCompanyId)
  productsUrl.searchParams.set('pageSize', '1')
  productsUrl.searchParams.set('page', '1')
  const validationResponse = await providerFetch(fetcher, productsUrl.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  if (validationResponse.status === 401 || validationResponse.status === 403) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'A sessão do provider não foi aceita.', 422)
  }
  if (!validationResponse.ok) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Empresa indisponível ou rejeitada pelo provider.', 502)
  }
  const payload = await validationResponse.json().catch(() => undefined)
  if (payload === undefined || payload === null || typeof payload !== 'object') {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'Resposta de validação inválida.', 502)
  }
  return { succeeded: true }
}

export const testProviderConnection = (
  configuration: ProviderConfiguration,
  fetcher: typeof fetch = fetch,
) => {
  if (configuration.provider === 'accesys') {
    return testAccesysConnection(configuration, fetcher)
  }
  throw new ProviderError('INVALID_PROVIDER', 'Provider não suportado.', 400)
}
