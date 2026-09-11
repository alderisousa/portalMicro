import {
  ArrowLeft, CheckCircle2, ChevronDown, PackagePlus, PackageSearch, RefreshCw,
  ScanBarcode, Search, ShoppingCart, Trash2, Truck, X,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  addMarketReplenishmentOrderManualItem,
  approveMarketReplenishmentOrder,
  cancelMarketReplenishmentOrderItemReview,
  generateMarketReplenishmentOrderDraft,
  getMarketReplenishmentOrder,
  getMarketReplenishmentOverview,
  updateMarketReplenishmentOrderItemQuantity,
} from '../services/marketReplenishment'
import { searchCatalogProducts } from '../services/marketReconciliation'
import { translateReplenishmentTriggerReason } from '../utils/marketReplenishment'
import type { MarketStore } from '../types/market'
import type {
  MarketReplenishmentOrderDetail,
  MarketReplenishmentOrderItem,
  MarketReplenishmentOrderStatus,
  MarketReplenishmentOverview,
  MarketReplenishmentPriorityLevel,
} from '../types/marketReplenishment'
import type { CatalogSearchResult } from '../types/marketReconciliation'

interface Props { accountId: string; stores: MarketStore[]; onBack: () => void }

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

const priorityLevelLabels: Record<MarketReplenishmentPriorityLevel, string> = {
  critical: 'Crítico', high: 'Alto', medium: 'Médio', low: 'Baixo',
}

const orderStatusLabels: Record<MarketReplenishmentOrderStatus, string> = {
  draft: 'Rascunho',
  approved: 'Aprovada',
  purchasing: 'Em compra',
  separating: 'Em separação',
  dispatched: 'Despachada',
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
const formatAvgDailyM7 = (value: number | null) => value === null ? '-' : number.format(value)
const formatOrderQuantity = (value: number | null) => value === null ? 'Não calculada' : number.format(value)
const formatAllocationQuantity = (value: number | null) => value === null ? 'Revisão pendente' : number.format(value)

function hasManualReviewPending(item: MarketReplenishmentOrderItem): boolean {
  return item.allocations.some((allocation) => allocation.suggestedQuantity === null)
}

function hasOnlyPendingNeed(item: MarketReplenishmentOrderItem): boolean {
  return hasManualReviewPending(item)
    && item.adjustedPurchaseQuantity === null
    && item.suggestedPurchaseQuantity === 0
    && item.totalSuggestedQuantity === 0
}

function formatOrderTotalNeed(item: MarketReplenishmentOrderItem): string {
  return hasOnlyPendingNeed(item) ? 'Revisão pendente' : formatOrderQuantity(item.totalSuggestedQuantity)
}

function formatOrderEffective(item: MarketReplenishmentOrderItem): string {
  return hasOnlyPendingNeed(item) ? 'Não calculada' : formatOrderQuantity(item.effectivePurchaseQuantity)
}

function revisedQuantityInputValue(item: MarketReplenishmentOrderItem, inputs: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(inputs, item.id)) return inputs[item.id]
  return item.adjustedPurchaseQuantity === null ? '' : String(item.adjustedPurchaseQuantity)
}

