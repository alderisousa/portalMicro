import {
  ArrowLeft, CheckCircle2, ChevronDown, PackagePlus, PackageSearch, RefreshCw,
  ScanBarcode, Search, ShoppingCart, Trash2, Truck, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addMarketReplenishmentOrderManualItem,
  approveMarketReplenishmentOrder,
  cancelMarketReplenishmentOrderItemReview,
  generateMarketReplenishmentOrderDraft,
  getMarketReplenishmentOrder,
  getMarketReplenishmentOverview,
  updateMarketReplenishmentAllocationReview,
} from '../services/marketReplenishment'
import { listActiveProducts } from '../services/marketStock'
import { findMarketStockProducts, findExactMarketStockProduct } from './MarketStockDashboard'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { translateReplenishmentTriggerReason } from '../utils/marketReplenishment'
import type { MarketStore } from '../types/market'
import type {
  MarketReplenishmentOrderDetail,
  MarketReplenishmentOrderAllocation,
  MarketReplenishmentOrderItem,
  MarketReplenishmentOrderStatus,
  MarketReplenishmentOverview,
  MarketReplenishmentPriorityLevel,
} from '../types/marketReplenishment'
import type { MarketStockProduct } from '../types/marketStock'

interface Props { accountId: string; stores: MarketStore[]; onBack: () => void }

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const dailyAverage = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

const priorityLevelLabels: Record<MarketReplenishmentPriorityLevel, string> = {
  critical: 'Crítico', high: 'Alto', medium: 'Médio', low: 'Baixo',
}

const orderStatusLabels: Record<MarketReplenishmentOrderStatus, string> = {
  draft: 'Rascunho',
  approved: 'Aprovada',
  in_progress: 'Em andamento',
  completed: 'Concluída',
  cancelled: 'Cancelada',
}

type OrderPriorityFilter = 'critical' | 'high' | 'medium' | 'all'

const orderPriorityFilters: Array<{ value: OrderPriorityFilter; label: string }> = [
  { value: 'critical', label: 'Crítico' },
  { value: 'high', label: 'Alto' },
  { value: 'medium', label: 'Médio' },
  { value: 'all', label: 'Todos' },
]

const formatKnownStock = (value: number | null) => value === null ? 'Saldo não conhecido' : number.format(value)
const formatMinimumStock = (value: number | null) => value === null ? 'Não configurado' : number.format(value)
const formatCoverageDays = (value: number | null) => value === null ? '-' : `${number.format(value)} dias`
const formatSuggestedQuantity = (value: number | null) => value === null ? 'A definir' : number.format(value)
const formatWarehouseStock = (value: number | null) => value === null ? 'Saldo não conhecido' : number.format(value)
const formatAvgDailyM7 = (value: number | null) => value === null ? '-' : dailyAverage.format(value)
const formatAllocationQuantity = (value: number | null) => value === null ? 'Revisão pendente' : number.format(value)

type AllocationInputs = { warehouse: string; purchase: string }

const allocationNeed = (allocation: MarketReplenishmentOrderAllocation) => allocation.adjustedQuantity ?? allocation.suggestedQuantity
const activeAllocations = (item: MarketReplenishmentOrderItem) => item.allocations.filter((allocation) => allocation.status !== 'cancelled' && allocation.priorityLevel !== 'low')
const sumKnown = (values: Array<number | null>): number | null => values.length && values.every((value) => value !== null) ? values.reduce<number>((sum, value) => sum + (value as number), 0) : null
const hasManualReviewPending = (item: MarketReplenishmentOrderItem) => activeAllocations(item).some((allocation) => allocationNeed(allocation) === null)
const formatOrderTotalNeed = (item: MarketReplenishmentOrderItem) => formatAllocationQuantity(sumKnown(activeAllocations(item).map(allocationNeed)))
const formatOrderEffective = (item: MarketReplenishmentOrderItem) => formatAllocationQuantity(sumKnown(activeAllocations(item).map((allocation) => allocation.purchaseNeededQuantity)))
const allocationInputValues = (allocation: MarketReplenishmentOrderAllocation): AllocationInputs => ({
  warehouse: allocation.warehouseAllocatedQuantity === null ? '' : String(allocation.warehouseAllocatedQuantity),
  purchase: allocation.purchaseNeededQuantity === null ? '' : String(allocation.purchaseNeededQuantity),
})
const operationalQuantity = (value: string) => {
  const parsed = parseQuantity(value)
  return parsed === null ? null : Math.ceil(parsed)
}

