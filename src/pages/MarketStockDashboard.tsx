import { ArrowLeft, Boxes, CheckCircle2, Minus, Plus, RefreshCw, ScanBarcode, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  cancelMarketInventoryDraft, finalizeMarketInventoryDraft, getMarketInventoryDraft,
  getMarketStockBalance, getMarketStockContext, listActiveProducts, saveMarketInventoryDraft,
} from '../services/marketStock'
import type { MarketInitialInventoryItem, MarketInventoryDraft, MarketInventoryReasonCode, MarketStockBalanceRow, MarketStockContext, MarketStockProduct } from '../types/marketStock'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { findAccesysIntegrationId, getMarketProductSyncStatus, synchronizeMarketProducts } from '../services/marketIntegration'
import type { MarketProductSyncRun } from '../types/marketIntegration'
import { compareStockCount, findMarketStockBalance, isReasonCodeAllowedForDifference, isReasonMissing, reasonNeedsReset, requiresDivergenceReason } from '../utils/marketStockBalance'

interface Props { accountId: string; onBack: () => void }
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
const initialDateTime = () => { const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset()); return now.toISOString().slice(0, 16) }
const toLocalDateTime = (value: string) => { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16) }
const formatProductSyncDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  .format(new Date(value)).replace(', ', ' às ')
const externalCodes = (product: MarketStockProduct) => [...product.externalEans, ...product.externalProductCodes]
const productIdentifier = (product: MarketStockProduct) => product.ean
  ? `EAN ${product.ean}`
  : externalCodes(product)[0]
    ? `Código externo: ${externalCodes(product)[0]}`
    : product.sku ? `SKU ${product.sku}` : product.unit

