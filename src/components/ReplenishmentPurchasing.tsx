import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { executeReplenishmentStoreSupply, getReplenishmentPurchasing, getReplenishmentStoreSupply, setReplenishmentPurchased } from '../services/marketReplenishment'
import type { MarketReplenishmentOrderDetail, ReplenishmentPurchaseLine, ReplenishmentSupplyLine } from '../types/marketReplenishment'
import { purchaseWorkQueues } from '../utils/replenishmentPurchaseDisplay'
import { ReplenishmentCycleAction } from './ReplenishmentCycleAction'

interface Props { accountId: string; orderId: string; storeId: string; editable: boolean; orderDetail: MarketReplenishmentOrderDetail; onChanged?: () => Promise<void>; initialView?: View; onViewChange?: (view: View) => void }
type View = 'buy' | 'waiting' | 'supply'
const format = (value: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 }).format(value)
// Sentinela para "Sem sugestão" no filtro de fornecedor: nunca colide com um
// nome real de fornecedor, que é sempre uma string não vazia (ver filtro abaixo).
const NO_SUPPLIER_FILTER = '__no_supplier__'
function friendlyError(error: unknown) {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  if (message.includes('VERSION_CONFLICT')) return 'A compra foi alterada em outro dispositivo. Atualize antes de salvar.'
  if (message.includes('PHYSICALLY_COMMITTED')) return 'Essa quantidade já possui recebimento atribuído ou abastecimento. Corrija somente a quantidade ainda livre.'
  if (message.includes('CORRECTION_ACTIVE_ORDER')) return 'Existe outra lista ativa. A correção desta compra precisa ser tratada antes de continuar o novo ciclo.'
  if (message.includes('FIFO_BLOCKED')) return 'Atenda primeiro a necessidade mais antiga deste produto. Atualize a fila.'
  if (message.includes('INSUFFICIENT_STOCK')) return 'O saldo do Galpão mudou e não atende a necessidade inteira. Atualize a fila.'
  if (message.includes('FULL_NEED_REQUIRED')) return 'O abastecimento deve atender toda a quantidade restante da loja.'
  return 'Não foi possível concluir a operação. Atualize e tente novamente.'
}