function parseQuantity(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (!normalized) return null
  const parsed = Number(normalized)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function friendlyReviewError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (message.includes('REPLENISHMENT_ORDER_NOT_DRAFT')) return 'A lista já saiu de rascunho. Atualize a leitura antes de revisar.'
  if (message.includes('REPLENISHMENT_ORDER_DUPLICATE_PRODUCT')) return 'Este produto já existe na lista.'
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
  const [quantityInputs, setQuantityInputs] = useState<Record<string, string>>({})
  const [savingItemId, setSavingItemId] = useState('')
  const [reviewMessage, setReviewMessage] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualQuery, setManualQuery] = useState('')
  const [manualSearching, setManualSearching] = useState(false)
  const [manualResults, setManualResults] = useState<CatalogSearchResult[]>([])
  const [manualSelected, setManualSelected] = useState<CatalogSearchResult | null>(null)
  const [manualQuantity, setManualQuantity] = useState('')
  const [manualError, setManualError] = useState('')
  const [manualSaving, setManualSaving] = useState(false)
  const [confirmCancelItem, setConfirmCancelItem] = useState<MarketReplenishmentOrderItem | null>(null)
  const [approveConfirm, setApproveConfirm] = useState(false)
  const [approving, setApproving] = useState(false)
  const [orderPriorityFilter, setOrderPriorityFilter] = useState<OrderPriorityFilter>('all')

  const isDraftOrder = orderDetail?.order.status === 'draft'
  const visibleOrderItems = useMemo(
    () => (orderDetail?.items ?? []).filter((item) => item.status !== 'cancelled'),
    [orderDetail],
  )
  const filteredOrderItems = useMemo(
    () => visibleOrderItems.filter((item) => orderPriorityFilter === 'all' || itemPriorityFilter(item) === orderPriorityFilter),
    [orderPriorityFilter, visibleOrderItems],
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
    setQuantityInputs({})
    setConfirmCancelItem(null)
    setApproveConfirm(false)
  }

  async function openPurchaseList(): Promise<void> {
    setOrderLoading(true)
    setOrderError('')
    setReviewMessage('')
    try {
      const orderId = await generateMarketReplenishmentOrderDraft(accountId)
      const result = await getMarketReplenishmentOrder(accountId, orderId)
      setOrderDetail(result)
      setQuantityInputs({})
    } catch (cause) {
      console.error('Falha ao abrir Lista de Compras:', cause)
      setOrderError('Não foi possível abrir a Lista de Compras.')
    } finally {
      setOrderLoading(false)
    }
  }

  async function saveQuantity(item: MarketReplenishmentOrderItem): Promise<void> {
    if (!orderDetail) return
    if (!Object.prototype.hasOwnProperty.call(quantityInputs, item.id)) return
    const raw = quantityInputs[item.id]
    if (raw.trim() === '') {
      setQuantityInputs((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
      return
    }
    const quantity = parseQuantity(raw)
    if (quantity === null) {
      setReviewMessage('Informe uma quantidade válida para salvar a revisão.')
      return
    }
    if (item.adjustedPurchaseQuantity !== null && quantity === item.adjustedPurchaseQuantity) {
      setQuantityInputs((current) => {
        const next = { ...current }
        delete next[item.id]
        return next
      })
      return
    }
    setSavingItemId(item.id)
    setReviewMessage('')
    try {
      await updateMarketReplenishmentOrderItemQuantity(accountId, orderDetail.order.id, item.id, quantity)
      await reloadOrder(orderDetail.order.id)
      setReviewMessage('Quantidade revisada salva.')
    } catch (cause) {
      console.error('Falha ao ajustar item da lista:', cause)
      setReviewMessage(friendlyReviewError(cause))
    } finally {
      setSavingItemId('')
    }
  }

  async function searchManualProducts(): Promise<void> {
    const query = manualQuery.trim()
    if (query.length < 2) {
      setManualError('Digite ao menos 2 caracteres para buscar.')
      return
    }
    setManualSearching(true)
    setManualError('')
    try {
      const results = await searchCatalogProducts(accountId, query, 10)
      setManualResults(results)
      if (!results.length) setManualError('Nenhum produto ativo encontrado.')
    } catch (cause) {
      console.error('Falha ao buscar produtos para inclusão manual:', cause)
      setManualError('Não foi possível buscar produtos no catálogo.')
    } finally {
      setManualSearching(false)
    }
  }

  async function addManualItem(): Promise<void> {
    if (!orderDetail || !manualSelected) return
    const quantity = parseQuantity(manualQuantity)
    if (quantity === null) {
      setManualError('Informe uma quantidade válida para incluir.')
      return
    }
    setManualSaving(true)
    setManualError('')
    try {
      await addMarketReplenishmentOrderManualItem(accountId, orderDetail.order.id, manualSelected.productId, quantity)
      await reloadOrder(orderDetail.order.id)
      setManualOpen(false)
      setManualQuery('')
      setManualResults([])
      setManualSelected(null)
      setManualQuantity('')
      setReviewMessage('Produto incluído na revisão.')
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
  if (error) return <div className="admin-message is-error" role="alert"><p>{error}</p><button className="button button-small button-outline" onClick={onBack}>Voltar</button></div>

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
        <div><span className="panel-kicker">LISTA DE COMPRAS</span><h2>Compras consolidadas</h2><p>Gera ou reutiliza o rascunho do último batch efetivo e mantém a necessidade original como referência.</p></div>
        <button className="button" type="button" onClick={openPurchaseList} disabled={orderLoading}>
          {orderLoading ? <RefreshCw size={16} /> : <ShoppingCart size={16} />}
          {orderDetail ? 'Atualizar lista' : 'Abrir Lista de Compras'}
        </button>
      </section>
      {orderError && <div className="admin-message is-error" role="alert">{orderError}</div>}
      {orderDetail && <section className="market-replenishment-order-panel">
        <div className="market-replenishment-order-heading">
          <div><span className="panel-kicker">LISTA CONSOLIDADA</span><h2>{visibleOrderItems.length} itens</h2></div>
          <div className="market-replenishment-order-actions">
            <span className={`market-row-status ${orderDetail.order.status}`}>{orderStatusLabels[orderDetail.order.status]}</span>
            {isDraftOrder && !approveConfirm && <button className="button button-small" type="button" onClick={() => setApproveConfirm(true)}><CheckCircle2 size={16} /> Aprovar lista</button>}
          </div>
        </div>
        {!isDraftOrder && <p className="market-replenishment-readonly-note">Lista somente leitura. As ações de revisão ficam disponíveis apenas enquanto o status é rascunho.</p>}
        {approveConfirm && isDraftOrder && <div className="market-replenishment-confirm">
          <span>Aprovar esta lista e encerrar a revisão?</span>
          <button className="button button-small" type="button" onClick={approveOrder} disabled={approving}>{approving ? <RefreshCw size={14} /> : <CheckCircle2 size={14} />} Confirmar</button>
          <button className="button button-small button-outline" type="button" onClick={() => setApproveConfirm(false)} disabled={approving}>Cancelar</button>
        </div>}
        {reviewMessage && <p className="market-replenishment-order-note">{reviewMessage}</p>}
        {isDraftOrder && <div className="market-replenishment-manual">
          <button className="button button-small button-outline" type="button" onClick={() => setManualOpen((open) => !open)}>
            {manualOpen ? <X size={16} /> : <PackagePlus size={16} />} {manualOpen ? 'Fechar inclusão' : 'Adicionar produto'}
          </button>
          {manualOpen && <div className="market-replenishment-manual-box">
            <div className="market-replenishment-manual-search">
              <label><span>Produto do catálogo</span><input value={manualQuery} onChange={(event) => setManualQuery(event.target.value)} placeholder="Nome, SKU ou EAN" /></label>
              <button className="button button-small button-outline" type="button" onClick={searchManualProducts} disabled={manualSearching}>
                {manualSearching ? <RefreshCw size={14} /> : <Search size={14} />} Buscar
              </button>
            </div>
            {!!manualResults.length && <div className="market-replenishment-manual-results">
              {manualResults.map((product) => {
                const duplicate = existingProductIds.has(product.productId)
                return <button key={product.productId} type="button" disabled={duplicate} className={manualSelected?.productId === product.productId ? 'is-selected' : ''} onClick={() => setManualSelected(product)}>
                  <strong>{product.name}</strong><span>{product.ean ? `EAN ${product.ean}` : 'Sem EAN'} · {duplicate ? 'já está na lista' : product.unit}</span>
                </button>
              })}
            </div>}
            {manualSelected && <div className="market-replenishment-manual-selected">
              <strong>{manualSelected.name}</strong>
              <label><span>Quantidade</span><input inputMode="decimal" value={manualQuantity} onChange={(event) => setManualQuantity(event.target.value)} placeholder="0" /></label>
              <button className="button button-small" type="button" onClick={addManualItem} disabled={manualSaving}>{manualSaving ? <RefreshCw size={14} /> : <PackagePlus size={14} />} Incluir</button>
            </div>}
            {manualError && <p className="market-replenishment-order-note">{manualError}</p>}
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
            const inputValue = revisedQuantityInputValue(item, quantityInputs)
            return <article key={item.id} className={`market-replenishment-order-item${item.status === 'cancelled' ? ' is-cancelled' : ''}`}>
              <div className="market-replenishment-order-item-top">
                <div className="market-replenishment-order-product">
                  <strong>{item.productName}</strong>
                  <span>{item.ean ? `EAN ${item.ean}` : 'Sem EAN'} · {item.unit} · origem {item.source === 'manual_review' ? 'revisão manual' : 'batch'}</span>
                </div>
                <div className="market-replenishment-item-actions">
                  <span className={`market-row-status ${item.priority.prioritySort === 1 ? 'critical' : item.priority.prioritySort === 2 ? 'high' : item.priority.prioritySort === 3 ? 'medium' : 'low'}`}>
                    {itemPriorityLabel(item)}
                  </span>
                  {isDraftOrder && item.status !== 'cancelled' && <button className="market-replenishment-icon-button" type="button" aria-label={`Retirar ${item.productName} da lista`} onClick={() => setConfirmCancelItem(item)}><Trash2 size={16} /></button>}
                </div>
              </div>
              <dl className="market-replenishment-order-metrics">
                <div><dt>Necessidade total</dt><dd>{formatOrderTotalNeed(item)}</dd></div>
                <div><dt>Compra efetiva</dt><dd>{formatOrderEffective(item)}</dd></div>
                <div><dt>Quantidade revisada</dt><dd className={item.adjustedPurchaseQuantity === null ? 'is-muted' : undefined}>{item.adjustedPurchaseQuantity === null ? '-' : number.format(item.adjustedPurchaseQuantity)}</dd></div>
                <div><dt>Galpão</dt><dd>{formatWarehouseStock(item.warehouseStockSnapshot)}</dd></div>
                <div><dt>Último fornecedor</dt><dd className={item.lastSupplier ? undefined : 'is-muted'}>{item.lastSupplier?.supplierName ?? 'Sem histórico'}</dd></div>
              </dl>
              {isDraftOrder && item.status !== 'cancelled' && <div className="market-replenishment-quantity-edit">
                <span className="market-replenishment-quantity-label">Quantidade revisada</span>
                <input className="market-replenishment-quantity-input" aria-label={`Quantidade revisada de ${item.productName}`} type="number" min="0" step="0.001" inputMode="decimal" value={inputValue} onChange={(event) => setQuantityInputs((current) => ({ ...current, [item.id]: event.target.value }))} onFocus={(event) => event.target.select()} onBlur={() => void saveQuantity(item)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} disabled={savingItemId === item.id} placeholder="-" />
                {savingItemId === item.id && <span className="market-replenishment-quantity-saving"><RefreshCw size={13} /> Salvando</span>}
              </div>}
              {hasManualReviewPending(item) && <div className="market-replenishment-unknown-note">
                {item.allocations.filter((allocation) => allocation.suggestedQuantity === null).map((allocation) => {
                  const candidate = allocation.candidateId ? candidateById.get(allocation.candidateId) : null
                  return <div key={allocation.id}>
                    <strong>{allocation.storeName}</strong>
                    <span>Motivo: {candidate?.triggerReasons.length ? candidate.triggerReasons.map((reason) => translateReplenishmentTriggerReason(reason)).join(', ') : 'revisão manual necessária'}</span>
                    <span>Estoque da loja: {candidate ? formatKnownStock(candidate.currentStock) : 'não conhecido'}</span>
                    <span>Média 7 dias: {candidate?.avgDailyM7 === null || !candidate ? 'não conhecida' : `${number.format(candidate.avgDailyM7)} un./dia`}</span>
                  </div>
                })}
              </div>}
              {confirmCancelItem?.id === item.id && <div className="market-replenishment-confirm">
                <span>Retirar este item da revisão?</span>
                <button className="button button-small" type="button" onClick={() => cancelItem(item)} disabled={savingItemId === item.id}>Confirmar</button>
                <button className="button button-small button-outline" type="button" onClick={() => setConfirmCancelItem(null)} disabled={savingItemId === item.id}>Cancelar</button>
              </div>}
              <div className="market-replenishment-order-allocations">
                {item.allocations.length ? item.allocations.map((allocation) => <article key={allocation.id}>
                  <strong>{allocation.storeName}</strong>
                  <dl>
                    <div><dt>Necessidade</dt><dd className={allocation.suggestedQuantity === null ? 'is-muted' : undefined}>{formatAllocationQuantity(allocation.suggestedQuantity)}</dd></div>
                    <div><dt>Do Galpão</dt><dd className={allocation.warehouseAllocatedQuantity === null ? 'is-muted' : undefined}>{formatAllocationQuantity(allocation.warehouseAllocatedQuantity)}</dd></div>
                    <div><dt>Comprar</dt><dd className={allocation.purchaseNeededQuantity === null ? 'is-muted' : undefined}>{formatAllocationQuantity(allocation.purchaseNeededQuantity)}</dd></div>
                  </dl>
                </article>) : <article><strong>Consolidado</strong><span>Inclusão manual sem loja definida</span></article>}
              </div>
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
  </div>
}
