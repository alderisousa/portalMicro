import type { MarketMemberRole } from '../types/market'

export const canRefreshMarketSales = (role: MarketMemberRole) =>
  role === 'owner' || role === 'admin' || role === 'manager'

const syncStatusLabels: Record<string, string> = {
  completed: 'Concluída',
  partial: 'Concluída parcialmente',
  failed: 'Falhou',
  running: 'Em andamento',
}

export const formatMarketSalesSyncStatus = (status: unknown) =>
  typeof status === 'string' ? syncStatusLabels[status] ?? 'Desconhecido' : 'Desconhecido'

export const marketSalesRefreshRequest = (marketAccountId: string) => ({
  action: 'refresh' as const,
  marketAccountId,
})

export const marketSalesStatusRequest = (marketAccountId: string) => ({
  action: 'status' as const,
  marketAccountId,
})
