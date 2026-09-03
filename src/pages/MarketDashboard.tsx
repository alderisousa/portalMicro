import { ArrowLeft, BarChart3, Boxes, PackageSearch, Repeat2, ShoppingCart, Store, Warehouse } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentUserMarketAccess } from '../services/market'
import { canAccessMarketSalesImports } from '../services/marketDashboardPermissions'
import { getMarketSalesSyncContext } from '../services/marketSalesSync'
import type { CurrentUserMarketAccess } from '../types/market'
import { MarketSalesImports } from './MarketSalesImports'
import { MarketCommercialDashboard } from './MarketCommercialDashboard'
import { MarketStockDashboard } from './MarketStockDashboard'

interface MarketDashboardProps { header: ReactNode; accountId: string; onBack: () => void }
const roleLabels = { owner: 'Proprietário', admin: 'Administrador', manager: 'Gerente', operator: 'Operador', viewer: 'Visualização' }

export function MarketDashboard({ header, accountId, onBack }: MarketDashboardProps) {
  const [access, setAccess] = useState<CurrentUserMarketAccess | null>(null)
  const [loading, setLoading] = useState(true)
  const [showSalesImports, setShowSalesImports] = useState(false)
  const [showCommercialDashboard, setShowCommercialDashboard] = useState(false)
  const [showStockDashboard, setShowStockDashboard] = useState(false)
  const [salesIntegrationAvailable, setSalesIntegrationAvailable] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    void getCurrentUserMarketAccess(accountId)
      .then((result) => { if (active) setAccess(result) })
      .catch((error) => { console.error('Falha ao validar acesso Market:', error); if (active) setAccess(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId])

  useEffect(() => {
    let active = true
    setSalesIntegrationAvailable(null)
    void getMarketSalesSyncContext(accountId)
      .then((result) => { if (active) setSalesIntegrationAvailable(result.integrationAvailable) })
      .catch((error) => { console.error('Falha ao validar integração de vendas:', error) })
    return () => { active = false }
  }, [accountId])

  if (loading) return <main>{header}<section className="market-dashboard container"><div className="admin-message" role="status">Validando acesso à conta Market...</div></section></main>
  if (!access || access.member_status !== 'active') return <main>{header}<section className="market-dashboard container"><button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Meu painel</button><div className="market-access-blocked"><Store size={28} /><h1>Acesso ao GiroMicro Market indisponível</h1><p>Seu vínculo com esta conta não está ativo.</p></div></section></main>
  if (access.status === 'suspended' || access.status === 'cancelled') {
    return <main>{header}<section className="market-dashboard container"><button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Meu painel</button><div className="market-access-blocked"><Store size={28} /><p className="eyebrow">GiroMicro Market</p><h1>Acesso ao GiroMicro Market indisponível</h1><p>{access.status === 'suspended' ? 'Esta conta está suspensa. Entre em contato com o administrador.' : 'Esta conta do GiroMicro Market está cancelada.'}</p></div></section></main>
  }
  if (showSalesImports && canAccessMarketSalesImports(access.role, salesIntegrationAvailable)) return <main>{header}<section className="market-dashboard container"><MarketSalesImports accountId={accountId} onBack={() => setShowSalesImports(false)} /></section></main>
  if (showCommercialDashboard) return <main>{header}<section className="market-dashboard container"><MarketCommercialDashboard accountId={accountId} accountName={access.name} role={access.role} onBack={() => setShowCommercialDashboard(false)} /></section></main>
  if (showStockDashboard) return <main>{header}<section className="market-dashboard container"><MarketStockDashboard accountId={accountId} onBack={() => setShowStockDashboard(false)} /></section></main>
  return <main>{header}<section className="market-dashboard container">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Meu painel</button>
    <header className="market-dashboard-header"><p className="eyebrow"><Store size={16} /> GiroMicro Market</p><h1>{access.name}</h1><p>Perfil: <strong>{roleLabels[access.role]}</strong></p></header>
    <section className="market-dashboard-section"><span className="panel-kicker">ACESSO AUTORIZADO</span><h2>Locais disponíveis</h2>{access.stores.length ? <div className="market-dashboard-stores">{access.stores.map((store) => <article key={store.id}>{store.store_type === 'warehouse' ? <Warehouse size={20} /> : <Store size={20} />}<div><strong>{store.name}</strong><span>{store.store_type === 'warehouse' ? 'Galpão' : 'Loja'} · {store.external_code ? `Código ${store.external_code}` : 'Sem código externo'}</span></div></article>)}</div> : <div className="admin-message">Nenhum local disponível para este acesso.</div>}</section>
    <section className="market-dashboard-section"><span className="panel-kicker">GESTÃO</span><h2>Recursos</h2><div className="market-feature-grid"><article className="is-available"><BarChart3 /><strong>{access.role === 'operator' ? 'Status de vendas' : 'Dashboard Comercial'}</strong><span>{access.role === 'operator' ? 'Acompanhar a última sincronização' : 'Indicadores de vendas, lojas e produtos'}</span><button className="button button-small" onClick={() => setShowCommercialDashboard(true)}>{access.role === 'operator' ? 'Ver sincronização' : 'Abrir Dashboard'}</button></article>{canAccessMarketSalesImports(access.role, salesIntegrationAvailable) && <article className="is-available"><ShoppingCart /><strong>Importações</strong><span>Analisar planilha de itens vendidos</span><button className="button button-small" onClick={() => setShowSalesImports(true)}>Importar vendas</button></article>}<article className="is-available"><Boxes /><strong>Estoque</strong><span>Inventário inicial e saldo por produto</span><button className="button button-small" onClick={() => setShowStockDashboard(true)}>Abrir Estoque</button></article><article><Repeat2 /><strong>Transferências</strong><span>Em breve nesta etapa do piloto</span></article><article><PackageSearch /><strong>Produtos</strong><span>Em breve nesta etapa do piloto</span></article></div></section>
  </section></main>
}
