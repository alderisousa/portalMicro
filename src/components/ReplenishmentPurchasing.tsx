import { useCallback, useEffect, useRef, useState } from 'react'
import { getReplenishmentPurchasing, linkReplenishmentPurchaseNf, setReplenishmentPurchased } from '../services/marketReplenishment'
import type { ReplenishmentPurchaseLine } from '../types/marketReplenishment'

interface Props { accountId: string; orderId: string; storeId: string; editable: boolean }
const nfMessage = 'Lance primeiro a(s) nota(s) desta compra para atualizar o estoque do Galpão.'
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 })
const format = (value: number) => quantity.format(value)
function friendlyError(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  if (message.includes('VERSION_CONFLICT')) return 'A lista foi alterada em outro dispositivo. Atualize antes de salvar novamente.'
  if (message.includes('NF_LOCKED')) return 'Esta compra já possui vínculo com NF e não pode ser desfeita ou ajustada.'
  if (message.includes('NF_EXCEEDED')) return 'A quantidade excede o disponível na NF ou o comprado. Atualize a lista.'
  if (message.includes('PERMISSION_DENIED')) return 'Seu perfil não pode operar esta lista.'
  return 'Não foi possível concluir a operação. Atualize a lista e tente novamente.'
}

export function ReplenishmentPurchasing({ accountId, orderId, storeId, editable }: Props) {
  const [lines, setLines] = useState<ReplenishmentPurchaseLine[]>([])
  const [view, setView] = useState<'pending' | 'purchased'>('pending')
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [invoiceChoice, setInvoiceChoice] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inFlight = useRef(false)
  const request = useRef<{ key: string; id: string } | null>(null)
  const generation = useRef(0)
  const reload = useCallback(async () => {
    const ticket = ++generation.current
    setLoading(true)
    try {
      const data = await getReplenishmentPurchasing(accountId, orderId)
      if (ticket === generation.current) { setLines(data); setInputs({}); setInvoiceChoice({}) }
      return data
    } finally { if (ticket === generation.current) setLoading(false) }
  }, [accountId, orderId])
  useEffect(() => {
    void reload().catch((error) => setMessage(friendlyError(error)))
    return () => { generation.current++ }
  }, [reload])
  const scoped = lines.filter((line) => !storeId || line.stores.some((store) => store.storeId === storeId))
  const visible = scoped.filter((line) => (line.purchasedQuantity !== null) === (view === 'purchased'))

  async function mutate(key: string, action: (requestId: string) => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true); setMessage('')
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    try {
      await action(request.current.id)
      request.current = null
      await reload()
    } catch (error) { setMessage(friendlyError(error)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  async function mark(line: ReplenishmentPurchaseLine, undo = false) {
    const changes = [{ declarationId: line.id, version: line.version,
      quantity: undo ? null : Number(inputs[line.id] ?? line.purchasedQuantity ?? line.targetQuantity) }]
    if (changes.some((change) => change.quantity !== null && (!Number.isSafeInteger(change.quantity) || change.quantity <= 0))) {
      setMessage('Informe uma quantidade inteira maior que zero.'); return
    }
    await mutate(JSON.stringify(changes), (id) => setReplenishmentPurchased(accountId, orderId, changes, id))
  }
  async function checkInvoices() {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try {
      const bought = (await reload()).filter((line) => (!storeId || line.stores.some((store) => store.storeId === storeId)) && line.purchasedQuantity !== null)
      if (!bought.length) setMessage('Marque primeiro os itens efetivamente comprados.')
      else if (bought.some((line) => line.coveredQuantity < line.purchasedQuantity!)) {
        setMessage(`${nfMessage} Se a NF já foi lançada, vincule abaixo os itens correspondentes; notas sem vínculo não são consideradas cobertura.`)
      } else if (bought.some((line) => line.receivedQuantity < line.purchasedQuantity!)) {
        setMessage('As quantidades estão cobertas por NF. Conclua o recebimento no módulo Compras/NF para atualizar o estoque do Galpão.')
      } else setMessage('As quantidades compradas já foram recebidas via Compras/NF. Nenhuma nova entrada é necessária. A reposição às lojas será realizada em etapa posterior.')
    } catch (error) { setMessage(friendlyError(error)) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <section className="market-replenishment-order-panel" aria-label="Execução da Lista de Compras">
    <h2>Lista de Compras</h2>
    <p>Marcar comprado registra a aquisição. O estoque só aumenta no recebimento da NF em Compras.</p>
    <div className="market-replenishment-order-actions">
      <button className="button button-small" aria-pressed={view === 'pending'} onClick={() => setView('pending')}>Pendentes ({scoped.filter((line) => line.purchasedQuantity === null).length})</button>
      <button className="button button-small" aria-pressed={view === 'purchased'} onClick={() => setView('purchased')}>Comprados ({scoped.filter((line) => line.purchasedQuantity !== null).length})</button>
      <button className="button button-small button-outline" disabled={busy || loading} onClick={() => void reload().catch((error) => setMessage(friendlyError(error)))}>Atualizar</button>
      <button className="button button-small button-outline" disabled={busy || loading} onClick={() => void checkInvoices()}>Verificar entrada no estoque</button>
    </div>
    {message && <p role="status">{message}</p>}
    {loading ? <p role="status">Carregando compras...</p> : <>
      {!visible.length && <p>Nenhum item neste filtro.</p>}
      {visible.map((line) => <article key={line.id} className="market-replenishment-order-item">
        <h3>{line.productName}</h3>
        <p>Comprar: {format(line.targetQuantity)} · Comprado: {line.purchasedQuantity === null ? 'Pendente' : format(line.purchasedQuantity)}</p>
        <div className="market-replenishment-order-allocations">
          {line.stores.map((store) => <p key={store.storeId}><strong>{store.storeName}</strong>: {format(store.targetQuantity)}</p>)}
          {line.purchasedQuantity !== null && <p>Falta adquirir da meta: {format(Math.max(0, line.targetQuantity - line.purchasedQuantity))} · Coberto por NF: {format(line.coveredQuantity)} · Recebido no Galpão: {format(line.receivedQuantity)}</p>}
          <label>Quantidade comprada<input type="number" min="1" step="1" inputMode="numeric"
            value={inputs[line.id] ?? line.purchasedQuantity ?? line.targetQuantity}
            disabled={!editable || busy || line.linked} onChange={(event) => setInputs((current) => ({ ...current, [line.id]: event.target.value }))} /></label>
          {view === 'purchased' && editable && <>
            <button className="button button-small" disabled={busy || line.linked} onClick={() => void mark(line)}>Salvar quantidade</button>
            <button className="button button-small button-outline" disabled={busy || line.linked} onClick={() => void mark(line, true)}>Desfazer comprado</button>
            {line.linked && <p>Marcação vinculada à NF; edição bloqueada.</p>}
            {line.coveredQuantity < line.purchasedQuantity! && <div>
              <label>NF correspondente<select value={invoiceChoice[line.id] ?? ''} disabled={busy} onChange={(event) => setInvoiceChoice((current) => ({ ...current, [line.id]: event.target.value }))}>
                <option value="">Selecione uma NF do Galpão</option>
                {line.invoices.map((invoice) => <option key={invoice.itemId} value={invoice.itemId}>NF {invoice.invoiceNumber ?? 'sem número'} · {invoice.warehouseName} · disponível {format(invoice.availableQuantity)} · {invoice.received ? 'recebida' : 'aguardando recebimento'}</option>)}
              </select></label>
              <button className="button button-small button-outline" disabled={busy || !invoiceChoice[line.id]} onClick={() => {
                const invoice = line.invoices.find((entry) => entry.itemId === invoiceChoice[line.id])
                if (!invoice) return
                const amount = Math.min(invoice.availableQuantity, line.purchasedQuantity! - line.coveredQuantity)
                void mutate(`nf:${line.id}:${invoice.itemId}:${amount}`, (id) => linkReplenishmentPurchaseNf(accountId, orderId, line.id, invoice.itemId, amount, id))
              }}>Vincular quantidade disponível</button>
              {!line.invoices.length && <p>{nfMessage}</p>}
            </div>}
          </>}
          {view === 'pending' && editable && <button className="button" disabled={busy} onClick={() => void mark(line)}>Comprado</button>}
        </div>
      </article>)}
    </>}
  </section>
}
