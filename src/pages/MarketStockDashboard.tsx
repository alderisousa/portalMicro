import { ArrowLeft, Boxes, CheckCircle2, Minus, Plus, RefreshCw, ScanBarcode, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  cancelMarketInventoryDraft, finalizeMarketInventoryDraft, getMarketInventoryDraft,
  getMarketStockBalance, getMarketStockContext, saveMarketInventoryDraft,
} from '../services/marketStock'
import type { MarketInitialInventoryItem, MarketInventoryDraft, MarketStockBalanceRow, MarketStockContext, MarketStockProduct } from '../types/marketStock'
import { BarcodeScanner } from '../components/BarcodeScanner'

interface Props { accountId: string; onBack: () => void }
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const initialDateTime = () => { const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset()); return now.toISOString().slice(0, 16) }
const toLocalDateTime = (value: string) => { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16) }
const externalCodes = (product: MarketStockProduct) => [...product.externalEans, ...product.externalProductCodes]
const productIdentifier = (product: MarketStockProduct) => product.ean
  ? `EAN ${product.ean}`
  : externalCodes(product)[0]
    ? `Código externo: ${externalCodes(product)[0]}`
    : product.sku ? `SKU ${product.sku}` : product.unit

export function findMarketStockProducts(products: MarketStockProduct[], query: string): MarketStockProduct[] {
  const term = normalizeSearch(query)
  if (!term) return []
  const exactEan = products.filter((product) => product.ean?.trim().toLocaleLowerCase('pt-BR') === term)
  if (exactEan.length) return exactEan
  const exactExternalCode = products.filter((product) => externalCodes(product).some((code) => code.trim().toLocaleLowerCase('pt-BR') === term))
  if (exactExternalCode.length) return exactExternalCode
  const exactSku = products.filter((product) => product.sku?.trim().toLocaleLowerCase('pt-BR') === term)
  if (exactSku.length) return exactSku
  return products.filter((product) => [product.name, product.ean, product.sku, ...externalCodes(product)].some((value) => value && normalizeSearch(value).includes(term)))
}

export function findExactMarketStockProduct(products: MarketStockProduct[], query: string): MarketStockProduct | null {
  const term = query.trim().toLocaleLowerCase('pt-BR')
  if (!term) return null
  const exactEan = products.filter((product) => product.ean?.trim().toLocaleLowerCase('pt-BR') === term)
  if (exactEan.length === 1) return exactEan[0]
  const exactExternalCode = products.filter((product) => externalCodes(product).some((code) => code.trim().toLocaleLowerCase('pt-BR') === term))
  if (exactExternalCode.length === 1) return exactExternalCode[0]
  if (exactExternalCode.length > 1) return null
  const exactSku = products.filter((product) => product.sku?.trim().toLocaleLowerCase('pt-BR') === term)
  return exactSku.length === 1 ? exactSku[0] : null
}

const isVersionConflict = (cause: unknown) => typeof cause === 'object' && cause && 'message' in cause
  && (String(cause.message).includes('INVENTORY_VERSION_CONFLICT') || String(cause.message).includes('INVENTORY_DRAFT_CONFLICT'))

