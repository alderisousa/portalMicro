import { AlertTriangle, ArrowLeft, BarChart3, CalendarDays, CircleAlert, CircleCheck, Clock3, PackageSearch, RefreshCw, Store } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getMarketCommercialDashboard } from '../services/marketCommercialDashboard'
import type { MarketCommercialDashboardData, MarketDashboardQuality, MarketProductRankingItem } from '../types/marketCommercialDashboard'

interface Props { accountId: string; onBack: () => void }
const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const percent = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const date = (value: string | null) => value ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'não identificado'

const qualityContent: Record<MarketDashboardQuality, { title: string; description: string; icon: typeof CircleCheck }> = {
  updated: { title: 'Dados atualizados', description: 'Há uma sequência recente de importações diárias disponível.', icon: CircleCheck },
  consolidated: { title: 'Histórico consolidado', description: 'Este período foi importado de forma consolidada. É possível analisar vendas, lojas e produtos, mas não a evolução diária dentro desse intervalo.', icon: CalendarDays },
  stale: { title: 'Dados desatualizados', description: 'A última cobertura comercial disponível está defasada. Importe um relatório mais recente.', icon: Clock3 },
  incomplete: { title: 'Cobertura incompleta', description: 'Existem períodos sem dados entre as importações disponíveis.', icon: AlertTriangle },
  overlap: { title: 'Períodos sobrepostos', description: 'Existem importações finalizadas com períodos sobrepostos. Os valores não são somados para evitar duplicidade.', icon: AlertTriangle },
  no_data: { title: 'Sem dados comerciais', description: 'Ainda não há uma importação finalizada disponível para este dashboard.', icon: CircleAlert },
}

