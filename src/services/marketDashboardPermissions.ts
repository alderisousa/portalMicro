import type { MarketMemberRole } from '../types/market'

export const canViewMarketCommercialData = (role: MarketMemberRole) => role !== 'operator'

export const canAccessMarketSalesImports = (
  role: MarketMemberRole,
  integrationAvailable: boolean | null = false,
) => !integrationAvailable && integrationAvailable !== null &&
  (role === 'owner' || role === 'admin' || role === 'manager')
