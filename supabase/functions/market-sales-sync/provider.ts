import {
  normalizeAndValidateProviderUrl,
  providerFetch,
  ProviderError,
  type ProviderConfiguration,
} from '../market-integration-admin/providers.ts'

export interface AccesysOrdersProvider {
  fetchOrdersPage(input: {
    startDate: string
    endDate: string
    page: number
    pageSize: number
  }): Promise<unknown>
}

export async function createAccesysOrdersProvider(
  configuration: ProviderConfiguration,
  fetcher: typeof fetch = fetch,
): Promise<AccesysOrdersProvider> {
  const baseUrl = normalizeAndValidateProviderUrl('accesys', configuration.baseUrl)
  const loginResponse = await providerFetch(fetcher, `${baseUrl}/oar/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: configuration.username, password: configuration.password }),
  })
  if (loginResponse.status === 401 || loginResponse.status === 403) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'Usuario ou senha rejeitados pelo provider.', 422)
  }
  if (!loginResponse.ok) {
    throw new ProviderError('PROVIDER_UNAVAILABLE', 'O provider recusou a autenticacao.', 502)
  }
  const loginPayload = await loginResponse.json().catch(() => null) as Record<string, unknown> | null
  const tokenCandidate = loginPayload?.token ?? loginPayload?.accessToken ?? loginPayload?.access_token
  if (typeof tokenCandidate !== 'string' || !tokenCandidate) {
    throw new ProviderError('AUTHENTICATION_FAILED', 'Resposta de autenticacao invalida.', 422)
  }
  const externalCompanyId = configuration.externalCompanyId

  return {
    async fetchOrdersPage(input) {
      const url = new URL('/oar/sites/orders/search/complete', baseUrl)
      url.searchParams.set('companyId', externalCompanyId)
      url.searchParams.set('startDate', `${input.startDate} 00:00:00`)
      url.searchParams.set('endDate', `${input.endDate} 23:59:59`)
      url.searchParams.set('pageSize', String(input.pageSize))
      url.searchParams.set('page', String(input.page))
      const response = await providerFetch(fetcher, url.toString(), {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenCandidate}`, Accept: 'application/json' },
      })
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('AUTHENTICATION_FAILED', 'A sessao do provider nao foi aceita.', 422)
      }
      if (!response.ok) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'Nao foi possivel consultar as vendas no provider.', 502)
      }
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'Resposta de vendas invalida.', 502)
      }
      return payload
    },
  }
}