export function MarketCommercialDashboard({ accountId, onBack }: Props) {
  const [storeId, setStoreId] = useState<string | null>(null)
  const [data, setData] = useState<MarketCommercialDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true); setError('')
    void getMarketCommercialDashboard(accountId, storeId)
      .then((result) => { if (active) setData(result) })
      .catch((cause) => { console.error('Falha ao carregar Dashboard Comercial:', cause); if (active) setError('Não foi possível carregar os indicadores comerciais.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId, storeId])

  if (loading && !data) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando indicadores comerciais...</div>
  if (error || !data) return <div className="admin-message is-error" role="alert"><p>{error || 'Dashboard indisponível.'}</p><button className="button button-small button-outline" onClick={onBack}>Voltar</button></div>

  const quality = qualityContent[data.quality]
  const QualityIcon = quality.icon
  const selectedStore = data.stores.find((store) => store.id === storeId)
  const maxStoreRevenue = Math.max(...data.storePerformance.map((store) => store.revenue), 1)

  return <div className="market-commercial-dashboard">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-commercial-header">
      <div><p className="eyebrow"><BarChart3 size={16} /> GiroMicro Market</p><h1>Dashboard Comercial</h1><p>Acompanhe o desempenho das suas lojas e produtos.</p></div>
      <div className="market-commercial-context"><span>Conta Market</span><strong>{data.accountName}</strong><small>Período: {date(data.periodStart)} a {date(data.periodEnd)}</small></div>
    </header>

    <section className={`market-data-quality ${data.quality}`}>
      <QualityIcon size={23} /><div><strong>{quality.title}</strong><p>{quality.description}</p>{data.periodEnd && <small>Dados disponíveis até {date(data.periodEnd)}</small>}{data.hasGaps && <div className="market-coverage-gaps"><strong>{data.gapCount === 1 ? 'Período sem dados:' : 'Períodos sem dados:'}</strong><ul>{data.gaps.map((gap) => <li key={`${gap.startDate}:${gap.endDate}`}>{date(gap.startDate)} a {date(gap.endDate)}</li>)}</ul></div>}</div>
    </section>

    <div className="market-dashboard-filter"><label htmlFor="market-dashboard-store">Loja</label><select id="market-dashboard-store" value={storeId ?? ''} onChange={(event) => setStoreId(event.target.value || null)} disabled={loading}><option value="">Todas as lojas</option>{data.stores.map((store) => <option key={store.id} value={store.id}>{store.externalCode ? `${store.externalCode} — ` : ''}{store.name}</option>)}</select><span>{selectedStore ? selectedStore.name : `${data.stores.length} ${data.stores.length === 1 ? 'loja acessível' : 'lojas acessíveis'}`}</span></div>

    {loading && <p className="admin-feedback" role="status">Atualizando indicadores da loja...</p>}
    {data.hasOverlap ? <div className="market-dashboard-blocked"><AlertTriangle /><h2>Totais temporariamente indisponíveis</h2><p>Revise os períodos sobrepostos antes de consolidar os indicadores. Nenhuma soma arbitrária foi aplicada.</p></div> : data.totals ? <>
      <section className="market-commercial-cards">
        <article><span>Faturamento</span><strong>{currency.format(data.totals.revenue)}</strong></article>
        <article><span>Custo total</span><strong>{currency.format(data.totals.cost)}</strong></article>
        <article><span>Lucro</span><strong>{currency.format(data.totals.profit)}</strong><small>Margem {data.totals.margin === null ? '—' : `${percent.format(data.totals.margin)}%`}</small></article>
        <article><span>Itens vendidos</span><strong>{number.format(data.totals.quantity)}</strong></article>
      </section>

      <section className="market-commercial-section"><div className="market-section-heading"><div><span className="panel-kicker">LOJAS</span><h2>Desempenho por loja</h2></div><Store size={22} /></div><div className="market-store-performance">{data.storePerformance.map((store) => <article key={store.storeId}><div className="market-store-performance-heading"><div><strong>{store.storeName}</strong><span>{store.externalCode || 'Sem código externo'}</span></div><strong>{currency.format(store.revenue)}</strong></div><div className="market-performance-track"><span style={{ width: `${Math.max((store.revenue / maxStoreRevenue) * 100, 2)}%` }} /></div><dl><div><dt>Itens</dt><dd>{number.format(store.quantity)}</dd></div><div><dt>Custo</dt><dd>{currency.format(store.cost)}</dd></div><div><dt>Lucro</dt><dd>{currency.format(store.profit)}</dd></div><div><dt>Margem</dt><dd>{store.margin === null ? '—' : `${percent.format(store.margin)}%`}</dd></div></dl></article>)}</div></section>

      <section className="market-commercial-section"><div className="market-section-heading"><div><span className="panel-kicker">PRODUTOS</span><h2>Rankings comerciais</h2></div><PackageSearch size={22} /></div><div className="market-ranking-grid"><ProductRanking title="Mais vendidos" items={data.topByQuantity} metric={(item) => `${number.format(item.quantity)} itens`} /><ProductRanking title="Maior faturamento" items={data.topByRevenue} metric={(item) => currency.format(item.revenue)} /><ProductRanking title="Maior lucro" items={data.topByProfit} metric={(item) => currency.format(item.profit)} /></div></section>

      <section className={`market-commercial-attention ${data.negativeProfit.length ? 'has-alerts' : ''}`}><div><span className="panel-kicker">ATENÇÃO</span><h2>{data.negativeProfit.length ? 'Existem vendas com resultado negativo no período.' : 'Nenhum resultado negativo identificado.'}</h2><p>Este bloco considera somente o resultado comercial importado e não utiliza dados de estoque.</p></div>{data.negativeProfit.length > 0 && <ol>{data.negativeProfit.map((item) => <li key={item.product_key}><span>{item.product_name}<small>{item.identifier || 'Sem identificador'}</small></span><strong>{currency.format(item.profit)}</strong></li>)}</ol>}</section>
    </> : <div className="market-dashboard-blocked"><CircleAlert /><h2>Importe vendas para começar</h2><p>O Dashboard Comercial será preenchido depois que uma importação for concluída.</p></div>}

    <aside className="market-daily-import-hint"><CalendarDays size={21} /><p>Para acompanhar evolução diária, semanal e mensal, importe regularmente o relatório “Ontem” do seu sistema de vendas.</p></aside>
  </div>
}

function ProductRanking({ title, items, metric }: { title: string; items: MarketProductRankingItem[]; metric: (item: MarketProductRankingItem) => string }) {
  return <article className="market-ranking"><h3>{title}</h3>{items.length ? <ol>{items.map((item, index) => <li key={item.product_key}><span className="market-ranking-position">{index + 1}</span><span><strong>{item.product_name}</strong><small>{item.identifier || 'Sem identificador'}</small></span><b>{metric(item)}</b></li>)}</ol> : <p>Sem dados para este ranking.</p>}</article>
}
