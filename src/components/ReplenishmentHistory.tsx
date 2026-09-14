import { useCallback, useEffect, useRef, useState } from 'react'
import { getReplenishmentDeliveryHistory, getReplenishmentPurchasing } from '../services/marketReplenishment'
import type { ReplenishmentDelivery, ReplenishmentPurchaseLine } from '../types/marketReplenishment'
import { purchaseWorkQueues } from '../utils/replenishmentPurchaseDisplay'

interface Props { accountId: string; storeId: string }
const format = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(value)

// Independente da lista/ordem atual: as duas fontes já sao por conta
// (getReplenishmentPurchasing com orderId=null percorre approved/in_progress/
// completed; getReplenishmentDeliveryHistory nao recebe orderId). Reusa
// purchaseWorkQueues, a mesma derivacao ja usada pela aba de compras.
export function ReplenishmentHistory({ accountId, storeId }: Props) {
  const [history, setHistory] = useState<ReplenishmentPurchaseLine[]>([])
  const [deliveries, setDeliveries] = useState<ReplenishmentDelivery[]>([])
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true)
    setMessage('')
    try {
      const [purchases, deliveryHistory] = await Promise.all([
        getReplenishmentPurchasing(accountId, null),
        getReplenishmentDeliveryHistory(accountId, storeId || null),
      ])
      if (ticket === generation.current) {
        setHistory(purchaseWorkQueues(purchases, storeId).history)
        setDeliveries(deliveryHistory)
      }
    } catch (error) {
      if (ticket === generation.current) setMessage('Não foi possível carregar o histórico. Tente novamente.')
    } finally {
      if (ticket === generation.current) setLoading(false)
    }
  }, [accountId, storeId])
  useEffect(() => {
    void reload()
    return () => { generation.current++ }
  }, [reload])

  return <section className="market-replenishment-order-panel market-replenishment-history-panel" aria-label="Histórico de Reposição">
    <div className="market-replenishment-order-actions">
      <h2>Histórico</h2>
      <button className="button button-small button-outline" disabled={loading} onClick={() => void reload()}>Atualizar</button>
    </div>
    <p>Compras e entregas já realizadas, de qualquer lista aprovada, em andamento ou concluída — independente da lista atual.</p>
    {message && <p role="alert">{message}</p>}
    {loading ? <p role="status">Carregando histórico...</p> : <>
      {!history.length && !deliveries.length && <p>Nenhum fato registrado neste filtro.</p>}
      {history.map(line => <article key={line.id} className="market-replenishment-order-item market-replenishment-purchase-card">
        <h3>{line.productName}</h3><p>Adquirido: {format(line.purchasedQuantity ?? 0)} · Entrada atribuída: {format(line.receivedQuantity)} · Excedente adquirido: {format(Math.max(0,(line.purchasedQuantity ?? 0)-line.targetQuantity))}</p>
        <p>{line.stores.map(s => s.storeName).join(' · ')}</p>
      </article>)}
      {deliveries.map(entry => <article key={entry.id} className="market-replenishment-order-item market-replenishment-purchase-card">
        <h3>{entry.productName}</h3><p>{entry.storeName} · Entregue: {format(entry.quantity)} · Galpão: {entry.sourceStoreName}</p>
      </article>)}
    </>}
  </section>
}
