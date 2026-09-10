import { ArrowLeft, ChevronDown, PackageSearch, RefreshCw, Truck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getMarketReplenishmentOverview } from '../services/marketReplenishment'
import { translateReplenishmentTriggerReason } from '../utils/marketReplenishment'
import type { MarketStore } from '../types/market'
import type { MarketReplenishmentCandidate, MarketReplenishmentOverview } from '../types/marketReplenishment'

interface Props { accountId: string; stores: MarketStore[]; onBack: () => void }

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

const priorityLevelLabels: Record<MarketReplenishmentCandidate['priorityLevel'], string> = {
  critical: 'Crítico', high: 'Alto', medium: 'Médio', low: 'Baixo',
}

// NULL nunca é tratado como zero (esta tela só apresenta o que já está
// persistido em market_replenishment_candidates/market_replenishment_runs —
// nenhum recálculo aqui). Cada formatador só decide o texto de
// "desconhecido/não configurado"; zero verdadeiro sempre passa por
// number.format e aparece como 0.
const formatKnownStock = (value: number | null) => value === null ? 'Saldo não conhecido' : number.format(value)
const formatMinimumStock = (value: number | null) => value === null ? 'Não configurado' : number.format(value)
const formatCoverageDays = (value: number | null) => value === null ? '—' : `${number.format(value)} dias`
const formatSuggestedQuantity = (value: number | null) => value === null ? 'A definir' : number.format(value)
const formatWarehouseStock = (value: number | null) => value === null ? 'Saldo não conhecido' : number.format(value)
const formatAvgDailyM7 = (value: number | null) => value === null ? '—' : number.format(value)

export function MarketReplenishment({ accountId, stores, onBack }: Props) {
  const [overview, setOverview] = useState<MarketReplenishmentOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedStoreId, setExpandedStoreId] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void getMarketReplenishmentOverview(accountId, stores)
      .then((result) => { if (active) setOverview(result) })
      .catch((cause) => { console.error('Falha ao carregar Abastecimento:', cause); if (active) setError('Não foi possível carregar os dados de Abastecimento.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId, stores])

  if (loading) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando Abastecimento...</div>
  if (error) return <div className="admin-message is-error" role="alert"><p>{error}</p><button className="button button-small button-outline" onClick={onBack}>Voltar</button></div>

  return <div className="market-replenishment-dashboard">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-dashboard-header"><p className="eyebrow"><Truck size={16} /> GiroMicro Market</p><h1>Abastecimento</h1><p>Reposição Inteligente</p></header>

    {!overview?.run ? <div className="market-dashboard-blocked"><PackageSearch /><h2>Nenhuma análise concluída ainda</h2><p>Quando o batch de Reposição Inteligente concluir uma execução para este Market, o resultado aparecerá aqui.</p></div> : <>
      <section className="market-dashboard-section">
        <span className="panel-kicker">ÚLTIMA ANÁLISE</span>
        {/* Reaproveita o mesmo card/dl de estatísticas do Dashboard Comercial
            (market-store-performance) — nenhuma classe nova para este bloco. */}
        <div className="market-store-performance"><article><dl>
          <div><dt>Quando</dt><dd>{overview.run.finishedAt ? dateTimeFormat.format(new Date(overview.run.finishedAt)) : '—'}</dd></div>
          <div><dt>Lojas processadas</dt><dd>{overview.run.storesProcessed}</dd></div>
          <div><dt>Produtos selecionados</dt><dd>{overview.run.productsSelected}</dd></div>
          <div><dt>Críticos</dt><dd>{overview.run.criticalCount}</dd></div>
          <div><dt>Altos</dt><dd>{overview.run.highCount}</dd></div>
          <div><dt>Médios</dt><dd>{overview.run.mediumCount}</dd></div>
          <div><dt>Baixos</dt><dd>{overview.run.lowCount}</dd></div>
        </dl></article></div>
      </section>

      <section className="market-dashboard-section">
        <span className="panel-kicker">LOJAS</span>
        <h2>Necessidades por loja</h2>
        {!overview.stores.length ? <div className="admin-message">Nenhum candidato de reposição para as lojas às quais você tem acesso.</div> : overview.stores.map((store) => {
          const expanded = expandedStoreId === store.storeId
          // Reaproveita a mesma estrutura de card expansível de Compras
          // (market-purchase-card/-header/-stats/-toggle/-items) — nenhuma
          // classe nova para o card da loja em si, só para o conteúdo dos
          // produtos dentro dele (market-replenishment-*, ver index.css).
          return <article key={store.storeId} className={`market-purchase-card${expanded ? ' is-expanded' : ''}`}>
            <button type="button" className="market-purchase-card-header" onClick={() => setExpandedStoreId(expanded ? '' : store.storeId)} aria-expanded={expanded}>
              <div className="market-purchase-card-main"><strong>{store.storeName}</strong><span>{store.candidates.length} {store.candidates.length === 1 ? 'produto' : 'produtos'}</span></div>
              <dl className="market-purchase-card-stats">
                <div><dt>Críticos</dt><dd>{store.criticalCount}</dd></div>
                <div><dt>Altos</dt><dd>{store.highCount}</dd></div>
                <div><dt>Médios</dt><dd>{store.mediumCount}</dd></div>
                <div><dt>Baixos</dt><dd>{store.lowCount}</dd></div>
              </dl>
              <span className="market-purchase-card-toggle">{expanded ? 'Ocultar produtos' : 'Ver produtos'} <ChevronDown size={16} /></span>
            </button>
            {expanded && <div className="market-purchase-card-items">
              {store.candidates.map((candidate) => <article key={candidate.id} className="market-replenishment-candidate">
                <div className="market-replenishment-candidate-heading">
                  <strong>{candidate.productName}</strong>
                  <span className={`market-row-status ${candidate.priorityLevel}`}>{priorityLevelLabels[candidate.priorityLevel]}</span>
                </div>
                <dl>
                  <div><dt>Estoque atual</dt><dd>{formatKnownStock(candidate.currentStock)}</dd></div>
                  <div><dt>Mínimo</dt><dd>{formatMinimumStock(candidate.minimumStock)}</dd></div>
                  <div><dt>Cobertura</dt><dd>{formatCoverageDays(candidate.coverageDays)}</dd></div>
                  <div><dt>Média/dia (7D)</dt><dd>{formatAvgDailyM7(candidate.avgDailyM7)}</dd></div>
                  <div><dt>Sugestão</dt><dd className="market-replenishment-suggested">{formatSuggestedQuantity(candidate.suggestedQuantity)}</dd></div>
                  <div><dt>Galpão</dt><dd>{formatWarehouseStock(candidate.warehouseStock)}</dd></div>
                </dl>
                <div className="market-replenishment-reasons">
                  {candidate.triggerReasons.map((reason) => <span key={reason} className="market-row-status">{translateReplenishmentTriggerReason(reason)}</span>)}
                </div>
              </article>)}
            </div>}
          </article>
        })}
      </section>
    </>}
  </div>
}
