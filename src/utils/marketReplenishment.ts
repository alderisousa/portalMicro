import type { MarketStore } from '../types/market'
import type {
  MarketReplenishmentCandidate, MarketReplenishmentStoreGroup, MarketReplenishmentTriggerReason,
} from '../types/marketReplenishment'

// Nunca mostrar o código técnico ao operador — sempre passar por aqui antes
// de renderizar um trigger_reason. Mesmos 5 códigos aceitos pelo check
// constraint de market_replenishment_candidates (202609100014).
const triggerReasonLabels: Record<MarketReplenishmentTriggerReason, string> = {
  STOCKOUT: 'Sem estoque',
  BELOW_MINIMUM: 'Abaixo do mínimo',
  LOW_COVERAGE: 'Cobertura baixa',
  SALES_ACCELERATION: 'Vendas acelerando',
  ESSENTIAL_NO_RECENT_SALES: 'Essencial sem venda recente',
}

export function translateReplenishmentTriggerReason(reason: MarketReplenishmentTriggerReason): string {
  return triggerReasonLabels[reason] ?? reason
}

interface LevelCounts { criticalCount: number; highCount: number; mediumCount: number; lowCount: number }

function countByLevel(candidates: MarketReplenishmentCandidate[]): LevelCounts {
  return candidates.reduce<LevelCounts>((counts, candidate) => {
    if (candidate.priorityLevel === 'critical') counts.criticalCount += 1
    else if (candidate.priorityLevel === 'high') counts.highCount += 1
    else if (candidate.priorityLevel === 'medium') counts.mediumCount += 1
    else counts.lowCount += 1
    return counts
  }, { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 })
}

// Agrupa os candidatos do último run por loja e ordena lojas por necessidade
// de atenção — sem inventar nenhum algoritmo novo de prioridade: usa só as
// contagens critical/high/medium/low já persistidas por candidato
// (priority_level, calculado inteiramente pela RPC). Critério determinístico:
// mais críticos primeiro, depois mais altos, médios, baixos, e por fim nome
// da loja (desempate estável, nunca depende da ordem de chegada dos dados).
// Galpão (store_type='warehouse') nunca é incluído: não é loja de destino de
// reposição.
export function groupReplenishmentCandidatesByStore(
  candidates: MarketReplenishmentCandidate[],
  stores: Pick<MarketStore, 'id' | 'name' | 'store_type'>[],
): MarketReplenishmentStoreGroup[] {
  const operationalStores = new Map(stores.filter((store) => store.store_type === 'store').map((store) => [store.id, store.name]))
  const byStore = new Map<string, MarketReplenishmentCandidate[]>()
  for (const candidate of candidates) {
    if (!operationalStores.has(candidate.storeId)) continue
    const list = byStore.get(candidate.storeId)
    if (list) list.push(candidate)
    else byStore.set(candidate.storeId, [candidate])
  }

  const groups: MarketReplenishmentStoreGroup[] = []
  for (const [storeId, storeName] of operationalStores) {
    const storeCandidates = (byStore.get(storeId) ?? []).slice().sort((a, b) => a.rankPosition - b.rankPosition)
    if (!storeCandidates.length) continue
    const counts = countByLevel(storeCandidates)
    groups.push({ storeId, storeName, ...counts, candidates: storeCandidates })
  }

  return groups.sort((a, b) =>
    b.criticalCount - a.criticalCount
    || b.highCount - a.highCount
    || b.mediumCount - a.mediumCount
    || b.lowCount - a.lowCount
    || a.storeName.localeCompare(b.storeName, 'pt-BR'))
}
