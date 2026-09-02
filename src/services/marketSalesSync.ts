import { supabase } from '../lib/supabase'
import type { MarketSalesSyncResult } from '../types/marketIntegration'
import type { MarketSalesSyncStatus } from '../types/marketSalesSync'
import { marketSalesRefreshRequest, marketSalesStatusRequest } from './marketSalesSyncContract'

const messages: Record<string, string> = {
  UNAUTHORIZED: 'Sua sessão expirou. Entre novamente para continuar.',
  FORBIDDEN: 'Seu perfil não permite atualizar as vendas desta conta.',
  MARKET_ACCOUNT_NOT_FOUND: 'A conta Market está indisponível.',
  MARKET_ADMIN_FIELDS_NOT_ALLOWED: 'A solicitação contém campos que não são permitidos no modo Market.',
  SYNC_INTEGRATION_NOT_CONFIGURED: 'A integração de vendas ainda não está configurada.',
  SYNC_INTEGRATION_AMBIGUOUS: 'Há mais de uma integração de vendas ativa. Solicite a revisão da configuração.',
  SYNC_ALREADY_RUNNING: 'Já existe uma atualização de vendas em andamento.',
  SYNC_RUN_LOST: 'A atualização perdeu a posse da execução. Consulte o status novamente.',
  CREDENTIALS_NOT_CONFIGURED: 'As credenciais da integração ainda não estão configuradas.',
  CREDENTIALS_UNAVAILABLE: 'As credenciais da integração não puderam ser utilizadas.',
  PROVIDER_UNAVAILABLE: 'A Accesys está temporariamente indisponível.',
  PROVIDER_TIMEOUT: 'A Accesys não respondeu no prazo esperado.',
  AUTHENTICATION_FAILED: 'A autenticação da integração falhou. Solicite a revisão das credenciais.',
  INTERNAL_ERROR: 'Não foi possível concluir a operação de vendas.',
}

export class MarketSalesSyncError extends Error {
  constructor(readonly code: string) {
    super(messages[code] ?? 'Não foi possível concluir a operação de vendas.')
  }
}

const parseFunctionError = async (error: unknown): Promise<never> => {
  let code = 'INTERNAL_ERROR'
  if (error && typeof error === 'object' && 'context' in error) {
    const context = (error as { context?: unknown }).context
    if (context instanceof Response) {
      const payload = await context.clone().json().catch(() => null) as { error?: { code?: unknown } } | null
      if (typeof payload?.error?.code === 'string') code = payload.error.code
    }
  }
  throw new MarketSalesSyncError(code)
}

const invoke = async (body: { action: 'refresh' | 'status'; marketAccountId: string }) => {
  const { data, error } = await supabase.functions.invoke('market-sales-sync', { body })
  if (error) return parseFunctionError(error)
  if (!data || typeof data !== 'object') throw new MarketSalesSyncError('INTERNAL_ERROR')
  return data as Record<string, unknown>
}

export async function refreshMarketSales(marketAccountId: string) {
  return invoke(marketSalesRefreshRequest(marketAccountId)) as Promise<unknown> as Promise<MarketSalesSyncResult>
}

export async function getMarketSalesSyncStatus(marketAccountId: string) {
  const data = await invoke(marketSalesStatusRequest(marketAccountId))
  return (data.sync ?? null) as MarketSalesSyncStatus | null
}
