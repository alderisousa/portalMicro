import {
  bytesToPostgresBytea,
  decryptPassword,
  encryptPassword,
  postgresByteaToBytes,
} from './crypto.ts'
import {
  normalizeAndValidateProviderUrl,
  ProviderError,
  testProviderConnection,
  type ProviderConfiguration,
} from './providers.ts'

export type Integration = {
  id: string
  market_account_id: string
  provider: string
  base_url: string
  external_company_id: string
  status: 'inactive' | 'active' | 'error'
  last_test_at: string | null
  last_test_succeeded: boolean | null
  last_test_error: string | null
}

export type Credential = {
  username: string
  password_ciphertext: string
}

export interface IntegrationRepository {
  isGlobalAdmin(userId: string): Promise<boolean>
  marketAccountExists(marketAccountId: string): Promise<boolean>
  getIntegration(marketAccountId: string, integrationId: string): Promise<Integration | null>
  createIntegration(input: Omit<Integration, 'id' | 'last_test_at' | 'last_test_succeeded' | 'last_test_error'>): Promise<Integration>
  updateIntegration(marketAccountId: string, integrationId: string, input: Partial<Integration>): Promise<Integration>
  getCredential(marketAccountId: string, integrationId: string): Promise<Credential | null>
  saveCredential(input: {
    marketAccountId: string
    integrationId: string
    username: string
    passwordCiphertext?: string
  }): Promise<void>
  updateTestResult(marketAccountId: string, integrationId: string, input: {
    testedAt: string
    succeeded: boolean
    error: string | null
  }): Promise<void>
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const asObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('INVALID_REQUEST', 'Corpo da requisição inválido.', 400)
  }
  return value as Record<string, unknown>
}
const requiredString = (body: Record<string, unknown>, name: string) => {
  const value = body[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError('INVALID_REQUEST', `Campo ${name} inválido.`, 400)
  }
  return value.trim()
}
const requiredUuid = (body: Record<string, unknown>, name: string) => {
  const value = requiredString(body, name)
  if (!UUID.test(value)) throw new ApiError('INVALID_REQUEST', `Campo ${name} inválido.`, 400)
  return value
}

const publicIntegration = (integration: Integration, credential: Credential | null) => ({
  id: integration.id,
  marketAccountId: integration.market_account_id,
  provider: integration.provider,
  baseUrl: integration.base_url,
  externalCompanyId: integration.external_company_id,
  username: credential?.username ?? null,
  status: integration.status,
  lastTestAt: integration.last_test_at,
  lastTestSucceeded: integration.last_test_succeeded,
  lastTestError: integration.last_test_error,
  hasCredentials: credential !== null,
})

const authorize = async (
  repository: IntegrationRepository,
  userId: string,
) => {
  if (!await repository.isGlobalAdmin(userId)) {
    throw new ApiError('FORBIDDEN', 'Apenas o Admin global pode administrar integrações.', 403)
  }
}

const loadIntegration = async (
  repository: IntegrationRepository,
  marketAccountId: string,
  integrationId: string,
) => {
  const integration = await repository.getIntegration(marketAccountId, integrationId)
  if (!integration) throw new ApiError('INTEGRATION_NOT_FOUND', 'Integração não encontrada.', 404)
  return integration
}

export type ActionDependencies = {
  repository: IntegrationRepository
  encryptionKey: string
  fetcher?: typeof fetch
  now?: () => Date
}

