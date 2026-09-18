import { ArrowLeft, Download, Save, ScanBarcode, Search } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { MarketStore } from '../types/market'
import type { MarketStockProduct } from '../types/marketStock'
import { listActiveProducts } from '../services/marketStock'
import { getStoreProductParameters, listStoreProductParametersForExport, operationalStores, parseStoreProductParameters, saveStoreProductParameters } from '../services/marketStoreProductParameters'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { findExactMarketStockProduct, findMarketStockProducts } from './MarketStockDashboard'
import './MarketStoreProductParameters.css'

interface Props { accountId: string; stores: MarketStore[]; onBack: () => void }
const identifier = (product: MarketStockProduct) => [product.ean && `EAN ${product.ean}`, product.sku && `SKU ${product.sku}`,
  ...product.externalProductCodes.map(code => `Código ${code}`), ...product.externalEans.map(ean => `EAN externo ${ean}`)].filter(Boolean).join(' · ') || `ID ${product.id}`

export function MarketStoreProductParameters({ accountId, stores, onBack }: Props) {
  const availableStores = operationalStores(stores)
  const [storeId, setStoreId] = useState('')
  const [products, setProducts] = useState<MarketStockProduct[] | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MarketStockProduct | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const [scanError, setScanError] = useState('')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const exportPending = useRef(false)
  const store = availableStores.find(item => item.id === storeId)

  useEffect(() => {
    if (!storeId) return
    let active = true
    setCatalogError(false)
    setProducts(null)
    void listActiveProducts(accountId).then(result => { if (active) setProducts(result) })
      .catch(() => { if (active) setCatalogError(true) })
    return () => { active = false }
  }, [accountId, storeId, revision])

  function selectProduct(product: MarketStockProduct) { setSelected(product); setQuery(''); setNotice(''); setScanError('') }
  function focusSearch() { window.setTimeout(() => searchRef.current?.focus(), 0) }
  function handleScannedCode(code: string) {
    setScannerOpen(false); setScanError(''); setSelected(null)
    const exactProduct = findExactMarketStockProduct(products ?? [], code)
    if (exactProduct) { selectProduct(exactProduct); return }
    setQuery(code)
    setScanError(findMarketStockProducts(products ?? [], code).length
      ? 'Este código corresponde a mais de um produto. Escolha o item correto na lista.'
      : `Código ${code} não encontrado. Você pode continuar pela busca manual.`)
    focusSearch()
  }
  async function exportExcel() {
    if (!store || exportPending.current) return
    exportPending.current = true; setExporting(true); setExportError('')
    try {
      const rows = await listStoreProductParametersForExport(accountId, store)
      if (!rows.length) { setExportError('Nenhum produto parametrizado nesta loja.'); return }
      const { createStoreProductParametersSpreadsheet } = await import('../utils/marketStoreProductParametersExport')
      const { buffer, filename } = await createStoreProductParametersSpreadsheet(rows, store.name)
      const url = URL.createObjectURL(new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const link = document.createElement('a')
      link.href = url; link.download = filename
      document.body.appendChild(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch { setExportError('Não foi possível exportar. Tente novamente.') }
    finally { exportPending.current = false; setExporting(false) }
  }
  function search(value: string) {
    setQuery(value)
    setSelected(null)
    setScanError(''); setNotice('')
    const exact = findExactMarketStockProduct(products ?? [], value)
    if (exact) selectProduct(exact)
  }
  const results = findMarketStockProducts(products ?? [], query).slice(0, 8)

  return <div className="market-store-product-parameters">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Voltar ao Market</button>
    <header className="market-import-header"><p className="eyebrow">Produtos</p><h1>Parâmetros por loja/produto</h1><p>Selecione a loja e pesquise o produto. Cada loja possui seus próprios parâmetros.</p></header>
    {!availableStores.length ? <p className="admin-message">Nenhuma loja operacional disponível para seu acesso.</p> : <>
      <label className="store-parameters-store">Loja<select value={storeId} disabled={exporting} onChange={event => { setStoreId(event.target.value); setSelected(null); setQuery(''); setProducts(null); setNotice(''); setScanError(''); setExportError(''); setScannerOpen(false) }}>
        <option value="">Selecione uma loja</option>{availableStores.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {store && <>
        <button className="button button-small button-outline" disabled={exporting} onClick={() => void exportExcel()}><Download size={16} /> {exporting ? 'Exportando...' : 'Exportar Excel'}</button>
        {exportError && <p className="admin-message" role="status">{exportError}</p>}
        {notice && <p className="store-parameters-notice" role="status">{notice}</p>}
        {scanError && <p className="admin-message" role="alert">{scanError}</p>}
        {catalogError ? <div className="admin-message is-error" role="alert">Não foi possível carregar o catálogo. <button className="button button-small button-outline" onClick={() => setRevision(value => value + 1)}>Tentar novamente</button></div>
          : !products ? <p className="admin-message" role="status">Carregando catálogo...</p> : <>
            <div className="market-product-search"><Search size={23} /><input ref={searchRef} aria-label="Pesquisar produto" type="search" autoComplete="off" placeholder="Buscar por nome, EAN, código externo ou SKU" value={query} onChange={event => search(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && results[0]) { event.preventDefault(); selectProduct(results[0]) } }} />
              <button className="market-scanner-button" type="button" onClick={() => setScannerOpen(true)} aria-label="Escanear código de barras"><ScanBarcode /></button>
              <small>EAN, código externo ou SKU exato seleciona automaticamente. Para nomes, pressione Enter ou escolha o produto.</small></div>
            {query.trim() && <div className="market-product-results" aria-label="Resultados da pesquisa">{results.length ? results.map(product => <button key={product.id} type="button" onClick={() => selectProduct(product)}><span><strong>{product.name}</strong><small>{identifier(product)}</small></span></button>) : <p>Nenhum produto encontrado.</p>}</div>}
            {selected && <ProductParametersEditor key={`${accountId}:${storeId}:${selected.id}`} accountId={accountId} storeId={storeId} storeName={store.name} product={selected} onSaved={() => {
              setNotice(`Parâmetros salvos para ${selected.name} em ${store.name}.`)
              setSelected(null); setQuery(''); focusSearch()
            }} />}
            {scannerOpen && <BarcodeScanner onDetected={handleScannedCode} onClose={() => { setScannerOpen(false); focusSearch() }} />}
          </>}
      </>}
    </>}
  </div>
}

export function ProductParametersEditor({ accountId, storeId, storeName, product, onSaved }: { accountId: string; storeId: string; storeName: string; product: MarketStockProduct; onSaved: () => void }) {
  const [stock, setStock] = useState('')
  const [essential, setEssential] = useState(false)
  const [margin, setMargin] = useState('')
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true
    setLoading(true); setLoaded(false); setError('')
    void getStoreProductParameters(accountId, storeId, product.id).then(result => {
      if (!active) return
      setStock(result.minimum_stock === null ? '' : String(result.minimum_stock))
      setEssential(result.is_essential)
      setMargin(result.minimum_margin_pct === null ? '' : String(result.minimum_margin_pct))
      setLoaded(true)
    }).catch(() => { if (active) setError('Não foi possível carregar os parâmetros deste produto. Tente novamente.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId, storeId, product.id, revision])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (!loaded || pending.current) return
    pending.current = true; setSaving(true); setError('')
    try {
      await saveStoreProductParameters(accountId, storeId, product.id, parseStoreProductParameters(stock, essential, margin))
      if (!mounted.current) return
      onSaved()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Não foi possível salvar os parâmetros. Confira sua permissão e tente novamente.')
    } finally { pending.current = false; if (mounted.current) setSaving(false) }
  }
  function edited() { setError('') }

  return <section className="store-parameters-editor" aria-label="Parâmetros do produto selecionado">
    <div className="store-parameters-identity"><span>{storeName}</span><h2>{product.name}</h2><p>{identifier(product)}</p></div>
    {loading && <p className="admin-message" role="status">Carregando parâmetros...</p>}
    {error && <div className="admin-message is-error" role="alert">{error}{!loading && !loaded && <button className="button button-small button-outline" onClick={() => setRevision(value => value + 1)}>Tentar novamente</button>}</div>}
    {loaded && <form onSubmit={save}>
      <fieldset disabled={saving} className="store-parameters-fields">
        <label>Estoque mínimo<input type="number" inputMode="numeric" min="0" max="99999999999" step="1" value={stock} onChange={event => { setStock(event.target.value); edited() }} aria-describedby="minimum-stock-help" /><small id="minimum-stock-help">Opcional, somente inteiro. Deixe vazio para não configurar; zero é válido.</small></label>
        <label>Margem mínima desejada (%)<input type="number" inputMode="numeric" min="0" max="100" step="1" value={margin} onChange={event => { setMargin(event.target.value); edited() }} aria-describedby="minimum-margin-help" /><small id="minimum-margin-help">Opcional, inteiro de 0% a 100%. Apenas cadastra a meta; não altera custo ou preço de venda.</small></label>
        <label className="store-parameters-essential"><input type="checkbox" checked={essential} onChange={event => { setEssential(event.target.checked); edited() }} /> Produto essencial</label>
      </fieldset>
      <div className="admin-form-actions"><button className="button" disabled={saving} type="submit"><Save size={16} /> {saving ? 'Salvando...' : 'Salvar parâmetros'}</button></div>
    </form>}
  </section>
}
