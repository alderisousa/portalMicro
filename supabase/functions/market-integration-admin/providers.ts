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

export const testAccesysConnection = async (
  configuration: ProviderConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<ProviderTestResult> => {
  const baseUrl = normalizeAndValidateProviderUrl('accesys', configuration.baseUrl)
  const loginResponse = await providerFetch(fetcher, `${baseUrl}/oar/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: configuration.username, password: configuration.password }),
  })

  if (loginResponse.status === 401 || loginResponse.status === 403) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'Usuário ou senha rejeitados pelo provider.', 422)
  }
  if (!loginResponse.ok) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'O provider recusou a autenticação.', 502)
  }
  const token = await readToken(loginResponse)
  if (!token) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'Resposta de autenticação inválida.', 422)
  }

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