export const executeAction = async (
  userId: string,
  input: unknown,
  dependencies: ActionDependencies,
) => {
  const body = asObject(input)
  const action = requiredString(body, 'action')
  const marketAccountId = requiredUuid(body, 'marketAccountId')
  await authorize(dependencies.repository, userId)
  if (!await dependencies.repository.marketAccountExists(marketAccountId)) {
    throw new ApiError('MARKET_ACCOUNT_NOT_FOUND', 'Conta Market não encontrada ou indisponível.', 404)
  }

  if (action === 'get') {
    const integrationId = requiredUuid(body, 'integrationId')
    const integration = await loadIntegration(dependencies.repository, marketAccountId, integrationId)
    const credential = await dependencies.repository.getCredential(marketAccountId, integrationId)
    return { integration: publicIntegration(integration, credential) }
  }

  if (action === 'save') {
    const provider = requiredString(body, 'provider').toLowerCase()
    const baseUrl = normalizeAndValidateProviderUrl(provider, requiredString(body, 'baseUrl'))
    const externalCompanyId = requiredString(body, 'externalCompanyId')
    const username = requiredString(body, 'username')
    const requestedStatus = body.status
    if (requestedStatus !== undefined && requestedStatus !== 'inactive' && requestedStatus !== 'active') {
      throw new ApiError('INVALID_REQUEST', 'Status da integração inválido.', 400)
    }
    const passwordValue = body.password
    if (passwordValue !== undefined && (typeof passwordValue !== 'string' || !passwordValue)) {
      throw new ApiError('INVALID_REQUEST', 'A nova senha não pode ser vazia.', 400)
    }

    const rawIntegrationId = body.integrationId
    const integrationId = rawIntegrationId === undefined || rawIntegrationId === null
      ? null
      : requiredUuid(body, 'integrationId')
    const existingIntegration = integrationId
      ? await loadIntegration(dependencies.repository, marketAccountId, integrationId)
      : null
    const existingCredential = integrationId
      ? await dependencies.repository.getCredential(marketAccountId, integrationId)
      : null
    if (!existingCredential && passwordValue === undefined) {
      throw new ApiError('CREDENTIALS_NOT_CONFIGURED', 'Informe uma senha para configurar as credenciais.', 422)
    }

    // Valida o secret e cifra antes de qualquer escrita. Uma falha criptográfica
    // nunca deixa uma configuração parcialmente atualizada.
    const passwordCiphertext = typeof passwordValue === 'string'
      ? bytesToPostgresBytea(await encryptPassword(passwordValue, dependencies.encryptionKey))
      : undefined

    const configuration = existingIntegration
      ? await dependencies.repository.updateIntegration(marketAccountId, existingIntegration.id, {
        provider,
        base_url: baseUrl,
        external_company_id: externalCompanyId,
        status: requestedStatus ?? existingIntegration.status,
        last_test_at: null,
        last_test_succeeded: null,
        last_test_error: null,
      })
      : await dependencies.repository.createIntegration({
        market_account_id: marketAccountId,
        provider,
        base_url: baseUrl,
        external_company_id: externalCompanyId,
        status: requestedStatus ?? 'inactive',
      })

    await dependencies.repository.saveCredential({
      marketAccountId,
      integrationId: configuration.id,
      username,
      passwordCiphertext,
    })
    const credential = await dependencies.repository.getCredential(marketAccountId, configuration.id)
    return { integration: publicIntegration(configuration, credential) }
  }

  if (action === 'test') {
    const integrationId = requiredUuid(body, 'integrationId')
    const integration = await loadIntegration(dependencies.repository, marketAccountId, integrationId)
    const credential = await dependencies.repository.getCredential(marketAccountId, integrationId)
    if (!credential) {
      throw new ApiError('CREDENTIALS_NOT_CONFIGURED', 'Credenciais ainda não configuradas.', 422)
    }

    const testedAt = (dependencies.now ?? (() => new Date()))().toISOString()
    try {
      const password = await decryptPassword(
        postgresByteaToBytes(credential.password_ciphertext),
        dependencies.encryptionKey,
      )
      const providerConfiguration: ProviderConfiguration = {
        provider: integration.provider,
        baseUrl: integration.base_url,
        externalCompanyId: integration.external_company_id,
        username: credential.username,
        password,
      }
      await testProviderConnection(providerConfiguration, dependencies.fetcher)
      await dependencies.repository.updateTestResult(marketAccountId, integrationId, {
        testedAt,
        succeeded: true,
        error: null,
      })
      return { succeeded: true, testedAt }
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null
      const message = providerError?.message ?? 'Não foi possível testar a integração.'
      await dependencies.repository.updateTestResult(marketAccountId, integrationId, {
        testedAt,
        succeeded: false,
        error: message,
      })
      if (providerError) throw new ApiError(providerError.code, message, providerError.status)
      throw new ApiError('INTERNAL_ERROR', 'Não foi possível testar a integração.', 500)
    }
  }

  throw new ApiError('INVALID_REQUEST', 'Ação inválida.', 400)
}
