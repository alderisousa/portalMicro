// Leitura read-only dos resultados já persistidos pelo batch de Reposição
// Inteligente (market_run_replenishment_batch, migrations 202609100001-015).
// Esta tela NUNCA recalcula regra, score ou prioridade — só apresenta o que
// já está gravado em market_replenishment_runs/market_replenishment_candidates.

export type MarketReplenishmentPriorityLevel = 'critical' | 'high' | 'medium' | 'low'

// Mesmos 5 códigos aceitos pelo check constraint de trigger_reasons em
// market_replenishment_candidates (202609100014: BELOW_MINIMUM substituiu
// ESSENTIAL_BELOW_MINIMUM).
export type MarketReplenishmentTriggerReason =
  | 'STOCKOUT'
  | 'BELOW_MINIMUM'
  | 'LOW_COVERAGE'
  | 'SALES_ACCELERATION'
  | 'ESSENTIAL_NO_RECENT_SALES'

// Cabeçalho do último run efetivo (market_replenishment_runs). Campos
// suficientes para o resumo compacto da tela — não inclui tudo que a tabela
// tem (ex.: algorithm_version, error_code) porque esta tela não precisa disso.
export interface MarketReplenishmentRunSummary {
  id: string
  referenceDate: string
  finishedAt: string | null
  storesProcessed: number
  productsSelected: number
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
}

// Um candidato persistido (market_replenishment_candidates) já com o nome do
// produto resolvido (join local via market_products, ver serviço). Todo
// campo nullable aqui É nullable na tabela de origem e permanece null —
// nunca convertido em zero só para caber no tipo.
export interface MarketReplenishmentCandidate {
  id: string
  storeId: string
  productId: string
  productName: string
  currentStock: number | null
  minimumStock: number | null
  coverageDays: number | null
  avgDailyM7: number | null
  suggestedQuantity: number | null
  warehouseStock: number | null
  triggerReasons: MarketReplenishmentTriggerReason[]
  priorityScore: number
  priorityLevel: MarketReplenishmentPriorityLevel
  rankPosition: number
}

// Candidatos de uma loja operacional, já ordenados por rankPosition (a mesma
// ordem persistida pelo batch — nenhum reordenamento de prioridade aqui).
// critical/high/medium/low são só a contagem dos candidatos abaixo, usada
// tanto para o resumo do card quanto para ordenar as lojas entre si.
export interface MarketReplenishmentStoreGroup {
  storeId: string
  storeName: string
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  candidates: MarketReplenishmentCandidate[]
}

// run null = nenhum run completed+is_effective encontrado para o Market
// ainda (ex.: batch nunca rodou). stores já vem filtrado a lojas
// store_type='store' e ordenado por necessidade de atenção.
export interface MarketReplenishmentOverview {
  run: MarketReplenishmentRunSummary | null
  stores: MarketReplenishmentStoreGroup[]
}