export function MarketStockDashboard({ accountId, onBack }: Props) {
  const [context, setContext] = useState<MarketStockContext | null>(null)
  const [storeId, setStoreId] = useState('')
  const [balance, setBalance] = useState<MarketStockBalanceRow[]>([])
  const [draft, setDraft] = useState<MarketInventoryDraft | null>(null)
  const [counting, setCounting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [exitBlocked, setExitBlocked] = useState(false)
  const [query, setQuery] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [items, setItems] = useState<MarketInitialInventoryItem[]>([])
  const [startedAt, setStartedAt] = useState(initialDateTime)
  const [highlightedProductId, setHighlightedProductId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Record<string, HTMLElement | null>>({})
  const quantityRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const draftRef = useRef<MarketInventoryDraft | null>(null)
  const itemsRef = useRef<MarketInitialInventoryItem[]>([])
  const startedAtRef = useRef(startedAt)
  const revisionRef = useRef(0)
  const dirtyRef = useRef(false)
  const savePromiseRef = useRef<Promise<MarketInventoryDraft> | null>(null)

  const setCurrentDraft = (next: MarketInventoryDraft | null) => { draftRef.current = next; setDraft(next) }
  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { startedAtRef.current = startedAt }, [startedAt])

  const applyStoreData = async (nextStoreId: string, nextContext: MarketStockContext) => {
    const [nextBalance, nextDraft] = await Promise.all([
      nextStoreId ? getMarketStockBalance(accountId, nextStoreId) : Promise.resolve([]),
      nextStoreId ? getMarketInventoryDraft(accountId, nextStoreId) : Promise.resolve(null),
    ])
    setBalance(nextBalance); setCurrentDraft(nextDraft)
    setItems([]); itemsRef.current = []; setCounting(false); setConfirming(false); setConfirmCancel(false)
    dirtyRef.current = false; setSaveState(nextDraft ? 'saved' : 'idle')
  }

  const load = useCallback(async (preferredStoreId?: string) => {
    setLoading(true); setError('')
    try {
      const nextContext = await getMarketStockContext(accountId)
      const nextStoreId = preferredStoreId && nextContext.access.stores.some((store) => store.id === preferredStoreId) ? preferredStoreId : nextContext.access.stores[0]?.id ?? ''
      setContext(nextContext); setStoreId(nextStoreId); await applyStoreData(nextStoreId, nextContext)
    } catch (cause) { console.error('Falha ao carregar estoque:', cause); setError('Não foi possível carregar os dados de estoque.') }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (counting && !confirming) window.setTimeout(() => searchRef.current?.focus(), 0) }, [counting, confirming])

  const selectedStore = context?.access.stores.find((store) => store.id === storeId) ?? null
  const searchResults = useMemo(() => findMarketStockProducts(context?.products ?? [], query).slice(0, 8), [context, query])
  const positiveItems = items.filter((item) => item.quantity > 0)
  const isCycleInventory = draft?.inventoryType === 'cycle'
  const countedItems = isCycleInventory ? items : positiveItems
  const balanceByProduct = useMemo(() => new Map(balance.map((row) => [row.productId, row.quantityOnHand])), [balance])
  const cycleSummary = useMemo(() => items.reduce((summary, item) => {
    const difference = item.quantity - (balanceByProduct.get(item.productId) ?? 0)
    if (difference > 0) { summary.adjustmentInProducts += 1; summary.adjustmentInQuantity += difference }
    else if (difference < 0) { summary.adjustmentOutProducts += 1; summary.adjustmentOutQuantity += Math.abs(difference) }
    else summary.unchangedProducts += 1
    return summary
  }, { adjustmentInProducts: 0, adjustmentOutProducts: 0, unchangedProducts: 0, adjustmentInQuantity: 0, adjustmentOutQuantity: 0 }), [items, balanceByProduct])

  const markChanged = () => {
    dirtyRef.current = true; revisionRef.current += 1; setRevision(revisionRef.current); setSaveState('idle')
  }

  const persistDraft = useCallback(async (): Promise<boolean> => {
    if (saveState === 'conflict') return false
    while ((savePromiseRef.current || dirtyRef.current) && draftRef.current) {
      if (savePromiseRef.current) {
        try { await savePromiseRef.current } catch { return false }
        continue
      }
      const currentDraft = draftRef.current
      const snapshotRevision = revisionRef.current
      dirtyRef.current = false; setSaveState('saving')
      const request = saveMarketInventoryDraft(
        currentDraft.marketStoreId, currentDraft.id, currentDraft.version,
        new Date(startedAtRef.current).toISOString(), itemsRef.current,
      )
      savePromiseRef.current = request
      try {
        const saved = await request
        const next = { ...saved, items: itemsRef.current }
        setCurrentDraft(next)
        if (revisionRef.current !== snapshotRevision) dirtyRef.current = true
        setSaveState(dirtyRef.current ? 'idle' : 'saved')
      } catch (cause) {
        dirtyRef.current = true
        setSaveState(isVersionConflict(cause) ? 'conflict' : 'error')
        return false
      } finally { savePromiseRef.current = null }
    }
    return !dirtyRef.current
  }, [saveState])

  useEffect(() => {
    if (!counting || !draft || !dirtyRef.current || saveState === 'conflict') return
    const timer = window.setTimeout(() => { void persistDraft() }, 750)
    return () => window.clearTimeout(timer)
  }, [counting, draft, persistDraft, revision, saveState])

  const changeStore = async (nextStoreId: string) => {
    if (!context) return
    setStoreId(nextStoreId); setQuery(''); setSuccess(''); setError(''); setLoading(true)
    try { await applyStoreData(nextStoreId, context) }
    catch (cause) { console.error('Falha ao consultar estoque:', cause); setError('Não foi possível consultar este local.') }
    finally { setLoading(false) }
  }

  const startDraft = async () => {
    if (!selectedStore || saving) return
    setSaving(true); setError('')
    try {
      const nextStartedAt = initialDateTime()
      setStartedAt(nextStartedAt); startedAtRef.current = nextStartedAt
      const created = await saveMarketInventoryDraft(selectedStore.id, null, null, new Date(nextStartedAt).toISOString(), [])
      setCurrentDraft(created); setItems([]); setSaveState('saved'); setCounting(true)
    } catch (cause) {
      console.error('Falha ao iniciar rascunho:', cause)
      setError(isVersionConflict(cause) ? 'Já existe um inventário em andamento neste local. Recarregue para continuar.' : 'Não foi possível iniciar o inventário.')
    } finally { setSaving(false) }
  }

  const resumeDraft = () => {
    if (!draft) return
    setItems(draft.items); itemsRef.current = draft.items; setStartedAt(toLocalDateTime(draft.startedAt))
    startedAtRef.current = toLocalDateTime(draft.startedAt); dirtyRef.current = false; setSaveState('saved'); setCounting(true)
  }

  const focusExistingItem = (productId: string) => {
    setHighlightedProductId(productId)
    window.setTimeout(() => { itemRefs.current[productId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); quantityRefs.current[productId]?.focus(); quantityRefs.current[productId]?.select() }, 0)
    window.setTimeout(() => setHighlightedProductId(''), 1400)
  }

  const selectProduct = (product: MarketStockProduct, focusQuantity = false) => {
    const existing = itemsRef.current.find((item) => item.productId === product.id)
    setQuery(''); setError('')
    if (existing) { focusExistingItem(product.id); return }
    const next = [{ productId: product.id, quantity: 1 }, ...itemsRef.current]
    itemsRef.current = next; setItems(next); markChanged(); setHighlightedProductId(product.id)
    if (focusQuantity) focusExistingItem(product.id)
    else window.setTimeout(() => { setHighlightedProductId(''); searchRef.current?.focus() }, 500)
  }

  const changeSearch = (value: string) => {
    const exactProduct = findExactMarketStockProduct(context?.products ?? [], value)
    if (exactProduct) { selectProduct(exactProduct, true); return }
    setQuery(value)
  }

  const handleScannedCode = (code: string) => {
    setScannerOpen(false); setError('')
    const products = context?.products ?? []
    const exactProduct = findExactMarketStockProduct(products, code)
    if (exactProduct) { selectProduct(exactProduct, true); return }
    const matches = findMarketStockProducts(products, code)
    setQuery(code)
    setError(matches.length
      ? 'Este código corresponde a mais de um produto. Escolha o item correto na lista.'
      : `Código ${code} não encontrado. Você pode continuar pela busca manual.`)
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }

  const updateQuantity = (productId: string, quantity: number) => {
    const safeQuantity = Number.isFinite(quantity) ? Math.max(0, quantity) : 0
    const next = itemsRef.current.map((item) => item.productId === productId ? { ...item, quantity: safeQuantity } : item)
    itemsRef.current = next; setItems(next); markChanged()
  }

  const removeCountedProduct = (productId: string) => {
    const next = itemsRef.current.filter((item) => item.productId !== productId)
    itemsRef.current = next; setItems(next); markChanged(); searchRef.current?.focus()
  }

  const finishQuantity = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault(); setHighlightedProductId(''); searchRef.current?.focus()
  }

  const finalizeDraft = async () => {
    if (!draftRef.current || saving) return
    setSaving(true); setError('')
    try {
      if (!await persistDraft() || !draftRef.current) return
      const inventoryType = draftRef.current.inventoryType
      await finalizeMarketInventoryDraft(draftRef.current.id, draftRef.current.version)
      setCurrentDraft(null); setItems([]); setCounting(false); setConfirming(false)
      setSuccess(inventoryType === 'cycle' ? 'Inventário concluído e saldo reconciliado com sucesso.' : 'Controle de estoque iniciado com sucesso.'); await load(storeId)
    } catch (cause) {
      console.error('Falha ao finalizar inventário:', cause)
      setError(isVersionConflict(cause) ? 'Este inventário foi atualizado em outro dispositivo. Recarregue para continuar.' : 'Não foi possível finalizar o inventário.')
      if (isVersionConflict(cause)) setSaveState('conflict')
      setConfirming(false)
    } finally { setSaving(false) }
  }

  const cancelDraft = async () => {
    if (!draftRef.current || saving) return
    setSaving(true); setError('')
    try {
      await cancelMarketInventoryDraft(draftRef.current.id, draftRef.current.version)
      setCurrentDraft(null); setItems([]); itemsRef.current = []; setCounting(false); setConfirmCancel(false); setSaveState('idle')
    } catch (cause) {
      setError(isVersionConflict(cause) ? 'Este inventário foi atualizado em outro dispositivo. Recarregue antes de cancelar.' : 'Não foi possível cancelar o inventário.')
      if (isVersionConflict(cause)) setSaveState('conflict')
    } finally { setSaving(false) }
  }

  const leaveStock = async () => {
    if (counting && dirtyRef.current) {
      if (!await persistDraft()) { setExitBlocked(true); return }
    }
    onBack()
  }

  if (loading && !context) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando estoque...</div>
  if (!context) return <div className="admin-message is-error" role="alert"><p>{error || 'Estoque indisponível.'}</p><button className="button button-small button-outline" onClick={onBack}>Voltar</button></div>

  return <div className="market-stock-dashboard">
    <button className="button button-small button-outline" onClick={() => void leaveStock()}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-import-header market-stock-header"><p className="eyebrow"><Boxes size={16} /> GiroMicro Market</p><h1>Estoque</h1><p>Conte os produtos direto pelo celular, sem sair da tela.</p></header>
    <div className="market-dashboard-filter"><label htmlFor="market-stock-store">Local de estoque</label><select id="market-stock-store" value={storeId} onChange={(event) => void changeStore(event.target.value)} disabled={loading || counting}><option value="">Selecione um local</option>{context.access.stores.map((store) => <option key={store.id} value={store.id}>{store.store_type === 'warehouse' ? 'Galpão' : 'Loja'} — {store.external_code ? `${store.external_code} — ` : ''}{store.name}</option>)}</select>{selectedStore && <span>{selectedStore.name}</span>}</div>
    {error && <div className="admin-message is-error" role="alert">{error}</div>}
    {success && <div className="admin-message" role="status"><CheckCircle2 size={18} /> {success}</div>}
    {exitBlocked && <div className="market-draft-warning" role="alert"><p>Não foi possível salvar as últimas alterações. Continue nesta tela para não perder a contagem.</p><div><button className="button button-small button-outline" onClick={() => setExitBlocked(false)}>Continuar na tela</button><button className="button button-small" onClick={() => { setExitBlocked(false); void leaveStock() }}>Tentar novamente</button></div></div>}
    {saveState === 'conflict' && <div className="market-draft-warning" role="alert"><p>Este inventário foi atualizado em outro dispositivo. Recarregue para continuar.</p><button className="button button-small" onClick={() => void load(storeId)}>Recarregar rascunho</button></div>}

    {selectedStore && !selectedStore.stock_control_started_at && !counting && !draft && <section className="market-stock-start market-stock-welcome"><Boxes size={34} /><div><span className="panel-kicker">ESTOQUE</span><h2>Controle de estoque ainda não iniciado</h2><p>Faça uma contagem rápida dos produtos que estão neste local agora.</p></div>{context.canStart ? <button className="button market-stock-primary-action" disabled={saving} onClick={() => void startDraft()}>{saving ? 'Iniciando...' : 'Iniciar inventário'}</button> : <div className="admin-message">Seu perfil possui acesso somente para visualização.</div>}</section>}

    {selectedStore && !counting && draft && <section className="market-stock-start market-stock-welcome"><RefreshCw size={34} /><div><span className="panel-kicker">{draft.inventoryType === 'cycle' ? 'CONFERÊNCIA SALVA' : 'RASCUNHO SALVO'}</span><h2>Inventário em andamento</h2><p>{draft.items.length} {draft.items.length === 1 ? 'produto contado' : 'produtos contados'} · última atualização {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(draft.updatedAt))}</p></div>{context.canStart ? <div className="market-draft-actions"><button className="button" onClick={resumeDraft}>Continuar inventário</button><button className="button button-outline" onClick={() => setConfirmCancel(true)}>Cancelar inventário</button></div> : <div className="admin-message">Seu perfil permite apenas visualizar este rascunho.</div>}{confirmCancel && <div className="market-inventory-confirm"><div><strong>Cancelar este rascunho?</strong><p>Nenhum movimento de estoque será criado.</p></div><div><button className="button button-outline" onClick={() => setConfirmCancel(false)}>Voltar</button><button className="button" disabled={saving} onClick={() => void cancelDraft()}>{saving ? 'Cancelando...' : 'Confirmar cancelamento'}</button></div></div>}</section>}

    {selectedStore && counting && draft && <section className="market-quick-inventory">
      <header className="market-quick-heading"><div><span className="panel-kicker">{isCycleInventory ? 'CONFERÊNCIA DE ESTOQUE' : 'INVENTÁRIO RÁPIDO'}</span><h2>{selectedStore.name}</h2></div><div className={`market-draft-status ${saveState}`}><strong>{countedItems.length} {countedItems.length === 1 ? 'produto contado' : 'produtos contados'}</strong><small>{saveState === 'saving' ? 'Salvando...' : saveState === 'saved' ? 'Rascunho salvo' : saveState === 'error' ? 'Não foi possível salvar' : saveState === 'conflict' ? 'Conflito em outro dispositivo' : 'Alterações locais'}</small></div></header>
      <div className="market-product-search"><Search size={23} /><input ref={searchRef} type="search" inputMode="search" autoComplete="off" placeholder="Buscar por nome, EAN, código externo ou SKU" value={query} onChange={(event) => changeSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && searchResults[0]) { event.preventDefault(); selectProduct(searchResults[0]) } }} /><button className="market-scanner-button" type="button" onClick={() => setScannerOpen(true)} aria-label="Escanear código de barras"><ScanBarcode /></button><small>EAN, código externo ou SKU exato entra automaticamente. Para nomes, pressione Enter ou escolha o produto.</small></div>
      {query && <div className="market-product-results" role="listbox">{searchResults.length ? searchResults.map((product) => <button key={product.id} type="button" onClick={() => selectProduct(product)}><span><strong>{product.name}</strong><small>{productIdentifier(product)}</small></span></button>) : <p>Nenhum produto encontrado.</p>}</div>}
      <div className="market-counted-products">{items.length ? items.map((item) => {
        const product = context.products.find((candidate) => candidate.id === item.productId)
        if (!product) return null
        const currentQuantity = balanceByProduct.get(item.productId) ?? 0
        const difference = item.quantity - currentQuantity
        return <article ref={(element) => { itemRefs.current[item.productId] = element }} className={`${item.quantity === 0 && !isCycleInventory ? 'is-zero ' : ''}${highlightedProductId === item.productId ? 'is-highlighted' : ''}`} key={item.productId}>
          <div className="market-counted-product-name"><strong>{product.name}</strong><small>{productIdentifier(product)}</small>{isCycleInventory && <span className="market-stock-comparison">Saldo {number.format(currentQuantity)} · Contagem {number.format(item.quantity)} · <b className={difference > 0 ? 'is-positive' : difference < 0 ? 'is-negative' : ''}>Diferença {difference > 0 ? '+' : ''}{number.format(difference)}</b></span>}</div>
          <div className="market-quantity-stepper"><button type="button" aria-label={`Diminuir quantidade de ${product.name}`} onClick={() => updateQuantity(item.productId, item.quantity - 1)}><Minus /></button><input aria-label={`Quantidade contada de ${product.name}`} ref={(element) => { quantityRefs.current[item.productId] = element }} type="number" min="0" step="0.001" inputMode="decimal" value={item.quantity} onChange={(event) => updateQuantity(item.productId, Number(event.target.value))} onKeyDown={finishQuantity} onFocus={(event) => event.target.select()} /><button type="button" aria-label={`Aumentar quantidade de ${product.name}`} onClick={() => updateQuantity(item.productId, item.quantity + 1)}><Plus /></button></div>
          {item.quantity === 0 && <small className="market-zero-note">{isCycleInventory ? 'Contado = 0. Este produto será reconciliado com saldo zero.' : 'Quantidade zero: não será persistida nem enviada.'}</small>}
          {isCycleInventory && <button className="market-remove-counted" type="button" onClick={() => removeCountedProduct(item.productId)}><Trash2 size={15} /> Remover da contagem</button>}
        </article>
      }) : <div className="market-inventory-empty"><Search size={25} /><p>Busque o primeiro produto para começar.</p></div>}</div>
      <label className="market-stock-start-date">{isCycleInventory ? 'Data e hora da conferência' : 'Data e hora do marco inicial'}<input type="datetime-local" value={startedAt} onChange={(event) => { setStartedAt(event.target.value); startedAtRef.current = event.target.value; markChanged() }} /></label>
      {saveState === 'error' && <button className="button button-small button-outline" onClick={() => void persistDraft()}>Tentar salvar novamente</button>}
      {!confirming ? <div className="market-inventory-finish"><span>{countedItems.length} {countedItems.length === 1 ? (isCycleInventory ? 'produto será reconciliado' : 'produto será enviado') : (isCycleInventory ? 'produtos serão reconciliados' : 'produtos serão enviados')}</span><button className="button" disabled={!countedItems.length || !startedAt || saveState === 'conflict'} onClick={() => setConfirming(true)}>Finalizar inventário</button></div> : <div className="market-inventory-confirm"><div><span className="panel-kicker">CONFIRMAR INVENTÁRIO</span><h3>{selectedStore.name}</h3>{isCycleInventory ? <div className="market-cycle-summary"><p><strong>{items.length}</strong> produtos contados</p><p><strong>{cycleSummary.adjustmentInProducts}</strong> ajustes de entrada · {number.format(cycleSummary.adjustmentInQuantity)} unidades</p><p><strong>{cycleSummary.adjustmentOutProducts}</strong> ajustes de saída · {number.format(cycleSummary.adjustmentOutQuantity)} unidades</p><p><strong>{cycleSummary.unchangedProducts}</strong> sem diferença</p></div> : <p>{positiveItems.length} {positiveItems.length === 1 ? 'produto contado' : 'produtos contados'} · marco em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(startedAt))}</p>}</div><div><button className="button button-outline" disabled={saving} onClick={() => setConfirming(false)}>Continuar inventário</button><button className="button" disabled={saving} onClick={() => void finalizeDraft()}>{saving ? 'Finalizando...' : isCycleInventory ? 'Confirmar inventário' : 'Confirmar e iniciar estoque'}</button></div></div>}
    </section>}

    {selectedStore?.stock_control_started_at && !counting && <section className="market-stock-balance"><div><span className="panel-kicker">SALDO ATUAL</span><h2>Controle de estoque iniciado</h2><p>Marco inicial: {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(selectedStore.stock_control_started_at))}</p></div>{!draft && context.canStart && <button className="button market-stock-primary-action" disabled={saving} onClick={() => void startDraft()}>{saving ? 'Iniciando...' : 'Novo inventário'}</button>}{balance.length ? <div className="market-preview-table-wrap"><table className="market-preview-table market-stock-table"><thead><tr><th>Produto</th><th>Identificador</th><th>Quantidade atual</th></tr></thead><tbody>{balance.map((row) => { const product = context.products.find((candidate) => candidate.id === row.productId); return <tr key={`${row.marketStoreId}:${row.productId}`}><td>{row.productName}</td><td>{product ? productIdentifier(product) : row.ean || row.sku || '—'}</td><td><strong>{number.format(row.quantityOnHand)} {row.unit}</strong></td></tr> })}</tbody></table></div> : <div className="admin-message">Nenhum saldo encontrado para este local.</div>}</section>}
    {scannerOpen && <BarcodeScanner onDetected={handleScannedCode} onClose={() => { setScannerOpen(false); window.setTimeout(() => searchRef.current?.focus(), 0) }} />}
  </div>
}
