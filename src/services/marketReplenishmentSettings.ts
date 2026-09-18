import { supabase } from '../lib/supabase'

export const replenishmentSettingsFields = [
  { key: 'normal_list_limit', label: 'Quantidade máxima de sugestões', min: 20, max: 200, step: 1, unit: 'sugestões', help: 'Limita a quantidade normal de sugestões por loja. Itens críticos podem ultrapassar esse limite por uma proteção interna.' },
  { key: 'coverage_target_days', label: 'Cobertura desejada de estoque', min: 3, max: 30, step: 0.01, unit: 'dias', help: 'Define por quantos dias o estoque deve atender às vendas previstas. Uma cobertura maior pode aumentar a quantidade sugerida para reposição.' },
  { key: 'acceleration_threshold_pct', label: 'Sensibilidade à aceleração de vendas', min: 10, max: 100, step: 0.01, unit: '%', help: 'Define o aumento percentual das vendas necessário para sinalizar aceleração. Um valor menor torna o alerta mais sensível.' },
  { key: 'essential_no_sale_days', label: 'Alerta de essencial sem venda', min: 3, max: 30, step: 1, unit: 'dias', help: 'Define após quantos dias sem venda um produto essencial deve receber atenção. Ajuda a identificar possíveis faltas mesmo sem vendas recentes.' },
] as const

export type ReplenishmentSettingsValues = Record<typeof replenishmentSettingsFields[number]['key'], number>
export type ReplenishmentSettings = ReplenishmentSettingsValues & { id: string | null }
const columns = 'id,normal_list_limit,coverage_target_days,acceleration_threshold_pct,essential_no_sale_days'
const defaults: ReplenishmentSettings = { id: null, normal_list_limit: 100, coverage_target_days: 7, acceleration_threshold_pct: 30, essential_no_sale_days: 7 }

export function validateReplenishmentSettings(values: ReplenishmentSettingsValues): void {
  for (const field of replenishmentSettingsFields) {
    const value = values[field.key]
    if (!Number.isFinite(value) || value < field.min || value > field.max
      || (field.step === 1 ? !Number.isInteger(value) : Math.abs(value * 100 - Math.round(value * 100)) > 0.000001)) {
      throw new Error(`${field.label}: informe um valor de ${field.min} a ${field.max}${field.step === 1 ? ', em números inteiros' : ', com até duas casas decimais'}.`)
    }
  }
}

export async function getMarketReplenishmentSettings(accountId: string): Promise<ReplenishmentSettings> {
  const { data, error } = await supabase.from('market_replenishment_settings').select(columns)
    .eq('market_account_id', accountId).is('store_id', null).maybeSingle()
  if (error) throw error
  return data ?? { ...defaults }
}

export async function saveMarketReplenishmentSettings(accountId: string, id: string | null, values: ReplenishmentSettingsValues): Promise<ReplenishmentSettings> {
  validateReplenishmentSettings(values)
  // Lista explícita: nenhum parâmetro interno entra na escrita.
  const payload = {
    normal_list_limit: values.normal_list_limit,
    coverage_target_days: values.coverage_target_days,
    acceleration_threshold_pct: values.acceleration_threshold_pct,
    essential_no_sale_days: values.essential_no_sale_days,
  }
  const table = supabase.from('market_replenishment_settings')
  const query = id
    ? table.update({ ...payload, updated_at: new Date().toISOString() }).eq('id', id).eq('market_account_id', accountId).is('store_id', null)
    : table.insert({ ...payload, market_account_id: accountId, store_id: null })
  const { data, error } = await query.select(columns).single()
  if (error) throw error
  return data
}
