export type MarketIntegrationStatus = 'active' | 'inactive'

export interface MarketIntegrationConfiguration {
  id: string
  marketAccountId: string
  provider: 'accesys'
  baseUrl: string
  externalCompanyId: string
  username: string | null
  status: MarketIntegrationStatus | 'error'
  lastTestAt: string | null
  lastTestSucceeded: boolean | null
  lastTestError: string | null
  hasCredentials: boolean
}

export interface SaveMarketIntegrationInput {
  marketAccountId: string
  integrationId?: string
  externalCompanyId: string
  username: string
  password?: string
  status: MarketIntegrationStatus
}
