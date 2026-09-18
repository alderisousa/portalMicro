import { ArrowLeft, Download, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { MarketStore } from '../types/market'
import { getMarketSaleMargin, type SaleMarginRow } from '../services/marketSaleMargin'
import './MarketSaleMargin.css'

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const percent = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 })
const purchaseDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(value))

export function MarketSaleMargin({ accountId, stores, onBack }: { accountId: string; stores: MarketStore[]; onBack: () => void }) {
  const [storeId, setStoreId] = useState('')
  const [revision, setRevision] = useState(0)
  const availableStores = stores.filter(store => store.store_type === 'store' && store.status === 'active')
  const store = availableStores.find(item => item.id === storeId)
  return <div className="market-sale-margin">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Voltar ao Market</button>
    <header className="market-import-header"><p className="eyebrow">Produtos</p><h1>Margem de venda</h1><p>Produtos abaixo da margem mínima desejada na loja. Análise somente de leitura.</p></header>
    {!availableStores.length ? <p className="admin-message">Nenhuma loja operacional disponível para seu acesso.</p> : <>
      <label className="sale-margin-store">Loja<select value={storeId} onChange={event => setStoreId(event.target.value)}><option value="">Selecione uma loja</option>
        {availableStores.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {store && <SaleMarginResults key={`${accountId}:${store.id}:${revision}`} accountId={accountId} store={store} onReload={() => setRevision(value => value + 1)} />}
    </>}
  </div>
}

export function SaleMarginResults({ accountId, store, onReload }: { accountId: string; store: MarketStore; onReload: () => void }) {
  const [rows, setRows] = useState<SaleMarginRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [exportError, setExportError] = useState('')
  const [exporting, setExporting] = useState(false)
  const pending = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    let current = true
    void getMarketSaleMargin(accountId, store.id).then(result => { if (current) setRows(result) })
      .catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'Não foi possível consultar a margem de venda.') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false; active.current = false }
  }, [accountId, store.id])

  async function exportExcel() {
    if (loading || error || !rows.length || pending.current) return
    pending.current = true; setExporting(true); setExportError('')
    try {
      const { createSaleMarginSpreadsheet } = await import('../utils/marketSaleMarginExport')
      const { buffer, filename } = await createSaleMarginSpreadsheet(rows, store.name)
      if (!active.current) return
      const url = URL.createObjectURL(new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const link = document.createElement('a')
      link.href = url; link.download = filename
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { if (active.current) setExportError('Não foi possível exportar. Tente novamente.') }
    finally { pending.current = false; if (active.current) setExporting(false) }
  }

  return <section aria-label={`Margens de ${store.name}`}>
    <div className="sale-margin-actions">
      <button className="button button-small button-outline" onClick={onReload} disabled={loading || exporting}><RefreshCw size={16} /> Atualizar análise</button>
      <button className="button button-small button-outline" onClick={() => void exportExcel()} disabled={loading || !!error || !rows.length || exporting}><Download size={16} /> {exporting ? 'Exportando...' : 'Exportar Excel'}</button>
    </div>
    {exportError && <p className="admin-message is-error" role="alert">{exportError}</p>}
    {loading ? <p className="admin-message" role="status">Consultando margens...</p> : error ? <p className="admin-message is-error" role="alert">{error}</p> : <>
      <p className="sale-margin-note">Somente produtos com meta, preço e custo válidos entram na análise. O custo prioriza compras recebidas no Market; na ausência, usa o Accesys da loja.</p>
      {!rows.length ? <p className="admin-message" role="status">Nenhum produto abaixo da meta entre os produtos com dados válidos nesta loja.</p> : <>
        <p className="sale-margin-note" role="status">Exibindo {Math.min(rows.length, 20)} de {rows.length} produtos, pelo maior desvio. O Excel inclui todos os resultados de {store.name}.</p>
        <div className="sale-margin-list">{rows.slice(0, 20).map(row => <article key={row.product_id} className="sale-margin-product">
          <h2>{row.product_name}</h2><p className="sale-margin-note">{[row.ean ? `EAN ${row.ean}` : null, row.code ? `Código/SKU ${row.code}` : null].filter(Boolean).join(' · ')}</p>
          <dl><div><dt>Custo · {row.cost_source === 'COMPRA GIROMICRO' ? 'Compra GiroMicro' : 'Accesys'}</dt><dd>{money.format(row.cost)}</dd></div>
            <div><dt>Venda</dt><dd>{money.format(row.sale_price)}</dd></div>
            <div><dt>Margem atual</dt><dd>{percent.format(row.current_margin_pct)}%</dd></div>
            <div><dt>Desejada</dt><dd>{percent.format(row.desired_margin_pct)}%</dd></div>
            <div><dt>Abaixo</dt><dd>{percent.format(row.difference_pp)} p.p.</dd></div></dl>
          {row.cost_source === 'COMPRA GIROMICRO' && <p className="sale-margin-note">{[row.purchase_date ? purchaseDate(row.purchase_date) : null, row.supplier_name, row.invoice_number ? `Nota ${row.invoice_number}` : null].filter(Boolean).join(' · ')}</p>}
        </article>)}</div>
      </>}
    </>}
  </section>
}
