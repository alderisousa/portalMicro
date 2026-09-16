import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { getReplenishmentOrderHistory, getReplenishmentOrderHistoryDetail } from '../services/marketReplenishment'
import type { ReplenishmentOrderHistoryItem, ReplenishmentOrderHistorySummary } from '../types/marketReplenishment'

interface Props { accountId: string }
const format = (value: number | null) => value === null ? 'A definir' : new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(value)
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' })

type ItemFilter = 'pending' | 'processed' | 'all'
const itemFilters: Array<{ value: ItemFilter; label: string }> = [
  { value: 'pending', label: 'Pendentes' },
  { value: 'processed', label: 'Processados' },
  { value: 'all', label: 'Todos' },
]

const situationLabels: Record<ReplenishmentOrderHistorySummary['situation'], string> = { partial: 'Parcial', completed: 'Concluída', closed: 'Encerrada', closed_with_pending: 'Encerrada com pendências' }

// Histórico é sobre listas/ordens, não produtos soltos: mostra primeiro a
// relação de ordens (data de entrada, total/processado/pendente, situação);
// ao abrir uma ordem, mostra suas necessidades (produto x loja) com filtro
// Pendentes/Processados/Todos. "Processado" exige entrega Galpão->Loja
// efetiva — status comercial "comprado"/"completed" da ordem não é
// suficiente (ver market_get_replenishment_order_history, 202609150002).
// O Histórico é por LISTA/ORDEM e mostra o resumo/detalhe completo da lista:
// nunca herda a loja selecionada na área operacional de Abastecimento
// (contextStoreId de MarketReplenishment.tsx). Se um filtro de loja próprio
// for adicionado aqui no futuro, ele deve ser um estado explícito desta tela.
export function ReplenishmentHistory({ accountId }: Props) {
  const [orders, setOrders] = useState<ReplenishmentOrderHistorySummary[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [ordersMessage, setOrdersMessage] = useState('')
  const [selectedOrder, setSelectedOrder] = useState<ReplenishmentOrderHistorySummary | null>(null)
  const [items, setItems] = useState<ReplenishmentOrderHistoryItem[]>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const [itemsMessage, setItemsMessage] = useState('')
  const [itemFilter, setItemFilter] = useState<ItemFilter>('pending')
  const generation = useRef(0)

  const reloadOrders = useCallback(async () => {
    const ticket = ++generation.current
    setOrdersLoading(true)
    setOrdersMessage('')
    try {
      const result = await getReplenishmentOrderHistory(accountId, null)
      if (ticket === generation.current) setOrders(result)
    } catch (error) {
      console.error('Falha ao carregar histórico de listas:', error)
      if (ticket === generation.current) setOrdersMessage('Não foi possível carregar o histórico. Tente novamente.')
    } finally {
      if (ticket === generation.current) setOrdersLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    setSelectedOrder(null)
    void reloadOrders()
    return () => { generation.current++ }
  }, [reloadOrders])

  async function openOrder(order: ReplenishmentOrderHistorySummary): Promise<void> {
    setSelectedOrder(order)
    setItemsLoading(true)
    setItemsMessage('')
    setItemFilter(order.pendingItems > 0 ? 'pending' : 'all')
    try {
      const result = await getReplenishmentOrderHistoryDetail(accountId, order.id, null)
      setItems(result)
    } catch (error) {
      console.error('Falha ao carregar itens da lista:', error)
      setItemsMessage('Não foi possível carregar os itens desta lista. Tente novamente.')
    } finally {
      setItemsLoading(false)
    }
  }

  const filteredItems = items.filter((item) => itemFilter === 'all' || item.status === itemFilter)

  if (selectedOrder) {
    return <section className="market-replenishment-order-panel market-replenishment-history-panel" aria-label="Itens da lista">
      <div className="market-replenishment-order-actions">
        <button className="button button-small button-outline" type="button" onClick={() => setSelectedOrder(null)}><ArrowLeft size={16} /> Voltar às listas</button>
        <span className={`market-row-status ${selectedOrder.situation}`}>{situationLabels[selectedOrder.situation]}</span>
      </div>
      <div className="market-replenishment-order-heading"><h2>Lista de {dateFormat.format(new Date(selectedOrder.approvedAt ?? selectedOrder.createdAt))}</h2></div>
      <p>{selectedOrder.processedItems} de {selectedOrder.totalItems} necessidades já entregues à loja · {selectedOrder.pendingItems} pendentes.</p>
      {selectedOrder.status === 'closed' && <p>Encerrada em {selectedOrder.closedAt ? dateFormat.format(new Date(selectedOrder.closedAt)) : '—'}{selectedOrder.closureReason ? ` · Motivo: ${selectedOrder.closureReason}` : ''}. Quantidades registradas no encerramento.</p>}
      <div className="market-replenishment-filter-tabs" role="group" aria-label="Filtrar itens da lista">
        {itemFilters.map((filter) => <button key={filter.value} type="button" className={itemFilter === filter.value ? 'is-active' : ''} onClick={() => setItemFilter(filter.value)}>{filter.label}</button>)}
      </div>
      {itemsMessage && <p role="alert">{itemsMessage}</p>}
      {itemsLoading ? <p role="status">Carregando itens...</p> : <>
        {!filteredItems.length && <p>Nenhum item neste filtro.</p>}
        {filteredItems.map((item) => <article key={item.allocationId} className="market-replenishment-order-item market-replenishment-purchase-card">
          <h3>{item.productName}</h3>
          {'orderStatus' in item && item.orderStatus === 'closed' ? <>
            <p>{item.storeName} · Planejado: {format(item.targetQuantity)}</p>
            <p>Processado: {format(item.processedQuantity)}</p>
            <p>Pronto para abastecer ao encerrar: {format(item.readyToSupplyQuantity)}</p>
            <p>Aguardando entrada ao encerrar: {format(item.awaitingReceiptQuantity)}</p>
            <p>Ainda para comprar ao encerrar: {format(item.stillToBuyQuantity)}</p>
          </> : <p>{item.storeName} · {item.status === 'processed' ? 'Processado' : 'Aguardando entrada'}: {format(item.deliveredQuantity)} de {format(item.targetQuantity)}</p>}
        </article>)}
      </>}
    </section>
  }

  return <section className="market-replenishment-order-panel market-replenishment-history-panel" aria-label="Histórico de Reposição">
    <div className="market-replenishment-order-actions">
      <h2>Histórico</h2>
      <button className="button button-small button-outline" disabled={ordersLoading} onClick={() => void reloadOrders()}>Atualizar</button>
    </div>
    <p>Listas de reposição aprovadas, em andamento, concluídas ou encerradas, com o quanto já foi efetivamente entregue às lojas.</p>
    {ordersMessage && <p role="alert">{ordersMessage}</p>}
    {ordersLoading ? <p role="status">Carregando histórico...</p> : <>
      {!orders.length && <p>Nenhuma lista aprovada neste filtro.</p>}
      {orders.map((order) => <div key={order.id}>
        <button type="button" className="market-purchase-card-header market-replenishment-history-order" onClick={() => void openOrder(order)}>
          <div className="market-purchase-card-main"><strong>Lista de {dateFormat.format(new Date(order.approvedAt ?? order.createdAt))}</strong><span>{order.totalItems} {order.totalItems === 1 ? 'necessidade' : 'necessidades'}</span></div>
          <dl className="market-purchase-card-stats">
            <div><dt>Processadas</dt><dd>{order.processedItems}</dd></div>
            <div><dt>Pendentes</dt><dd>{order.pendingItems}</dd></div>
          </dl>
          <span className={`market-row-status ${order.situation}`}>{situationLabels[order.situation]}</span>
        </button>
      </div>)}
    </>}
  </section>
}