function normalizedQuantityInput(value: string): string {
  const quantity = operationalQuantity(value)
  return quantity === null ? value.trim() : String(quantity)
}

function parseQuantity(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function friendlyReviewError(cause: unknown): string {
  const message = cause && typeof cause === 'object' && 'message' in cause ? String(cause.message) : String(cause)
  if (message.includes('REPLENISHMENT_ORDER_ALLOCATION_REQUIRED')) return 'Existe item sem loja de destino. Na Consolidada, localize e remova o item legado antes de aprovar.'
  if (message.includes('REPLENISHMENT_ORDER_REVIEW_PENDING')) return 'Há quantidade desconhecida ou pendente. Revise Do Galpão e Comprar em cada loja.'
  if (message.includes('REPLENISHMENT_ORDER_ALLOCATION_REVIEW_REQUIRED') || message.includes('source_split_check') || message.includes('REPLENISHMENT_ORDER_TARGET_MISMATCH')) return 'A decomposição da necessidade está inconsistente. Revise Do Galpão e Comprar nas lojas.'
  if (message.includes('REPLENISHMENT_ORDER_NO_OPERATION')) return 'A lista não tem quantidade positiva para repor ou comprar. Revise as quantidades antes de aprovar.'
  if (message.includes('REPLENISHMENT_ORDER_WAREHOUSE_EXCEEDED')) return 'A quantidade do Galpão ultrapassa o saldo disponível para este produto na lista.'
  if (message.includes('REPLENISHMENT_ORDER_NOT_DRAFT')) return 'A lista já saiu de rascunho. Atualize a leitura antes de revisar.'
  if (message.includes('REPLENISHMENT_ORDER_DUPLICATE_PRODUCT')) return 'Este produto já existe na lista.'
  if (message.includes('REPLENISHMENT_ORDER_STORE_UNAVAILABLE')) return 'Loja indisponível para inclusão.'
  if (message.includes('REPLENISHMENT_ORDER_PRODUCT_UNAVAILABLE')) return 'Produto não encontrado ou inativo no catálogo.'
  if (message.includes('REPLENISHMENT_ORDER_INVALID_QUANTITY')) return 'Informe uma quantidade válida, maior ou igual a zero.'
  if (message.includes('REPLENISHMENT_ORDER_PERMISSION_DENIED')) return 'Seu perfil não pode revisar esta lista.'
  return 'Não foi possível concluir a revisão da lista.'
}

function itemPriorityFilter(item: MarketReplenishmentOrderItem): OrderPriorityFilter {
  if (item.priority.prioritySort === 1) return 'critical'
  if (item.priority.prioritySort === 2) return 'high'
  if (item.priority.prioritySort === 3) return 'medium'
  return 'all'
}

function itemPriorityLabel(item: MarketReplenishmentOrderItem): string {
  if (item.priority.prioritySort === 1) return 'Crítico'
  if (item.priority.prioritySort === 2) return 'Alto'
  if (item.priority.prioritySort === 3) return 'Médio'
  return 'Baixo'
}

export function MarketReplenishment({ accountId, stores, onBack }: Props) {
  const [overview, setOverview] = useState<MarketReplenishmentOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedStoreId, setExpandedStoreId] = useState('')
  const [orderDetail, setOrderDetail] = useState<MarketReplenishmentOrderDetail | null>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderError, setOrderError] = useState('')
  const [quantityInputs, setQuantityInputs] = useState<Record<string, AllocationInputs>>({})
  const quantityInputsRef = useRef<Record<string, AllocationInputs>>({})
  const [allocationErrors, setAllocationErrors] = useState<Record<string, string>>({})
  const [savingAllocations, setSavingAllocations] = useState<Record<string, boolean>>({})
  const pendingSaves = useRef(new Map<string, Promise<boolean>>())
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const [savingItemId, setSavingItemId] = useState('')
  const [reviewMessage, setReviewMessage] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualQuery, setManualQuery] = useState('')
  const [manualSearching, setManualSearching] = useState(false)
  const [manualCatalog, setManualCatalog] = useState<{ accountId: string; products: MarketStockProduct[] } | null>(null)
  const [manualScannerOpen, setManualScannerOpen] = useState(false)
  const manualSearchRef = useRef<HTMLInputElement>(null)
  const manualQuantityRef = useRef<HTMLInputElement>(null)
  const manualProducts = manualCatalog?.accountId === accountId ? manualCatalog.products : []
  const manualResults = useMemo(() => findMarketStockProducts(manualProducts, manualQuery).slice(0, 8), [manualProducts, manualQuery])
  const [manualSelected, setManualSelected] = useState<MarketStockProduct | null>(null)
  const [manualQuantity, setManualQuantity] = useState('')
  const [manualError, setManualError] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  const [confirmCancelItem, setConfirmCancelItem] = useState<MarketReplenishmentOrderItem | null>(null)
  const [approveConfirm, setApproveConfirm] = useState(false)
  const [approving, setApproving] = useState(false)
  const [orderPriorityFilter, setOrderPriorityFilter] = useState<OrderPriorityFilter>('all')
  const [selectedStoreId, setSelectedStoreId] = useState('')

  const isDraftOrder = orderDetail?.order.status === 'draft'
  const visibleOrderItems = useMemo(
    () => (orderDetail?.items ?? []).filter((item) => item.status !== 'cancelled'),
    [orderDetail],
  )
  const orderStores = useMemo(() => {
    const names = new Map<string, string>()
    for (const item of visibleOrderItems) {
      for (const allocation of item.allocations) {
        if (allocation.status !== 'cancelled' && allocation.priorityLevel !== 'low') names.set(allocation.storeId, allocation.storeName)
      }
    }
    return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  }, [visibleOrderItems])
  const contextStoreId = orderStores.some((store) => store.id === selectedStoreId) ? selectedStoreId : ''
  const contextOrderItems = useMemo(
    () => contextStoreId ? visibleOrderItems.filter((item) => item.allocations.some((allocation) => allocation.storeId === contextStoreId && allocation.status !== 'cancelled' && allocation.priorityLevel !== 'low')) : visibleOrderItems,
    [contextStoreId, visibleOrderItems],
  )
  const filteredOrderItems = useMemo(
    () => contextOrderItems.filter((item) => orderPriorityFilter === 'all' || (contextStoreId
      ? item.allocations.some((allocation) => allocation.storeId === contextStoreId && allocation.status !== 'cancelled' && allocation.priorityLevel === orderPriorityFilter)
      : itemPriorityFilter(item) === orderPriorityFilter)),
    [orderPriorityFilter, contextOrderItems, contextStoreId],
  )
  const candidateById = useMemo(() => {
    const candidates = new Map<string, NonNullable<MarketReplenishmentOverview['stores'][number]['candidates'][number]>>()
    for (const store of overview?.stores ?? []) {
      for (const candidate of store.candidates) candidates.set(candidate.id, candidate)
    }
    return candidates
  }, [overview])
  const remainingOrderItems = filteredOrderItems.filter((item) => item.status !== 'fulfilled').length
  const existingProductIds = useMemo(
    () => new Set(visibleOrderItems.map((item) => item.productId)),
    [visibleOrderItems],
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void getMarketReplenishmentOverview(accountId, stores)
      .then((result) => { if (active) setOverview(result) })
      .catch((cause) => {
        console.error('Falha ao carregar Abastecimento:', cause)
        if (active) setError('Não foi possível carregar os dados de Abastecimento.')
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [accountId, stores])

  async function reloadOrder(orderId = orderDetail?.order.id): Promise<void> {
    if (!orderId) return
    const result = await getMarketReplenishmentOrder(accountId, orderId)
    setOrderDetail(result)
    setConfirmCancelItem(null)
    setApproveConfirm(false)
  }

  async function openPurchaseList(): Promise<void> {
    if (!await flushAllocationReviews()) return
    setOrderLoading(true)
    setOrderError('')
    setReviewMessage('')
    try {
      const orderId = await generateMarketReplenishmentOrderDraft(accountId)
      const result = await getMarketReplenishmentOrder(accountId, orderId)
      setOrderDetail(result)
    } catch (cause) {
      console.error('Falha ao abrir Lista de Compras:', cause)
      setOrderError('Não foi possível abrir a Lista de Compras.')
    } finally {
      setOrderLoading(false)
    }
  }

  function editAllocation(allocation: MarketReplenishmentOrderAllocation, field: keyof AllocationInputs, value: string): void {
    const next = { ...(quantityInputsRef.current[allocation.id] ?? allocationInputValues(allocation)), [field]: value }
    quantityInputsRef.current = { ...quantityInputsRef.current, [allocation.id]: next }
    setQuantityInputs(quantityInputsRef.current)
  }

  function saveAllocation(allocationId: string): Promise<boolean> {
    const pending = pendingSaves.current.get(allocationId)
    if (pending) return pending
    const inputs = quantityInputsRef.current[allocationId]
    if (!inputs || !orderDetail || !isDraftOrder) return Promise.resolve(true)
    const persistedAllocation = orderDetail.items
      .flatMap((item) => item.allocations)
      .find((allocation) => allocation.id === allocationId)
    if (persistedAllocation) {
      const persistedInputs = allocationInputValues(persistedAllocation)
      if (normalizedQuantityInput(inputs.warehouse) === normalizedQuantityInput(persistedInputs.warehouse)
        && normalizedQuantityInput(inputs.purchase) === normalizedQuantityInput(persistedInputs.purchase)) {
        const next = { ...quantityInputsRef.current }
        delete next[allocationId]
        quantityInputsRef.current = next
        setQuantityInputs(next)
        return Promise.resolve(true)
      }
    }
    const warehouse = operationalQuantity(inputs.warehouse)
    const purchase = operationalQuantity(inputs.purchase)
    if (warehouse === null || purchase === null) {
      setAllocationErrors((current) => ({ ...current, [allocationId]: 'Informe Do Galpão e Comprar. Use zero explicitamente quando não houver quantidade; campo vazio continua desconhecido.' }))
      return Promise.resolve(false)
    }
    const orderId = orderDetail.order.id
    setSavingAllocations((current) => ({ ...current, [allocationId]: true }))
    const task = saveQueue.current.then(async () => {
      try {
        await updateMarketReplenishmentAllocationReview(accountId, orderId, allocationId, warehouse, purchase)
        const result = await getMarketReplenishmentOrder(accountId, orderId)
        if (!result) throw new Error('Lista não encontrada ao atualizar a revisão.')
        setOrderDetail(result)
        if (quantityInputsRef.current[allocationId] === inputs) {
          const next = { ...quantityInputsRef.current }
          delete next[allocationId]
          quantityInputsRef.current = next
          setQuantityInputs(next)
        }
        setAllocationErrors((current) => { const next = { ...current }; delete next[allocationId]; return next })
        return true
      } catch (cause) {
        setAllocationErrors((current) => ({ ...current, [allocationId]: friendlyReviewError(cause) }))
        return false
      } finally {
        pendingSaves.current.delete(allocationId)
        setSavingAllocations((current) => { const next = { ...current }; delete next[allocationId]; return next })
      }
    })
    pendingSaves.current.set(allocationId, task)
    saveQueue.current = task
    return task
  }

  async function flushAllocationReviews(): Promise<boolean> {
    for (const id of Object.keys(quantityInputsRef.current)) {
      if (!await saveAllocation(id)) return false
      // Preserve and save an edit made while its earlier request was pending.
      if (quantityInputsRef.current[id] && !await saveAllocation(id)) return false
    }
    return Object.keys(quantityInputsRef.current).length === 0
  }

  async function leaveReplenishment(): Promise<void> {
    if (await flushAllocationReviews()) onBack()
  }

  useEffect(() => {
    if (!manualOpen || manualCatalog?.accountId === accountId) return
    let active = true
    setManualSearching(true)
    setManualError('')
    void listActiveProducts(accountId).then((products) => {
      if (active) setManualCatalog({ accountId, products })
    }).catch(() => {
      if (active) setManualError('Não foi possível carregar o catálogo. Feche e abra a inclusão para tentar novamente.')
    }).finally(() => { if (active) setManualSearching(false) })
    return () => { active = false }
  }, [manualOpen, accountId, manualCatalog])

  function selectManualProduct(product: MarketStockProduct): void {
    setManualSelected(null)
    setManualQuantity('')
    if (existingProductIds.has(product.id)) {
      setManualError('Este produto já existe na lista. Revise o item existente.')
      return
    }
    setManualError('')
    setManualSelected(product)
    setManualQuery('')
    window.setTimeout(() => manualQuantityRef.current?.focus(), 0)
  }

  function changeManualSearch(value: string): void {
    setManualQuery(value)
    setManualSelected(null)
    setManualQuantity('')
    setManualError('')
    const exact = findExactMarketStockProduct(manualProducts, value)
    if (exact) selectManualProduct(exact)
  }

  function handleManualScannedCode(code: string): void {
    setManualScannerOpen(false)
    changeManualSearch(code)
    if (!findExactMarketStockProduct(manualProducts, code)) {
      setManualError(findMarketStockProducts(manualProducts, code).length
        ? 'Este código corresponde a mais de um produto. Escolha o item correto na lista.'
        : 'Código não encontrado no catálogo. Continue pela busca manual.')
      window.setTimeout(() => manualSearchRef.current?.focus(), 0)
    }
  }

  async function addManualItem(): Promise<void> {
    if (!orderDetail || !manualSelected || !contextStoreId) return
    const quantity = parseQuantity(manualQuantity)
    if (quantity === null) {
      setManualError('Informe uma quantidade válida para incluir.')
      return
    }
    setManualSaving(true)
    setManualError('')
    try {
      await addMarketReplenishmentOrderManualItem(accountId, orderDetail.order.id, manualSelected.id, quantity, contextStoreId)
      await reloadOrder(orderDetail.order.id)
      setManualOpen(false)
      setManualQuery('')
      setManualSelected(null)
      setManualQuantity('')
      setReviewMessage('Produto incluído na loja selecionada.')
    } catch (cause) {
      console.error('Falha ao incluir produto manual:', cause)
      setManualError(friendlyReviewError(cause))
    } finally {
      setManualSaving(false)
    }
  }

  async function cancelItem(item: MarketReplenishmentOrderItem): Promise<void> {
    if (!orderDetail) return
    setSavingItemId(item.id)
    setReviewMessage('')
    try {
      await cancelMarketReplenishmentOrderItemReview(accountId, orderDetail.order.id, item.id)
      await reloadOrder(orderDetail.order.id)
      setReviewMessage('Item retirado da lista.')
    } catch (cause) {
      console.error('Falha ao retirar item da lista:', cause)
      setReviewMessage(friendlyReviewError(cause))
    } finally {
      setSavingItemId('')
    }
  }

  async function approveOrder(): Promise<void> {
    if (!orderDetail) return
    if (!await flushAllocationReviews()) return
    setApproving(true)
    setReviewMessage('')
    try {
      await approveMarketReplenishmentOrder(accountId, orderDetail.order.id)
      await reloadOrder(orderDetail.order.id)
      setReviewMessage('Lista aprovada.')
    } catch (cause) {
      console.error('Falha ao aprovar lista:', cause)
      setReviewMessage(friendlyReviewError(cause))
    } finally {
      setApproving(false)
    }
  }

  if (loading) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando Abastecimento...</div>
  if (error) return <div className="admin-message is-error" role="alert"><p>{error}</p><button className="button button-small button-outline" onClick={() => void leaveReplenishment()}>Voltar</button></div>

  return <div className="market-replenishment-dashboard">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-dashboard-header"><p className="eyebrow"><Truck size={16} /> GiroMicro Market</p><h1>Abastecimento</h1><p>Reposição Inteligente</p></header>

    {!overview?.run ? <div className="market-dashboard-blocked"><PackageSearch /><h2>Nenhuma análise concluída ainda</h2><p>Quando o batch de Reposição Inteligente concluir uma execução para este Market, o resultado aparecerá aqui.</p></div> : <>
      <section className="market-dashboard-section">
        <span className="panel-kicker">ÚLTIMA ANÁLISE</span>
        <div className="market-store-performance"><article><dl>
          <div><dt>Quando</dt><dd>{overview.run.finishedAt ? dateTimeFormat.format(new Date(overview.run.finishedAt)) : '-'}</dd></div>
          <div><dt>Lojas processadas</dt><dd>{overview.run.storesProcessed}</dd></div>
          <div><dt>Produtos selecionados</dt><dd>{overview.run.productsSelected}</dd></div>
          <div><dt>Críticos</dt><dd>{overview.run.criticalCount}</dd></div>
          <div><dt>Altos</dt><dd>{overview.run.highCount}</dd></div>
          <div><dt>Médios</dt><dd>{overview.run.mediumCount}</dd></div>
          <div><dt>Baixos</dt><dd>{overview.run.lowCount}</dd></div>
        </dl></article></div>
      </section>

      <section className="market-replenishment-order-entry" aria-label="Lista de Compras">
        <div><span className="panel-kicker">LISTA DE COMPRAS</span><select className="market-replenishment-context-select" aria-label="Contexto da Lista de Compras" value={contextStoreId} onChange={(event) => { setSelectedStoreId(event.target.value); setManualOpen(false); setManualSelected(null); setManualQuery(''); setManualQuantity(''); setManualError(''); setConfirmCancelItem(null); setApproveConfirm(false) }}>
          <option value="">Consolidada</option>
          {orderStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
        </select><p>Gera ou reutiliza o rascunho do último batch efetivo e mantém a necessidade original como referência.</p></div>
        <button className="button" type="button" onClick={openPurchaseList} disabled={orderLoading}>
          {orderLoading ? <RefreshCw size={16} /> : <ShoppingCart size={16} />}
          {orderDetail ? 'Atualizar lista' : 'Abrir Lista de Compras'}
        </button>
      </section>
      {orderError && <div className="admin-message is-error" role="alert">{orderError}</div>}
      {orderDetail && <section className="market-replenishment-order-panel">
        <div className="market-replenishment-order-heading">
          <div><span className="panel-kicker">{contextStoreId ? orderStores.find((store) => store.id === contextStoreId)?.name : 'LISTA CONSOLIDADA'}</span><h2>{contextOrderItems.length} itens</h2></div>
          <div className="market-replenishment-order-actions">
            <span className={`market-row-status ${orderDetail.order.status}`}>{orderStatusLabels[orderDetail.order.status]}</span>
            {isDraftOrder && !contextStoreId && !approveConfirm && <button className="button button-small" type="button" onClick={() => setApproveConfirm(true)}><CheckCircle2 size={16} /> Aprovar lista</button>}
          </div>
        </div>
        {!isDraftOrder && <p className="market-replenishment-readonly-note">Lista somente leitura. As ações de revisão ficam disponíveis apenas enquanto o status é rascunho.</p>}
        {approveConfirm && isDraftOrder && !contextStoreId && <div className="market-replenishment-confirm">
          <span>Aprovar esta lista e encerrar a revisão?</span>
          <button className="button button-small" type="button" onClick={approveOrder} disabled={approving}>{approving ? <RefreshCw size={14} /> : <CheckCircle2 size={14} />} Confirmar</button>
          <button className="button button-small button-outline" type="button" onClick={() => setApproveConfirm(false)} disabled={approving}>Cancelar</button>
        </div>}
        {contextStoreId && isDraftOrder && <p className="market-replenishment-order-note">A necessidade da loja é a soma de Do Galpão e Comprar. A remoção do produto e a aprovação continuam valendo para toda a lista.</p>}
        {reviewMessage && <p role="status" className="market-replenishment-order-note">{reviewMessage}</p>}
        {Object.keys(allocationErrors).length > 0 && <div role="alert" className="admin-message is-error">{Object.entries(allocationErrors).map(([id, message]) => {
          const allocation = orderDetail.items.flatMap((item) => item.allocations).find((entry) => entry.id === id)
          return <p key={id}>{allocation?.storeName ?? 'Loja'}: {message}</p>
        })}</div>}
        {isDraftOrder && contextStoreId && <div className="market-replenishment-manual">
          <button className="button button-small button-outline" type="button" onClick={() => setManualOpen((open) => !open)}>
            {manualOpen ? <X size={16} /> : <PackagePlus size={16} />} {manualOpen ? 'Fechar inclusão' : 'Adicionar produto'}
          </button>
          {manualOpen && <div className="market-replenishment-manual-box">
            <div className="market-product-search market-replenishment-product-search">
              <Search size={23} />
              <input ref={manualSearchRef} type="search" inputMode="search" autoComplete="off" autoFocus aria-label="Buscar produto do catálogo" placeholder="Nome, EAN, código externo ou SKU" value={manualQuery} disabled={manualSearching || manualCatalog?.accountId !== accountId} onChange={(event) => changeManualSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && manualResults[0]) { event.preventDefault(); selectManualProduct(manualResults[0]) } }} />
              <button className="market-scanner-button" type="button" aria-label="Escanear EAN para adicionar produto" disabled={manualSearching || manualCatalog?.accountId !== accountId} onClick={() => setManualScannerOpen(true)}><ScanBarcode /></button>
              <small>Código exato seleciona o produto. Por nome, escolha um resultado ou pressione Enter.</small>
            </div>
            {manualSearching && <p role="status">Carregando catálogo...</p>}
            {manualQuery.trim() && !manualSearching && <div className="market-product-results">
              {manualResults.length ? manualResults.map((product) => {
                const duplicate = existingProductIds.has(product.id)
                return <button key={product.id} type="button" onClick={() => selectManualProduct(product)}>
                  <span><strong>{product.name}</strong><small>{product.ean ? `EAN ${product.ean}` : product.externalProductCodes[0] || product.externalEans[0] || product.sku || product.unit}{duplicate ? ' · já está na lista' : ''}</small></span>
                </button>
              }) : <p>Nenhum produto encontrado no catálogo.</p>}
            </div>}
            {manualSelected && <div className="market-replenishment-manual-selected">
              <strong>{manualSelected.name}</strong>
              <label><span>Quantidade</span><input ref={manualQuantityRef} inputMode="decimal" value={manualQuantity} onChange={(event) => setManualQuantity(event.target.value)} placeholder="0" /></label>
              <button className="button button-small" type="button" onClick={addManualItem} disabled={manualSaving}>{manualSaving ? <RefreshCw size={14} /> : <PackagePlus size={14} />} Incluir</button>
            </div>}
            {manualError && <p role="status" className="market-replenishment-order-note">{manualError}</p>}
          </div>}
        </div>}
        <div className="market-replenishment-operation-bar" aria-label="Operação da Lista de Compras">
          <div className="market-replenishment-filter-tabs" role="group" aria-label="Filtrar por prioridade">
            {orderPriorityFilters.map((filter) => <button key={filter.value} type="button" className={orderPriorityFilter === filter.value ? 'is-active' : ''} onClick={() => setOrderPriorityFilter(filter.value)}>{filter.label}</button>)}
          </div>
          <strong>{remainingOrderItems} restantes</strong>
          <button className="market-scanner-button" type="button" aria-label="Scanner indisponível nesta etapa" disabled><ScanBarcode size={22} /></button>
        </div>
        <div className="market-replenishment-order-items">
          {!visibleOrderItems.length && <div className="admin-message">Nenhum item ativo nesta lista.</div>}
          {!!visibleOrderItems.length && !filteredOrderItems.length && <div className="admin-message">Nenhum item ativo neste filtro.</div>}
          {filteredOrderItems.map((item) => {
            const allocations = activeAllocations(item).filter((allocation) => !contextStoreId || allocation.storeId === contextStoreId)
            const storeAllocation = contextStoreId ? allocations[0] : undefined
            const priority = storeAllocation ? storeAllocation.priorityLevel : (itemPriorityFilter(item) === 'all' ? 'low' : itemPriorityFilter(item))
            const inputs = storeAllocation ? quantityInputs[storeAllocation.id] ?? allocationInputValues(storeAllocation) : null
            const warehouse = inputs ? operationalQuantity(inputs.warehouse) : null
            const purchase = inputs ? operationalQuantity(inputs.purchase) : null
            const displayedNeed = storeAllocation && quantityInputs[storeAllocation.id] ? (warehouse === null || purchase === null ? null : warehouse + purchase) : storeAllocation ? allocationNeed(storeAllocation) : null
            return <article key={item.id} className={`market-replenishment-order-item${item.status === 'cancelled' ? ' is-cancelled' : ''}`}>
              <div className="market-replenishment-order-item-top">
                <div className="market-replenishment-order-product">
                  <strong>{item.productName}</strong>
                  <span>{item.ean ? `EAN ${item.ean}` : 'Sem EAN'} · {item.unit} · origem {item.source === 'manual_review' ? 'revisão manual' : 'batch'}</span>
                </div>
                <div className="market-replenishment-item-actions">
                  <span className={`market-row-status ${priority ?? ''}`}>
                    {storeAllocation ? (storeAllocation.priorityLevel ? priorityLevelLabels[storeAllocation.priorityLevel] : 'Prioridade não informada') : itemPriorityLabel(item)}
                  </span>
                  {isDraftOrder && item.status !== 'cancelled' && <button className="market-replenishment-icon-button" type="button" aria-label={`Retirar ${item.productName} da lista`} onClick={() => setConfirmCancelItem(item)}><Trash2 size={16} /></button>}
                </div>
              </div>
              <dl className="market-replenishment-order-metrics">
                {storeAllocation ? <>
                  <div><dt>Necessidade da loja</dt><dd>{formatAllocationQuantity(displayedNeed)}</dd></div>
                  <div><dt>Do Galpão</dt><dd>{formatAllocationQuantity(warehouse)}</dd></div>
                  <div><dt>Comprar</dt><dd>{formatAllocationQuantity(purchase)}</dd></div>
                </> : <>
                <div><dt>Necessidade total</dt><dd>{formatOrderTotalNeed(item)}</dd></div>
                <div><dt>Compra efetiva</dt><dd>{formatOrderEffective(item)}</dd></div>
                </>}

                {!storeAllocation && <div><dt>Do Galpão</dt><dd>{formatAllocationQuantity(sumKnown(allocations.map((allocation) => allocation.warehouseAllocatedQuantity)))}</dd></div>}
                <div><dt>Último fornecedor</dt><dd className={item.lastSupplier ? undefined : 'is-muted'}>{item.lastSupplier?.supplierName ?? 'Sem histórico'}</dd></div>
              </dl>
              {isDraftOrder && contextStoreId && storeAllocation && inputs && <div className="market-replenishment-quantity-edit" role="group" aria-label={`Revisar ${item.productName} em ${storeAllocation.storeName}`} onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void saveAllocation(storeAllocation.id)
              }}>
                {(['warehouse', 'purchase'] as const).map((field) => <label key={field}>
                  <span className="market-replenishment-quantity-label">{field === 'warehouse' ? 'Do Galpão' : 'Comprar'}</span>
                  <input className="market-replenishment-quantity-input" aria-label={`${field === 'warehouse' ? 'Do Galpão' : 'Comprar'}: ${item.productName} em ${storeAllocation.storeName}`} type="number" min="0" step="1" inputMode="numeric" value={inputs[field]} onChange={(event) => editAllocation(storeAllocation, field, event.target.value)} onFocus={(event) => event.target.select()} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} disabled={!!savingAllocations[storeAllocation.id] || approving} placeholder="A definir" />
                </label>)}
                {savingAllocations[storeAllocation.id] && <span role="status" className="market-replenishment-quantity-saving"><RefreshCw size={13} /> Salvando</span>}
                {allocationErrors[storeAllocation.id] && <p role="alert" className="market-replenishment-order-note">{allocationErrors[storeAllocation.id]}</p>}
              </div>}
              {(storeAllocation || hasManualReviewPending(item)) && <div className="market-replenishment-unknown-note">
                {allocations.filter((allocation) => contextStoreId || allocationNeed(allocation) === null).map((allocation) => {
                  const candidate = allocation.candidateId ? candidateById.get(allocation.candidateId) : null
                  return <div key={allocation.id}>
                    <strong>{allocation.storeName}</strong>
                    <span>Motivo: {candidate?.triggerReasons.length ? candidate.triggerReasons.map((reason) => translateReplenishmentTriggerReason(reason)).join(', ') : 'revisão manual necessária'}</span>
                    <span>Estoque da loja: {candidate ? formatKnownStock(candidate.currentStock) : 'não conhecido'}</span>
                    <span>Média 7 dias: {candidate?.avgDailyM7 === null || !candidate ? 'não conhecida' : `${formatAvgDailyM7(candidate.avgDailyM7)} un./dia`}</span>
                  </div>
                })}
              </div>}
              {confirmCancelItem?.id === item.id && <div className="market-replenishment-confirm">
                <span>Retirar este item da revisão?</span>
                <button className="button button-small" type="button" onClick={() => cancelItem(item)} disabled={savingItemId === item.id}>Confirmar</button>
                <button className="button button-small button-outline" type="button" onClick={() => setConfirmCancelItem(null)} disabled={savingItemId === item.id}>Cancelar</button>
              </div>}
              {!contextStoreId && <div className="market-replenishment-order-allocations">
                {allocations.length ? allocations.map((allocation) => <article key={allocation.id}>
                  <strong>{allocation.storeName}</strong>
                  <dl>
                    <div><dt>Necessidade</dt><dd className={allocation.suggestedQuantity === null ? 'is-muted' : undefined}>{formatAllocationQuantity(allocationNeed(allocation))}</dd></div>
                    <div><dt>Do Galpão</dt><dd className={allocation.warehouseAllocatedQuantity === null ? 'is-muted' : undefined}>{formatAllocationQuantity(allocation.warehouseAllocatedQuantity)}</dd></div>
                    <div><dt>Comprar</dt><dd className={allocation.purchaseNeededQuantity === null ? 'is-muted' : undefined}>{formatAllocationQuantity(allocation.purchaseNeededQuantity)}</dd></div>
                  </dl>
                </article>) : <article><strong>Consolidado</strong><span>Item legado sem destino. Remova este item durante a revisão para permitir a aprovação.</span></article>}
              </div>}
              {item.reviewCancellationReason && <p className="market-replenishment-order-note">Retirado: {item.reviewCancellationReason}</p>}
            </article>
          })}
        </div>
      </section>}

      <section className="market-dashboard-section">
        <span className="panel-kicker">LOJAS</span>
        <h2>Necessidades por loja</h2>
        {!overview.stores.length ? <div className="admin-message">Nenhum candidato de reposição para as lojas às quais você tem acesso.</div> : overview.stores.map((store) => {
          const expanded = expandedStoreId === store.storeId
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
    {manualScannerOpen && <BarcodeScanner onDetected={handleManualScannedCode} onClose={() => { setManualScannerOpen(false); window.setTimeout(() => manualSearchRef.current?.focus(), 0) }} />}
  </div>
}