export function ReplenishmentPurchasing({ accountId, storeId, orderDetail, onChanged, initialView = 'buy', onViewChange }: Props) {
  const [lines, setLines] = useState<ReplenishmentPurchaseLine[]>([])
  const [supply, setSupply] = useState<ReplenishmentSupplyLine[]>([])
  const [view, setView] = useState<View>(initialView)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const generation = useRef(0)
  const request = useRef<{ key: string; id: string } | null>(null)
  // Só a PRIMEIRA carga (montagem) mostra a tela cheia de "Carregando
  // reposição...". orderDetail muda de referência a cada liberação de loja
  // (o pai atualiza status/allocations) e isso já dispara este reload via
  // o efeito abaixo — sem este controle, toda liberação reconstruía a área
  // inteira de Comprar/Aguardando entrada/Abastecer. Recargas seguintes
  // (liberação, troca de loja, botão "Atualizar") mantêm o conteúdo atual
  // visível enquanto buscam os dados novos.
  const loadedOnce = useRef(false)
  const reload = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true)
    try {
      const [purchases, available] = await Promise.all([
        getReplenishmentPurchasing(accountId, null),
        getReplenishmentStoreSupply(accountId, null, storeId || null),
      ])
      if (ticket === generation.current) { setLines(purchases); setSupply(available); setInputs({}) }
    } finally { if (ticket === generation.current) { setLoading(false); loadedOnce.current = true } }
  }, [accountId, storeId])
  useEffect(() => {
    void reload().catch(error => setMessage(friendlyError(error)))
    return () => { generation.current++ }
  }, [reload, orderDetail])
  const queues = purchaseWorkQueues(lines, storeId)

  // Fornecedor é somente sugestão/referência visual: reusa lastSupplier já
  // presente em orderDetail.items (market_get_replenishment_order), sem nova
  // RPC e sem vincular produto a fornecedor. Nunca grava nada, só filtra a
  // visualização da aba Comprar.
  const [supplierFilter, setSupplierFilter] = useState('')
  const supplierByProduct = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const item of orderDetail.items) map.set(item.productId, item.lastSupplier?.supplierName?.trim() || null)
    return map
  }, [orderDetail])
  const supplierOptions = useMemo(() => {
    const names = new Set<string>()
    for (const { line } of queues.buy) {
      const name = supplierByProduct.get(line.productId)
      if (name) names.add(name)
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'pt-BR'))
  }, [queues.buy, supplierByProduct])
  const filteredBuyQueue = queues.buy.filter(({ line }) => {
    if (!supplierFilter) return true
    const name = supplierByProduct.get(line.productId)
    return supplierFilter === NO_SUPPLIER_FILTER ? !name : name === supplierFilter
  })

  async function mutate(key: string, action: (requestId: string) => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setMessage('')
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      await action(request.current.id)
      request.current = null
      await reload()
      await onChanged?.()
    } catch (error) { setMessage(friendlyError(error)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function mark(line: ReplenishmentPurchaseLine, undo = false, buying = false) {
    const quantity = undo ? null : Number(inputs[line.id] ?? (buying ? line.targetQuantity : line.purchasedQuantity ?? line.targetQuantity))
    if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity <= 0)) { setMessage('Informe uma quantidade inteira maior que zero.'); return }
    const changes = [{ declarationId: line.id, version: line.version, quantity }]
    await mutate(JSON.stringify({ order: line.orderId, changes }), id => setReplenishmentPurchased(accountId, line.orderId, changes, id))
  }
  function controls(line: ReplenishmentPurchaseLine, buying: boolean) {
    return <div className="market-replenishment-purchase-quantity-actions">
      <label className="market-replenishment-purchase-quantity-label">Total comprado
        <input className="market-replenishment-quantity-input" type="number" min="1" step="1" inputMode="numeric"
          value={inputs[line.id] ?? (buying ? line.targetQuantity : line.purchasedQuantity ?? line.targetQuantity)} disabled={busy}
          onChange={event => setInputs(current => ({ ...current, [line.id]: event.target.value }))} />
      </label>
      <button className="button button-small" disabled={busy} onClick={() => void mark(line, false, buying)}>{buying ? 'Registrar aquisição' : 'Salvar quantidade'}</button>
      {!buying && line.canCorrect && line.committedQuantity === 0 && <button className="button button-small button-outline" disabled={busy} onClick={() => void mark(line, true)}>Desfazer comprado</button>}
    </div>
  }
  const tabs: Array<{ value: View; label: string; count: number }> = [
    { value: 'buy', label: 'Comprar', count: queues.buy.length },
    { value: 'waiting', label: 'Aguardando entrada', count: queues.waiting.length },
    { value: 'supply', label: 'Abastecer', count: supply.length },
  ]
  return <section className="market-replenishment-order-panel" aria-label="Execução da Lista de Compras">
    <h2>Lista de Compras / Reposição</h2>
    <p>Aquisição, entrada no Galpão e entrega na loja são acompanhadas automaticamente. O estoque aumenta somente no recebimento em Compras.</p>
    <div className="market-replenishment-order-actions">
      {tabs.map(tab => <button key={tab.value} className="button button-small" aria-pressed={view === tab.value} onClick={() => { setView(tab.value); onViewChange?.(tab.value) }}>{tab.label} ({loading ? '…' : tab.count})</button>)}
      <button className="button button-small button-outline" disabled={busy || loading} onClick={() => void reload().catch(error => setMessage(friendlyError(error)))}>Atualizar</button>
    </div>
    {message && <p role="status">{message}</p>}
    {loading && !loadedOnce.current ? <p role="status">Carregando reposição...</p> : <>
      {view === 'buy' && <>
        {!!queues.buy.length && <div className="market-replenishment-purchase-filter-bar" aria-label="Filtrar por fornecedor">
          <label>
            <span>Fornecedor</span>
            <select className="market-replenishment-context-select" value={supplierFilter} onChange={event => setSupplierFilter(event.target.value)}>
              <option value="">Todos os fornecedores</option>
              {supplierOptions.map(name => <option key={name} value={name}>{name}</option>)}
              <option value={NO_SUPPLIER_FILTER}>Sem sugestão</option>
            </select>
          </label>
        </div>}
        {!queues.buy.length && <p>Nenhuma quantidade pendente de compra.</p>}
        {!!queues.buy.length && !filteredBuyQueue.length && <p>Nenhum produto pendente para este fornecedor.</p>}
        {filteredBuyQueue.map(({ line, quantity }) => <article key={line.id} className="market-replenishment-order-item market-replenishment-purchase-card">
          <h3>{line.productName}</h3><p>Comprar: {format(quantity)} · Já comprado: {format(line.purchasedQuantity ?? 0)}</p>
          <p>{line.stores.filter(s => !storeId || s.storeId === storeId).map(s => s.storeName).join(' · ')}</p>
          <p>Informe o total adquirido para o produto nesta lista, incluindo compras anteriores.</p>
          {controls(line, true)}
        </article>)}
      </>}
      {view === 'waiting' && <>
        {!queues.waiting.length && <p>Nenhuma quantidade aguardando entrada.</p>}
        {queues.waiting.map(({ line, store }) => <article key={store.allocationId} className="market-replenishment-order-item market-replenishment-purchase-card">
          <h3>{line.productName}</h3><p>{store.storeName}</p>
          <p>Comprado: {format(store.purchasedQuantity)} · Recebido no Galpão: {format(store.receivedQuantity)} · Aguardando entrada: {format(store.awaitingQuantity)}</p>
          <p>Aguardando entrada no Galpão. O recebimento é atribuído quando houver quantidade suficiente para esta necessidade, respeitando as mais antigas.</p>
          {line.canCorrect && controls(line, false)}
        </article>)}
      </>}
      {view === 'supply' && <>
        <p>O saldo do Galpão é revalidado no momento da confirmação.</p>
        {[...new Set(supply.map(line => line.orderId))].map(id => <div key={id}>
          <p>{id === orderDetail.order.id ? 'Lista atual' : `Lista ${id.slice(0, 8)}`} · todas as lojas</p>
          <ReplenishmentCycleAction accountId={accountId} orderId={id} mode="supply" disabled={busy || loading}
            onSuccess={async () => { await reload(); await onChanged?.(); setMessage('Abastecimentos registrados com sucesso.') }} />
        </div>)}
        {!supply.length && <p>Nenhuma necessidade integralmente disponível para abastecimento.</p>}
        {supply.map(line => <article key={line.id} className="market-replenishment-order-item market-replenishment-purchase-card">
          <h3>{line.productName}</h3><p>{line.storeName} · Abastecer: {format(line.remainingQuantity)}</p>
          <p>Galpão {line.sourceStoreName}: {format(line.warehouseBalance)} disponíveis</p>
          <button className="button button-small" disabled={busy} onClick={() => void mutate(`supply:${line.id}:${line.remainingQuantity}`, async id => {
            await executeReplenishmentStoreSupply(accountId,line.orderId,line.allocationId,line.operationLineId,line.sourceStoreId,line.remainingQuantity,id)
          })}>Confirmar abastecimento</button>
        </article>)}
      </>}
    </>}
  </section>
}
