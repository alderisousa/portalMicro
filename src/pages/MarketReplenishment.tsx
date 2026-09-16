import {
  ArrowLeft, ArrowUp, CheckCircle2, ChevronDown, History, Lock, PackagePlus, PackageSearch, RefreshCw,
  ScanBarcode, Search, ShoppingCart, Trash2, Truck, Unlock, X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addMarketReplenishmentOrderManualItem,
  approveMarketReplenishmentOrder,
  cancelMarketReplenishmentOrderItemReview,
  generateMarketReplenishmentOrderDraft,
  getMarketReplenishmentOrder,
  getMarketReplenishmentOverview,
  releaseMarketReplenishmentOrderStore,
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
import { ReplenishmentPurchasing } from '../components/ReplenishmentPurchasing'
import { ReplenishmentHistory } from '../components/ReplenishmentHistory'
import { ReplenishmentCycleAction } from '../components/ReplenishmentCycleAction'

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
  closed: 'Encerrada',
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
// Do Galpão tem 0 como default operacional quando ainda não há decisão
// persistida: o saldo físico do Galpão é só informação para o operador,
// nunca convertido automaticamente em quantidade "Do Galpão" — o padrão é
// sempre 0, independente de quanto exista disponível. Comprar continua sem
// default: vazio/null é "a definir" e segue exigindo decisão explícita.
const allocationInputValues = (allocation: MarketReplenishmentOrderAllocation): AllocationInputs => ({
  warehouse: allocation.warehouseAllocatedQuantity === null ? '0' : String(allocation.warehouseAllocatedQuantity),
  purchase: allocation.purchaseNeededQuantity === null ? '' : String(allocation.purchaseNeededQuantity),
})
const warehouseInputQuantity = (value: string) => value.trim() === '' ? 0 : operationalQuantity(value)

// Atualizacao local e discreta apos salvar Do Galpao/Comprar: evita
// recarregar a lista inteira do servidor a cada quantidade (o que causava a
// tela "piscar" e perder posicao/scroll/foco). Necessidade total/Compra
// efetiva por item ja sao recalculadas no cliente a partir das allocations
// (formatOrderTotalNeed/formatOrderEffective), entao nenhum campo do item
// precisa ser resincronizado com o servidor so por causa desta edicao.
function withUpdatedAllocation(
  orderDetail: MarketReplenishmentOrderDetail,
  allocationId: string,
  warehouse: number,
  purchase: number,
): MarketReplenishmentOrderDetail {
  return {
    ...orderDetail,
    items: orderDetail.items.map((item) => {
      if (!item.allocations.some((allocation) => allocation.id === allocationId)) return item
      return {
        ...item,
        allocations: item.allocations.map((allocation) => allocation.id === allocationId
          ? { ...allocation, warehouseAllocatedQuantity: warehouse, purchaseNeededQuantity: purchase, adjustedQuantity: warehouse + purchase }
          : allocation),
      }
    }),
  }
}
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
  if (message.includes('REPLENISHMENT_RELEASE_REVIEW_PENDING')) return 'Há quantidade desconhecida ou pendente nesta loja. Revise Do Galpão e Comprar no item destacado.'
  if (message.includes('REPLENISHMENT_RELEASE_WAREHOUSE_EXCEEDED')) return 'Galpão acima do saldo disponível considerando as lojas já liberadas. Ajuste a quantidade.'
  if (message.includes('REPLENISHMENT_ORDER_STORE_NO_ALLOCATIONS')) return 'Esta loja não tem necessidades ativas nesta lista.'
  if (message.includes('REPLENISHMENT_ORDER_STORE_RELEASED')) return 'Esta loja já foi liberada; o plano dela não pode mais ser alterado.'
  if (message.includes('REPLENISHMENT_ORDER_ITEM_PARTIALLY_RELEASED')) return 'Este produto já tem loja liberada; não é mais possível retirar o item inteiro.'
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
  const purchaseListHeader = useRef<HTMLElement>(null)
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
  const [historyOpen, setHistoryOpen] = useState(false)
  const [releaseConfirm, setReleaseConfirm] = useState(false)
  const [releasing, setReleasing] = useState(false)
  const [highlightAllocationId, setHighlightAllocationId] = useState('')

  const isDraftOrder = orderDetail?.order.status === 'draft'
  const orderTerminal = orderDetail?.order.status === 'completed' || orderDetail?.order.status === 'cancelled' || orderDetail?.order.status === 'closed'
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
  // Liberacao progressiva por loja (202609150003): releasedAt por allocation
  // diz quais lojas ja estao operacionalizadas (congeladas) dentro da MESMA
  // ordem consolidada. Nunca deriva isso de allocation.status.
  const releasedStoreIds = useMemo(() => {
    const ids = new Set<string>()
    for (const item of visibleOrderItems) {
      for (const allocation of item.allocations) {
        if (allocation.releasedAt) ids.add(allocation.storeId)
      }
    }
    return ids
  }, [visibleOrderItems])
  const hasPendingStores = orderStores.some((store) => !releasedStoreIds.has(store.id))
  const contextStoreId = orderStores.some((store) => store.id === selectedStoreId) ? selectedStoreId : ''
  const contextStoreReleased = contextStoreId ? releasedStoreIds.has(contextStoreId) : false
  // O que pode ser revisado/editado no contexto atual: rascunho de verdade,
  // ou (com liberacao progressiva) a loja/Consolidada ainda tiver pendencia.
  const contextEditable = isDraftOrder || (contextStoreId ? !contextStoreReleased : hasPendingStores)
  const showReviewPanel = !!orderDetail && !orderTerminal && (isDraftOrder || hasPendingStores || !!contextStoreId)
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

  // Fluxo rápido no celular: ao concluir "Comprar" (Tab/Enter), o foco
  // segue direto para o campo "Do Galpão" do próximo item VISÍVEL que
  // ainda aceita edição (mesmo filtro/loja de contexto), sem depender da
  // ordem natural do DOM (que passaria por botões como "Retirar" entre um
  // item e outro). Preserva scroll/filtro atuais; não navega para fora da
  // lista filtrada.
  function focusNextAllocationField(currentAllocationId: string): void {
    const currentIndex = filteredOrderItems.findIndex((item) => activeAllocations(item).some((allocation) => allocation.id === currentAllocationId))
    for (let i = currentIndex + 1; i < filteredOrderItems.length; i++) {
      const nextAllocation = contextStoreId
        ? activeAllocations(filteredOrderItems[i]).find((allocation) => allocation.storeId === contextStoreId)
        : undefined
      if (nextAllocation && !nextAllocation.releasedAt) {
        const target = document.getElementById(`replenishment-quantity-warehouse-${nextAllocation.id}`)
        if (target) { target.focus(); return }
      }
    }
    // Último item visível: apenas conclui a edição atual (salva via blur).
    ;(document.activeElement as HTMLElement | null)?.blur()
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
    const persistedAllocation = orderDetail?.items
      .flatMap((item) => item.allocations)
      .find((allocation) => allocation.id === allocationId)
    // Editavel em rascunho OU (liberacao progressiva) enquanto a loja da
    // allocation ainda nao foi liberada. Uma loja ja liberada esta
    // congelada — nunca silenciosamente descartada, aqui o input nem
    // deveria existir (inputs some quando a UI marca a allocation como
    // nao editavel), mas o guard fica tambem aqui por segurança.
    if (!inputs || !orderDetail || orderTerminal || (persistedAllocation && !isDraftOrder && persistedAllocation.releasedAt)) return Promise.resolve(true)
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
    const warehouse = warehouseInputQuantity(inputs.warehouse)
    const purchase = operationalQuantity(inputs.purchase)
    if (warehouse === null || purchase === null) {
      // Comprar ainda não informado: preenchimento em andamento, não é
      // erro. Não há nada válido para persistir ainda, e não mostramos
      // mensagem preventiva — a validação real acontece só ao liberar a
      // loja, no backend, que aponta exatamente a allocation pendente.
      return Promise.resolve(true)
    }
    const orderId = orderDetail.order.id
    setSavingAllocations((current) => ({ ...current, [allocationId]: true }))
    const task = saveQueue.current.then(async () => {
      try {
        await updateMarketReplenishmentAllocationReview(accountId, orderId, allocationId, warehouse, purchase)
        setOrderDetail((current) => current ? withUpdatedAllocation(current, allocationId, warehouse, purchase) : current)
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
    // Uma edição local com Comprar ainda vazio (preenchimento em
    // andamento) não é falha de flush — saveAllocation já retorna true
    // sem persistir nada para ela. Só um erro real (retorno false acima)
    // interrompe o fluxo; quem chama (ex.: liberar loja) segue para o
    // backend, cuja própria validação aponta a allocation pendente.
    return true
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

  function releaseErrorDetail(cause: unknown): {
    allocationId?: string; storeId?: string; productId?: string; requestedWarehouse?: number; availableWarehouse?: number
  } | null {
    if (!cause || typeof cause !== 'object' || !('details' in cause)) return null
    const details = (cause as { details?: unknown }).details
    if (typeof details !== 'string' || !details) return null
    try {
      return JSON.parse(details) as { allocationId?: string; storeId?: string; productId?: string; requestedWarehouse?: number; availableWarehouse?: number }
    } catch { return null }
  }

  // REPLENISHMENT_RELEASE_REVIEW_PENDING já devolve o allocationId direto.
  // REPLENISHMENT_RELEASE_WAREHOUSE_EXCEEDED devolve productId/storeId (o
  // saldo de Galpão é checado por produto, consolidando as lojas já
  // liberadas — não existe uma única allocation "culpada"); resolvemos a
  // allocation do produto na loja sendo liberada para reusar a mesma
  // navegação (scroll/destaque/foco) já existente para o outro erro.
  function resolveReleaseErrorAllocationId(
    detail: { allocationId?: string; storeId?: string; productId?: string },
  ): string | null {
    if (detail.allocationId) return detail.allocationId
    if (!detail.productId || !orderDetail) return null
    const storeId = detail.storeId ?? contextStoreId
    const item = orderDetail.items.find((entry) => entry.productId === detail.productId)
    const allocation = item?.allocations.find((entry) => entry.storeId === storeId)
    return allocation?.id ?? null
  }

  async function releaseStore(): Promise<void> {
    if (!orderDetail || !contextStoreId) return
    if (!await flushAllocationReviews()) return
    setReleasing(true)
    setReviewMessage('')
    const storeName = orderStores.find((store) => store.id === contextStoreId)?.name ?? 'Loja'
    try {
      await releaseMarketReplenishmentOrderStore(accountId, orderDetail.order.id, contextStoreId)
      await reloadOrder(orderDetail.order.id)
      setReleaseConfirm(false)
      setReviewMessage(`${storeName} liberada.`)
    } catch (cause) {
      console.error('Falha ao liberar loja:', cause)
      // Backend continua autoridade: so navegamos com o que ele devolve
      // (allocationId direto, ou productId+storeId no caso do saldo de
      // Galpão), sem repetir a regra de validação aqui.
      const detail = releaseErrorDetail(cause)
      const allocationId = detail ? resolveReleaseErrorAllocationId(detail) : null
      if (allocationId) {
        // Mensagem de validação de item vai só no card (nunca solta no
        // cabeçalho): o card já é levado até a tela do operador.
        const cardMessage = detail?.requestedWarehouse !== undefined && detail?.availableWarehouse !== undefined
          ? `Galpão insuficiente: solicitado ${number.format(detail.requestedWarehouse)}, disponível ${number.format(detail.availableWarehouse)}.`
          : friendlyReviewError(cause)
        setAllocationErrors((current) => ({ ...current, [allocationId]: cardMessage }))
        setOrderPriorityFilter('all')
        setHighlightAllocationId(allocationId)
        window.setTimeout(() => {
          document.getElementById(`replenishment-allocation-${allocationId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          window.setTimeout(() => document.getElementById(`replenishment-quantity-warehouse-${allocationId}`)?.focus(), 320)
        }, 0)
        window.setTimeout(() => setHighlightAllocationId(''), 2600)
      } else {
        // Sem item para navegar (erro genérico: permissão, rede, etc.):
        // só aqui faz sentido uma mensagem curta no cabeçalho.
        setReviewMessage(friendlyReviewError(cause))
      }
    } finally {
      setReleasing(false)
    }
  }

  if (loading) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando Abastecimento...</div>
  if (error) return <div className="admin-message is-error" role="alert"><p>{error}</p><button className="button button-small button-outline" onClick={() => void leaveReplenishment()}>Voltar</button></div>

  return <div className="market-replenishment-dashboard">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-dashboard-header">
      <p className="eyebrow"><Truck size={16} /> GiroMicro Market</p>
      <h1>Abastecimento</h1>
      {historyOpen
        ? <button className="button button-small button-outline" type="button" onClick={() => setHistoryOpen(false)}><ArrowLeft size={16} /> Voltar ao abastecimento</button>
        : <p>Reposição Inteligente</p>}
    </header>

    {!overview?.run ? <div className="market-dashboard-blocked"><PackageSearch /><h2>Nenhuma análise concluída ainda</h2><p>Quando o batch de Reposição Inteligente concluir uma execução para este Market, o resultado aparecerá aqui.</p></div>
      : historyOpen ? <ReplenishmentHistory accountId={accountId} /> : <>
      <section className="market-dashboard-section">
        <div className="panel-heading">
          <span className="panel-kicker">ÚLTIMA ANÁLISE</span>
          <button className="button button-small button-outline" type="button" onClick={() => setHistoryOpen(true)}><History size={16} /> Histórico</button>
        </div>
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

      <section ref={purchaseListHeader} className="market-replenishment-order-entry" aria-label="Lista de Compras">
        <div><span className="panel-kicker">LISTA DE COMPRAS</span><select className="market-replenishment-context-select" aria-label="Contexto da Lista de Compras" value={contextStoreId} onChange={(event) => { setSelectedStoreId(event.target.value); setManualOpen(false); setManualSelected(null); setManualQuery(''); setManualQuantity(''); setManualError(''); setConfirmCancelItem(null); setApproveConfirm(false); setReleaseConfirm(false); setHighlightAllocationId('') }}>
          <option value="">Consolidada</option>
          {orderStores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
        </select><p>Gera ou reutiliza o rascunho do último batch efetivo e mantém a necessidade original como referência.</p></div>
        <button className="button" type="button" onClick={openPurchaseList} disabled={orderLoading}>
          {orderLoading ? <RefreshCw size={16} /> : <ShoppingCart size={16} />}
          {orderDetail ? 'Atualizar lista' : 'Abrir Lista de Compras'}
        </button>
      </section>
      {orderError && <div className="admin-message is-error" role="alert">{orderError}</div>}
      {!orderDetail && reviewMessage && <p role="status" className="market-replenishment-order-note">{reviewMessage}</p>}

      {orderDetail?.isStale === true && ['draft', 'approved', 'in_progress'].includes(orderDetail.order.status) && <aside className="market-replenishment-stale-notice" role="status">
        <strong>{orderDetail.order.status === 'in_progress' ? 'Lista em andamento de uma análise anterior' : 'Lista ativa de uma análise anterior'}</strong>
        <p>Esta lista foi criada com base em uma análise anterior e ainda está {orderDetail.order.status === 'in_progress' ? 'em execução' : 'ativa'}. A análise mais recente encontrou {number.format(overview.run.productsSelected)} necessidades, enquanto esta lista contém somente os itens da ordem atual.</p>
        {orderDetail.order.status === 'in_progress' && <p>Você pode concluir esta lista ou encerrar o ciclo para iniciar uma nova análise.</p>}
        <p>Análise mais recente: {number.format(overview.run.productsSelected)} necessidades · Lista atual: {number.format(visibleOrderItems.length)} itens</p>
        {['approved', 'in_progress'].includes(orderDetail.order.status) && <ReplenishmentCycleAction
          key={`${accountId}:${orderDetail.order.id}`} accountId={accountId} orderId={orderDetail.order.id} mode="close"
          disabled={releasing || approving || Object.values(savingAllocations).some(Boolean)}
          onSuccess={async result => {
            if (!result) return
            const [nextOrder, nextOverview] = await Promise.all([
              getMarketReplenishmentOrder(accountId, result.newOrderId), getMarketReplenishmentOverview(accountId, stores),
            ])
            if (!nextOrder) throw new Error('Nova lista indisponível para leitura.')
            setOrderDetail(null); setOverview(nextOverview); setSelectedStoreId('')
            setQuantityInputs({}); quantityInputsRef.current = {}; setAllocationErrors({})
            setOrderPriorityFilter('all'); setConfirmCancelItem(null); setApproveConfirm(false)
            setReleaseConfirm(false); setManualOpen(false); setManualSelected(null); setOrderError('')
            setReviewMessage(`Lista anterior encerrada e nova análise criada. Vendas consolidadas até ${result.referenceDate.split('-').reverse().join('/')}.`)
          }} />}
      </aside>}
      {orderDetail && ['approved', 'in_progress', 'completed'].includes(orderDetail.order.status) && <ReplenishmentPurchasing key={`${accountId}:${orderDetail.order.id}`} accountId={accountId} orderId={orderDetail.order.id} orderDetail={orderDetail} storeId={contextStoreId} editable={orderDetail.order.status !== 'completed'} onChanged={() => reloadOrder(orderDetail.order.id)} />}
      {orderDetail && showReviewPanel && <section className="market-replenishment-order-panel">
        <div className="market-replenishment-order-heading">
          <div>
            <span className="panel-kicker">{contextStoreId ? orderStores.find((store) => store.id === contextStoreId)?.name : 'LISTA CONSOLIDADA'}</span>
            <h2>{contextOrderItems.length} itens</h2>
          </div>
          <div className="market-replenishment-order-actions">
            {contextStoreId && <span className={`market-row-status ${contextStoreReleased ? 'completed' : 'draft'}`}>
              {contextStoreReleased ? <><Lock size={13} /> Liberada</> : <><Unlock size={13} /> Pendente de liberação</>}
            </span>}
            {!contextStoreId && <span className={`market-row-status ${orderDetail.order.status}`}>{orderStatusLabels[orderDetail.order.status]}</span>}
            {isDraftOrder && !contextStoreId && !approveConfirm && <button className="button button-small" type="button" onClick={() => setApproveConfirm(true)}><CheckCircle2 size={16} /> Aprovar lista</button>}
            {contextStoreId && !contextStoreReleased && !releaseConfirm && <button className="button button-small" type="button" onClick={() => setReleaseConfirm(true)}><CheckCircle2 size={16} /> Liberar {orderStores.find((store) => store.id === contextStoreId)?.name}</button>}
            {/* Confirmação compacta e inline: fica na mesma linha de ações
                do cabeçalho (sem virar um bloco novo abaixo dele) e some
                assim que confirmada/cancelada — nunca ocupa a tela. */}
            {contextStoreId && !contextStoreReleased && releaseConfirm && <span className="market-replenishment-inline-confirm">
              <span>Confirmar liberação?</span>
              <button className="button button-small" type="button" onClick={releaseStore} disabled={releasing}>{releasing ? <RefreshCw size={14} /> : <CheckCircle2 size={14} />} Sim</button>
              <button className="button button-small button-outline" type="button" onClick={() => setReleaseConfirm(false)} disabled={releasing}>Não</button>
            </span>}
          </div>
        </div>
        {!contextEditable && <p className="market-replenishment-readonly-note">{contextStoreId ? 'Loja já liberada: os valores desta loja estão congelados e a compra segue pela aba Comprar.' : 'Todas as lojas desta lista já foram liberadas: a revisão consolidada acabou, acompanhe pela aba Comprar.'}</p>}
        {approveConfirm && isDraftOrder && !contextStoreId && <div className="market-replenishment-confirm">
          <span>Aprovar esta lista e encerrar a revisão?</span>
          <button className="button button-small" type="button" onClick={approveOrder} disabled={approving}>{approving ? <RefreshCw size={14} /> : <CheckCircle2 size={14} />} Confirmar</button>
          <button className="button button-small button-outline" type="button" onClick={() => setApproveConfirm(false)} disabled={approving}>Cancelar</button>
        </div>}
        {reviewMessage && <p role="status" className="market-replenishment-order-note">{reviewMessage}</p>}
        {contextEditable && contextStoreId && <div className="market-replenishment-manual">
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
          <div className="market-replenishment-operation-tools">
            <button className="market-scanner-button" type="button" aria-label="Voltar ao topo da lista" title="Voltar ao topo da lista" onClick={() => purchaseListHeader.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ArrowUp size={22} aria-hidden="true" /></button>
            <button className="market-scanner-button" type="button" aria-label="Scanner indisponível nesta etapa" disabled><ScanBarcode size={22} /></button>
          </div>
        </div>
        <div className="market-replenishment-order-items">
          {!visibleOrderItems.length && <div className="admin-message">Nenhum item ativo nesta lista.</div>}
          {!!visibleOrderItems.length && !filteredOrderItems.length && <div className="admin-message">Nenhum item ativo neste filtro.</div>}
          {filteredOrderItems.map((item) => {
            const allocations = activeAllocations(item).filter((allocation) => !contextStoreId || allocation.storeId === contextStoreId)
            const storeAllocation = contextStoreId ? allocations[0] : undefined
            const priority = storeAllocation ? storeAllocation.priorityLevel : (itemPriorityFilter(item) === 'all' ? 'low' : itemPriorityFilter(item))
            const inputs = storeAllocation ? quantityInputs[storeAllocation.id] ?? allocationInputValues(storeAllocation) : null
            const warehouse = inputs ? warehouseInputQuantity(inputs.warehouse) : null
            const purchase = inputs ? operationalQuantity(inputs.purchase) : null
            const displayedNeed = storeAllocation && quantityInputs[storeAllocation.id] ? (warehouse === null || purchase === null ? null : warehouse + purchase) : storeAllocation ? allocationNeed(storeAllocation) : null
            const itemHasReleasedAllocation = item.allocations.some((allocation) => allocation.releasedAt)
            const canCancelItem = !orderTerminal && item.status !== 'cancelled' && !itemHasReleasedAllocation
            return <article key={item.id} id={storeAllocation ? `replenishment-allocation-${storeAllocation.id}` : `replenishment-item-${item.id}`} className={`market-replenishment-order-item${item.status === 'cancelled' ? ' is-cancelled' : ''}${storeAllocation && highlightAllocationId === storeAllocation.id ? ' is-highlighted' : ''}`}>
              <div className="market-replenishment-order-item-top">
                <div className="market-replenishment-order-product">
                  <strong>{item.productName}</strong>
                  <span>{item.ean ? `EAN ${item.ean}` : 'Sem EAN'} · {item.unit} · origem {item.source === 'manual_review' ? 'revisão manual' : 'batch'}</span>
                </div>
                <div className="market-replenishment-item-actions">
                  <span className={`market-row-status ${priority ?? ''}`}>
                    {storeAllocation ? (storeAllocation.priorityLevel ? priorityLevelLabels[storeAllocation.priorityLevel] : 'Prioridade não informada') : itemPriorityLabel(item)}
                  </span>
                  {storeAllocation?.releasedAt && <span className="market-row-status completed"><Lock size={12} /> Liberada</span>}
                  {canCancelItem && <button className="market-replenishment-icon-button" type="button" aria-label={`Retirar ${item.productName} da lista`} onClick={() => setConfirmCancelItem(item)}><Trash2 size={16} /></button>}
                </div>
              </div>
              <dl className="market-replenishment-order-metrics">
                <div><dt>Galpão disponível</dt><dd className={item.warehouseStockSnapshot === null ? 'is-muted' : undefined}>{formatWarehouseStock(item.warehouseStockSnapshot)}</dd></div>
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
              {contextEditable && contextStoreId && storeAllocation && !storeAllocation.releasedAt && inputs && <div className="market-replenishment-quantity-edit" role="group" aria-label={`Revisar ${item.productName} em ${storeAllocation.storeName}`} onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) void saveAllocation(storeAllocation.id)
              }}>
                {(['warehouse', 'purchase'] as const).map((field) => <label key={field}>
                  <span className="market-replenishment-quantity-label">{field === 'warehouse' ? 'Do Galpão' : 'Comprar'}</span>
                  <input id={field === 'warehouse' ? `replenishment-quantity-warehouse-${storeAllocation.id}` : undefined} className="market-replenishment-quantity-input" aria-label={`${field === 'warehouse' ? 'Do Galpão' : 'Comprar'}: ${item.productName} em ${storeAllocation.storeName}`} type="number" min="0" step="1" inputMode="numeric" value={inputs[field]} onChange={(event) => editAllocation(storeAllocation, field, event.target.value)} onFocus={(event) => event.target.select()} onKeyDown={(event) => {
                    // "Comprar" e o ultimo campo do item: Enter conclui a
                    // edicao e ja avanca para o proximo item visivel; Tab
                    // (sem Shift) faz o mesmo em vez de seguir a ordem
                    // natural do DOM (que passaria por botoes como
                    // "Retirar" do proximo card).
                    if (field === 'purchase' && (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey))) {
                      event.preventDefault()
                      focusNextAllocationField(storeAllocation.id)
                      return
                    }
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }} disabled={!!savingAllocations[storeAllocation.id] || approving || releasing} placeholder="A definir" />
                </label>)}
                {savingAllocations[storeAllocation.id] && <span role="status" className="market-replenishment-quantity-saving"><RefreshCw size={13} /> Salvando</span>}
                {allocationErrors[storeAllocation.id] && <p role="alert" className="market-replenishment-order-note">{allocationErrors[storeAllocation.id]}</p>}
              </div>}
              {storeAllocation?.releasedAt && <dl className="market-replenishment-order-metrics">
                <div><dt>Liberada</dt><dd>{dateTimeFormat.format(new Date(storeAllocation.releasedAt))}</dd></div>
              </dl>}
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
                  <strong>{allocation.storeName}{allocation.releasedAt ? ' · Liberada' : ''}</strong>
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