// Conjunto estável de motivos de divergência (market_inventory_session_items.reason_code,
// 202609080003) — mesmos códigos aceitos pelo check constraint no banco.
const reasonCodes: MarketInventoryReasonCode[] = [
  'EXPIRED_LOSS', 'DAMAGE', 'THEFT_LOSS', 'PREVIOUS_COUNT_ERROR',
  'UNREGISTERED_PURCHASE', 'UNREGISTERED_TRANSFER', 'INTERNAL_USE', 'OTHER',
]
const reasonLabels: Record<MarketInventoryReasonCode, string> = {
  EXPIRED_LOSS: 'Perda / produto vencido',
  DAMAGE: 'Quebra / avaria',
  THEFT_LOSS: 'Furto / extravio',
  PREVIOUS_COUNT_ERROR: 'Contagem anterior incorreta',
  UNREGISTERED_PURCHASE: 'Compra / nota não registrada',
  UNREGISTERED_TRANSFER: 'Transferência não registrada',
  INTERNAL_USE: 'Consumo / uso interno',
  OTHER: 'Outro',
}

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
  const [products, setProducts] = useState<MarketStockProduct[] | null>(null)
  const [storeId, setStoreId] = useState('')
  const [balance, setBalance] = useState<MarketStockBalanceRow[]>([])
  const [balanceQuery, setBalanceQuery] = useState('')
  const [draft, setDraft] = useState<MarketInventoryDraft | null>(null)
  const [counting, setCounting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  // false: nenhuma saída pendente. 'back'/'close': qual ação falhou ao tentar
  // salvar (leaveStock vs closeInventory) — o aviso reaproveita o mesmo
  // estado para as duas saídas, então precisa saber qual retomar em "Tentar novamente".
  const [exitBlocked, setExitBlocked] = useState<false | 'back' | 'close'>(false)
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
  const [productIntegrationId, setProductIntegrationId] = useState<string | null>(null)
  const [productSyncRun, setProductSyncRun] = useState<MarketProductSyncRun | null>(null)
  const [lastProductSync, setLastProductSync] = useState<MarketProductSyncRun | null>(null)
  const [productSyncing, setProductSyncing] = useState(false)
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
      try {
        const integrationId = await findAccesysIntegrationId(accountId)
        setProductIntegrationId(integrationId ?? null)
        if (integrationId) {
          const status = await getMarketProductSyncStatus(accountId, integrationId)
          setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
        } else {
          setProductSyncRun(null); setLastProductSync(null)
        }
      } catch (cause) {
        console.error('Falha ao carregar status da sincronizacao de produtos:', cause)
        setProductIntegrationId(null); setProductSyncRun(null); setLastProductSync(null)
      }
    } catch (cause) { console.error('Falha ao carregar estoque:', cause); setError('Não foi possível carregar os dados de estoque.') }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (counting && !confirming) window.setTimeout(() => searchRef.current?.focus(), 0) }, [counting, confirming])

  const selectedStore = context?.access.stores.find((store) => store.id === storeId) ?? null
  const searchResults = useMemo(() => findMarketStockProducts(products ?? [], query).slice(0, 8), [products, query])
  const positiveItems = items.filter((item) => item.quantity > 0)
  const isCycleInventory = draft?.inventoryType === 'cycle'
  // "Contado" nunca inclui item ainda sem quantidade informada (isCounted=false)
  // — positiveItems/items já excluem quantity=0 de outras formas, mas um item
  // não contado também tem quantity=0 por construção; o filtro por isCounted é
  // quem faz a distinção correta entre "zero contado" e "ainda não contado".
  const countedItems = (isCycleInventory ? items : positiveItems).filter((item) => item.isCounted)
  const uncountedItems = items.filter((item) => !item.isCounted)
  const balanceByProduct = useMemo(() => new Map(balance.map((row) => [row.productId, row.quantityOnHand])), [balance])
  // Divergência com saldo conhecido exige motivo — nunca decidido por
  // isCycleInventory/inventoryType (ver requiresDivergenceReason). Só avalia
  // item já contado: item ainda não contado já é bloqueado por outra regra.
  const itemsNeedingReason = items.filter((item) =>
    item.isCounted && requiresDivergenceReason(compareStockCount(balanceByProduct, item.productId, item.quantity), item.isCounted) && isReasonMissing(item))
  const filteredBalance = useMemo(() => findMarketStockBalance(balance, balanceQuery), [balance, balanceQuery])
  const cycleSummary = useMemo(() => items.filter((item) => item.isCounted).reduce((summary, item) => {
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
    setStoreId(nextStoreId); setQuery(''); setBalanceQuery(''); setSuccess(''); setError(''); setLoading(true)
    try { await applyStoreData(nextStoreId, context) }
    catch (cause) { console.error('Falha ao consultar estoque:', cause); setError('Não foi possível consultar este local.') }
    finally { setLoading(false) }
  }

  const startDraft = async () => {
    if (!selectedStore || saving) return
    setSaving(true); setError('')
    try {
      // O catálogo completo só é carregado quando a contagem realmente começa.
      const nextProducts = products ?? await listActiveProducts(accountId)
      if (!products) setProducts(nextProducts)
      const nextStartedAt = initialDateTime()
      setStartedAt(nextStartedAt); startedAtRef.current = nextStartedAt
      const created = await saveMarketInventoryDraft(selectedStore.id, null, null, new Date(nextStartedAt).toISOString(), [])
      setCurrentDraft(created); setItems([]); setSaveState('saved'); setCounting(true)
    } catch (cause) {
      console.error('Falha ao iniciar rascunho:', cause)
      setError(isVersionConflict(cause) ? 'Já existe um inventário em andamento neste local. Recarregue para continuar.' : 'Não foi possível iniciar o inventário.')
    } finally { setSaving(false) }
  }

  const resumeDraft = async () => {
    if (!draft || saving) return
    setSaving(true); setError('')
    try {
      // Busca e scanner continuam usando o catálogo em memória durante a contagem.
      const nextProducts = products ?? await listActiveProducts(accountId)
      if (!products) setProducts(nextProducts)
      // Saneia o rascunho retomado: motivo salvo antes desta regra (ou cujo
      // saldo mudou desde o último save) pode estar incoerente com o sentido
      // atual da diferença — reasonNeedsReset decide com o mesmo critério
      // usado ao editar a quantidade. Zero e compatível ficam preservados.
      let sanitized = false
      const nextItems = draft.items.map((item) => {
        const comparison = compareStockCount(balanceByProduct, item.productId, item.quantity)
        if (!reasonNeedsReset(item.reasonCode, comparison, item.isCounted)) return item
        sanitized = true
        return { ...item, reasonCode: null, reasonNote: null }
      })
      setItems(nextItems); itemsRef.current = nextItems; setStartedAt(toLocalDateTime(draft.startedAt))
      startedAtRef.current = toLocalDateTime(draft.startedAt); setSaveState('saved'); setCounting(true)
      // A limpeza precisa ser persistida (autosave) — não deixar reason_code
      // incoerente sobrevivendo no rascunho salvo só porque nada mais mudou.
      if (sanitized) markChanged(); else dirtyRef.current = false
    } catch (cause) {
      console.error('Falha ao carregar produtos para continuar o inventário:', cause)
      setError('Não foi possível carregar o catálogo para continuar o inventário.')
    } finally { setSaving(false) }
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
    // Produto recém-incluído entra "não contado" (não confundir com contado
    // como zero) — o operador ainda precisa informar a quantidade física,
    // qualquer que seja a origem (busca, EAN/GTIN, SKU/código externo, scanner).
    const next = [{ productId: product.id, quantity: 0, isCounted: false, reasonCode: null, reasonNote: null }, ...itemsRef.current]
    itemsRef.current = next; setItems(next); markChanged(); setHighlightedProductId(product.id)
    if (focusQuantity) focusExistingItem(product.id)
    else window.setTimeout(() => { setHighlightedProductId(''); searchRef.current?.focus() }, 500)
  }

  const changeSearch = (value: string) => {
    const exactProduct = findExactMarketStockProduct(products ?? [], value)
    if (exactProduct) { selectProduct(exactProduct, true); return }
    setQuery(value)
  }

  const handleScannedCode = (code: string) => {
    setScannerOpen(false); setError('')
    const loadedProducts = products ?? []
    const exactProduct = findExactMarketStockProduct(loadedProducts, code)
    if (exactProduct) { selectProduct(exactProduct, true); return }
    const matches = findMarketStockProducts(loadedProducts, code)
    setQuery(code)
    setError(matches.length
      ? 'Este código corresponde a mais de um produto. Escolha o item correto na lista.'
      : `Código ${code} não encontrado. Você pode continuar pela busca manual.`)
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }

  // Qualquer número válido informado, inclusive zero, marca isCounted=true —
  // zero é uma contagem real e consciente, diferente de "ainda não contado".
  // Motivo já selecionado é reavaliado contra a NOVA quantidade: diferença
  // zerada ou motivo incoerente com o novo sentido são limpos aqui mesmo
  // (reasonNeedsReset), nunca deixando um motivo "em espera" inválido.
  const updateQuantity = (productId: string, quantity: number) => {
    const safeQuantity = Number.isFinite(quantity) ? Math.max(0, quantity) : 0
    const next = itemsRef.current.map((item) => {
      if (item.productId !== productId) return item
      const comparison = compareStockCount(balanceByProduct, productId, safeQuantity)
      const resetReason = reasonNeedsReset(item.reasonCode, comparison, true)
      return { ...item, quantity: safeQuantity, isCounted: true, reasonCode: resetReason ? null : item.reasonCode, reasonNote: resetReason ? null : item.reasonNote }
    })
    itemsRef.current = next; setItems(next); markChanged()
  }

  // Campo de quantidade apagado pelo operador: volta para "não contado" (não
  // deixa um "0 contado" residual apenas por ter limpado o campo). Sem
  // contagem não há divergência a justificar — motivo sempre limpo junto.
  const clearQuantity = (productId: string) => {
    const next = itemsRef.current.map((item) => item.productId === productId ? { ...item, quantity: 0, isCounted: false, reasonCode: null, reasonNote: null } : item)
    itemsRef.current = next; setItems(next); markChanged()
  }

  const updateReasonCode = (productId: string, reasonCode: MarketInventoryReasonCode | null) => {
    const next = itemsRef.current.map((item) => item.productId === productId
      ? { ...item, reasonCode, reasonNote: reasonCode === 'OTHER' ? item.reasonNote : null }
      : item)
    itemsRef.current = next; setItems(next); markChanged()
  }

  const updateReasonNote = (productId: string, reasonNote: string) => {
    const next = itemsRef.current.map((item) => item.productId === productId ? { ...item, reasonNote } : item)
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
      // O frontend já bloqueia estes dois casos antes de chegar aqui (botão
      // desabilitado); a RPC valida de novo por segurança — mensagem amigável
      // cobre o caso raro de o estado ter mudado em outro dispositivo.
      const message = String(cause instanceof Error ? cause.message : cause)
      setError(
        isVersionConflict(cause) ? 'Este inventário foi atualizado em outro dispositivo. Recarregue para continuar.'
        : message.includes('INVENTORY_UNCOUNTED_ITEMS') ? 'Ainda existem produtos sem contagem informada.'
        : message.includes('INVENTORY_REASON_REQUIRED') ? 'Existem divergências de saldo sem motivo informado.'
        : message.includes('INVENTORY_REASON_SIGN_MISMATCH') ? 'Existem motivos de divergência incompatíveis com o sentido do ajuste (entrada ou saída).'
        : 'Não foi possível finalizar o inventário.'
      )
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
      if (!await persistDraft()) { setExitBlocked('back'); return }
    }
    onBack()
  }

  // "Fechar inventário": sai da contagem sem finalizar (sem RPC, sem
  // movimento, sem tocar no saldo) e sem apagar o rascunho — mesmo autosave
  // de sempre garante que a última alteração já está salva antes de sair.
  // Volta para a tela de Estoque do mesmo local (não sai do módulo, ao
  // contrário de leaveStock): counting=false + draft preenchido já reexibe
  // sozinho o card "Inventário em andamento" com "Continuar inventário".
  const closeInventory = async () => {
    if (dirtyRef.current) {
      if (!await persistDraft()) { setExitBlocked('close'); return }
    }
    setCounting(false); setConfirming(false)
  }

  const syncProducts = async () => {
    if (!productIntegrationId || productSyncing || context?.access.role === 'viewer') return
    setProductSyncing(true); setError(''); setSuccess('')
    try {
      const run = await synchronizeMarketProducts(accountId, productIntegrationId, 'inventory', productSyncRun, setProductSyncRun)
      if (run.status !== 'completed') throw new Error(run.errorMessage || 'Sincronizacao nao concluida.')
      const status = await getMarketProductSyncStatus(accountId, productIntegrationId)
      setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
      setProducts(null)
      setSuccess('Catalogo de produtos sincronizado com sucesso.')
    } catch (cause) {
      console.error('Falha ao sincronizar produtos no inventario:', cause)
      setError('Nao foi possivel sincronizar os produtos. O catalogo existente foi preservado.')
      try {
        const status = await getMarketProductSyncStatus(accountId, productIntegrationId)
        setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
      } catch { /* Mantem o ultimo estado confiavel carregado. */ }
    } finally { setProductSyncing(false) }
  }

  if (loading && !context) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando estoque...</div>
  if (!context) return <div className="admin-message is-error" role="alert"><p>{error || 'Estoque indisponível.'}</p><button className="button button-small button-outline" onClick={onBack}>Voltar</button></div>

  return <div className="market-stock-dashboard">
    {!counting && <section className="market-product-sync-card"><div><span className="panel-kicker">CATÁLOGO</span><h2>Última sincronização de produtos</h2><p>{lastProductSync?.finishedAt ? formatProductSyncDate(lastProductSync.finishedAt) : 'Nenhuma sincronização de produtos concluída.'}</p>{lastProductSync && <small>{number.format(lastProductSync.receivedCount)} produtos sincronizados</small>}{productSyncing && productSyncRun && <small>Página {productSyncRun.currentPage}{productSyncRun.totalPages ? ` de ${productSyncRun.totalPages}` : ''}</small>}</div>{context.access.role !== 'viewer' && <button className="button button-small" disabled={!productIntegrationId || productSyncing} onClick={() => void syncProducts()}><RefreshCw size={15} /> {productSyncing ? 'Sincronizando...' : productSyncRun?.status === 'running' ? 'Continuar sincronização' : 'Sincronizar produtos'}</button>}</section>}
    <button className="button button-small button-outline" onClick={() => void leaveStock()}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-import-header market-stock-header"><p className="eyebrow"><Boxes size={16} /> GiroMicro Market</p><h1>Estoque</h1><p>Conte os produtos direto pelo celular, sem sair da tela.</p></header>
    <div className="market-dashboard-filter"><label htmlFor="market-stock-store">Local de estoque</label><select id="market-stock-store" value={storeId} onChange={(event) => void changeStore(event.target.value)} disabled={loading || counting}><option value="">Selecione um local</option>{context.access.stores.map((store) => <option key={store.id} value={store.id}>{store.store_type === 'warehouse' ? 'Galpão' : 'Loja'} — {store.external_code ? `${store.external_code} — ` : ''}{store.name}</option>)}</select>{selectedStore && <span>{selectedStore.name}</span>}</div>
    {error && <div className="admin-message is-error" role="alert">{error}</div>}
    {success && <div className="admin-message" role="status"><CheckCircle2 size={18} /> {success}</div>}
    {exitBlocked && <div className="market-draft-warning" role="alert"><p>Não foi possível salvar as últimas alterações. Continue nesta tela para não perder a contagem.</p><div><button className="button button-small button-outline" onClick={() => setExitBlocked(false)}>Continuar na tela</button><button className="button button-small" onClick={() => { const pending = exitBlocked; setExitBlocked(false); void (pending === 'close' ? closeInventory() : leaveStock()) }}>Tentar novamente</button></div></div>}
    {saveState === 'conflict' && <div className="market-draft-warning" role="alert"><p>Este inventário foi atualizado em outro dispositivo. Recarregue para continuar.</p><button className="button button-small" onClick={() => void load(storeId)}>Recarregar rascunho</button></div>}

    {selectedStore && !selectedStore.stock_control_started_at && !counting && !draft && <section className="market-stock-start market-stock-welcome"><Boxes size={34} /><div><span className="panel-kicker">ESTOQUE</span><h2>Controle de estoque ainda não iniciado</h2><p>Faça uma contagem rápida dos produtos que estão neste local agora.</p></div>{context.canStart ? <button className="button market-stock-primary-action" disabled={saving} onClick={() => void startDraft()}>{saving ? 'Iniciando...' : 'Iniciar inventário'}</button> : <div className="admin-message">Seu perfil possui acesso somente para visualização.</div>}</section>}

    {selectedStore && !counting && draft && <section className="market-stock-start market-stock-welcome"><RefreshCw size={34} /><div><span className="panel-kicker">{draft.inventoryType === 'cycle' ? 'CONFERÊNCIA SALVA' : 'RASCUNHO SALVO'}</span><h2>Inventário em andamento</h2><p>{draft.items.length} {draft.items.length === 1 ? 'produto contado' : 'produtos contados'} · última atualização {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(draft.updatedAt))}</p></div>{context.canStart ? <div className="market-draft-actions"><button className="button" disabled={saving} onClick={() => void resumeDraft()}>{saving ? 'Carregando...' : 'Continuar inventário'}</button><button className="button button-outline" onClick={() => setConfirmCancel(true)}>Cancelar inventário</button></div> : <div className="admin-message">Seu perfil permite apenas visualizar este rascunho.</div>}{confirmCancel && <div className="market-inventory-confirm"><div><strong>Cancelar este rascunho?</strong><p>Nenhum movimento de estoque será criado.</p></div><div><button className="button button-outline" onClick={() => setConfirmCancel(false)}>Voltar</button><button className="button" disabled={saving} onClick={() => void cancelDraft()}>{saving ? 'Cancelando...' : 'Confirmar cancelamento'}</button></div></div>}</section>}

    {selectedStore && counting && draft && <section className="market-quick-inventory">
      <header className="market-quick-heading"><div><span className="panel-kicker">{isCycleInventory ? 'CONFERÊNCIA DE ESTOQUE' : 'INVENTÁRIO RÁPIDO'}</span><h2>{selectedStore.name}</h2></div><div className={`market-draft-status ${saveState}`}><strong>{countedItems.length} {countedItems.length === 1 ? 'produto contado' : 'produtos contados'}</strong><small>{saveState === 'saving' ? 'Salvando...' : saveState === 'saved' ? 'Rascunho salvo' : saveState === 'error' ? 'Não foi possível salvar' : saveState === 'conflict' ? 'Conflito em outro dispositivo' : 'Alterações locais'}</small></div></header>
      <div className="market-product-search"><Search size={23} /><input ref={searchRef} type="search" inputMode="search" autoComplete="off" placeholder="Buscar por nome, EAN, código externo ou SKU" value={query} onChange={(event) => changeSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && searchResults[0]) { event.preventDefault(); selectProduct(searchResults[0]) } }} /><button className="market-scanner-button" type="button" onClick={() => setScannerOpen(true)} aria-label="Escanear código de barras"><ScanBarcode /></button><small>EAN, código externo ou SKU exato entra automaticamente. Para nomes, pressione Enter ou escolha o produto.</small></div>
      {query && <div className="market-product-results" role="listbox">{searchResults.length ? searchResults.map((product) => <button key={product.id} type="button" onClick={() => selectProduct(product)}><span><strong>{product.name}</strong><small>{productIdentifier(product)}</small></span></button>) : <p>Nenhum produto encontrado.</p>}</div>}
      <div className="market-counted-products">{items.length ? items.map((item) => {
        const product = products?.find((candidate) => candidate.id === item.productId)
        if (!product) return null
        // Mesma comparação para qualquer origem do item (draft já carregado,
        // busca por nome, EAN/GTIN, código externo/SKU ou scanner): todas
        // resolvem productId e passam por balanceByProduct, a mesma Map já
        // usada acima. "known: false" (nunca movimentou neste local) nunca
        // vira "Saldo 0" silenciosamente — mostra o estado explícito abaixo.
        const comparison = compareStockCount(balanceByProduct, item.productId, item.quantity)
        const needsReason = requiresDivergenceReason(comparison, item.isCounted)
        const balanceLabel = comparison.known ? number.format(comparison.currentQuantity) : 'não registrado'
        const countedLabel = item.isCounted ? number.format(comparison.countedQuantity) : '—'
        const showDifference = item.isCounted && comparison.known
        const differenceLabel = showDifference ? `${comparison.difference > 0 ? '+' : ''}${number.format(comparison.difference)}` : '—'
        const differenceClass = showDifference ? (comparison.difference > 0 ? 'is-positive' : comparison.difference < 0 ? 'is-negative' : '') : ''
        return <article ref={(element) => { itemRefs.current[item.productId] = element }} className={`${item.isCounted && item.quantity === 0 && !isCycleInventory ? 'is-zero ' : ''}${highlightedProductId === item.productId ? 'is-highlighted' : ''}`} key={item.productId}>
          <div className="market-counted-product-name"><strong>{product.name}</strong><small>{productIdentifier(product)}</small>{(isCycleInventory || comparison.known) && <span className="market-stock-comparison">Saldo {balanceLabel} · Contagem {countedLabel} · <b className={differenceClass}>Diferença {differenceLabel}</b></span>}</div>
          <div className="market-quantity-stepper">
            {/* "-" em item não contado fica desabilitado: não há de onde
                decrementar ainda, e decidir sozinho "0 contado" via minus
                seria confuso (minus implica reduzir um número existente). */}
            <button type="button" aria-label={`Diminuir quantidade de ${product.name}`} disabled={!item.isCounted} onClick={() => updateQuantity(item.productId, item.quantity - 1)}><Minus /></button>
            <input aria-label={`Quantidade contada de ${product.name}`} ref={(element) => { quantityRefs.current[item.productId] = element }} type="number" min="0" step="0.001" inputMode="decimal" placeholder="—"
              value={item.isCounted ? item.quantity : ''}
              onChange={(event) => { const raw = event.target.value; if (raw.trim() === '') clearQuantity(item.productId); else updateQuantity(item.productId, Number(raw)) }}
              onKeyDown={finishQuantity} onFocus={(event) => event.target.select()} />
            {/* "+" em item não contado inicia em 1 e já marca contado. */}
            <button type="button" aria-label={`Aumentar quantidade de ${product.name}`} onClick={() => updateQuantity(item.productId, (item.isCounted ? item.quantity : 0) + 1)}><Plus /></button>
          </div>
          {item.isCounted && item.quantity === 0 && <small className="market-zero-note">{isCycleInventory ? 'Contado = 0. Este produto será reconciliado com saldo zero.' : 'Quantidade zero: não será persistida nem enviada.'}</small>}
          {needsReason && <div className="market-stock-reason">
            <label>Motivo da divergência
              <select value={item.reasonCode ?? ''} onChange={(event) => updateReasonCode(item.productId, (event.target.value || null) as MarketInventoryReasonCode | null)}>
                <option value="">Selecione o motivo</option>
                {reasonCodes.filter((code) => isReasonCodeAllowedForDifference(code, comparison.difference)).map((code) => <option key={code} value={code}>{reasonLabels[code]}</option>)}
              </select>
            </label>
            {item.reasonCode === 'OTHER' && <label>Observação
              <input value={item.reasonNote ?? ''} onChange={(event) => updateReasonNote(item.productId, event.target.value)} placeholder="Descreva o motivo" />
            </label>}
          </div>}
          {isCycleInventory && <button className="market-remove-counted" type="button" onClick={() => removeCountedProduct(item.productId)}><Trash2 size={15} /> Remover da contagem</button>}
        </article>
      }) : <div className="market-inventory-empty"><Search size={25} /><p>Busque o primeiro produto para começar.</p></div>}</div>
      <label className="market-stock-start-date">{isCycleInventory ? 'Data e hora da conferência' : 'Data e hora do marco inicial'}<input type="datetime-local" value={startedAt} onChange={(event) => { setStartedAt(event.target.value); startedAtRef.current = event.target.value; markChanged() }} /></label>
      {saveState === 'error' && <button className="button button-small button-outline" onClick={() => void persistDraft()}>Tentar salvar novamente</button>}
      {/* Bloqueio duplo (regra 3/4): também validado no backend
          (market_finalize_inventory_draft), para não depender só da UI. */}
      {!confirming && (uncountedItems.length > 0 || itemsNeedingReason.length > 0) && <div className="market-inventory-block-note" role="status">
        {uncountedItems.length > 0 && <p>Ainda existem produtos sem contagem informada.</p>}
        {itemsNeedingReason.length > 0 && <p>Existem divergências de saldo sem motivo informado.</p>}
      </div>}
      {!confirming ? <div className="market-inventory-finish"><span>{countedItems.length} {countedItems.length === 1 ? (isCycleInventory ? 'produto será reconciliado' : 'produto será enviado') : (isCycleInventory ? 'produtos serão reconciliados' : 'produtos serão enviados')}</span><button className="button button-outline" disabled={saveState === 'conflict'} onClick={() => void closeInventory()}>Fechar inventário</button><button className="button" disabled={!countedItems.length || !startedAt || saveState === 'conflict' || uncountedItems.length > 0 || itemsNeedingReason.length > 0} onClick={() => setConfirming(true)}>Finalizar inventário</button></div> : <div className="market-inventory-confirm"><div><span className="panel-kicker">CONFIRMAR INVENTÁRIO</span><h3>{selectedStore.name}</h3>{isCycleInventory ? <div className="market-cycle-summary"><p><strong>{items.length}</strong> produtos contados</p><p><strong>{cycleSummary.adjustmentInProducts}</strong> ajustes de entrada · {number.format(cycleSummary.adjustmentInQuantity)} unidades</p><p><strong>{cycleSummary.adjustmentOutProducts}</strong> ajustes de saída · {number.format(cycleSummary.adjustmentOutQuantity)} unidades</p><p><strong>{cycleSummary.unchangedProducts}</strong> sem diferença</p></div> : <p>{positiveItems.length} {positiveItems.length === 1 ? 'produto contado' : 'produtos contados'} · marco em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(startedAt))}</p>}</div><div><button className="button button-outline" disabled={saving} onClick={() => setConfirming(false)}>Continuar inventário</button><button className="button" disabled={saving} onClick={() => void finalizeDraft()}>{saving ? 'Finalizando...' : isCycleInventory ? 'Confirmar inventário' : 'Confirmar e iniciar estoque'}</button></div></div>}
    </section>}

    {selectedStore?.stock_control_started_at && !counting && <section className="market-stock-balance">
      <div><span className="panel-kicker">SALDO ATUAL</span><h2>Controle de estoque iniciado</h2><p>Marco inicial: {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(selectedStore.stock_control_started_at))}</p></div>
      {!draft && context.canStart && <button className="button market-stock-primary-action" disabled={saving} onClick={() => void startDraft()}>{saving ? 'Iniciando...' : 'Novo inventário'}</button>}
      {balance.length > 0 && <label className="market-stock-balance-search">
        <Search size={16} /><span className="sr-only">Buscar saldo por descrição ou EAN/GTIN</span>
        <input type="search" inputMode="search" autoComplete="off" placeholder="Buscar por descrição ou EAN/GTIN" value={balanceQuery} onChange={(event) => setBalanceQuery(event.target.value)} />
      </label>}
      {!balance.length
        ? <div className="admin-message">Ainda não há saldo registrado para este local.</div>
        : filteredBalance.length
          ? <div className="market-preview-table-wrap"><table className="market-preview-table market-stock-table"><thead><tr><th>Produto</th><th>Identificador</th><th>Quantidade atual</th></tr></thead><tbody>{filteredBalance.map((row) => { const product = products?.find((candidate) => candidate.id === row.productId); return <tr key={`${row.marketStoreId}:${row.productId}`}><td>{row.productName}</td><td>{product ? productIdentifier(product) : row.ean || row.sku || '—'}</td><td><strong>{number.format(row.quantityOnHand)} {row.unit}</strong></td></tr> })}</tbody></table></div>
          : <div className="admin-message">Nenhum produto encontrado para "{balanceQuery}".</div>}
    </section>}
    {scannerOpen && <BarcodeScanner onDetected={handleScannedCode} onClose={() => { setScannerOpen(false); window.setTimeout(() => searchRef.current?.focus(), 0) }} />}
  </div>
}
