import { useCallback, useEffect, useState } from 'react'
import { getReplenishmentStoreSupply, executeReplenishmentStoreSupply } from '../services/marketReplenishment'
import { ConfirmDialog } from './ConfirmDialog'
import type { ReplenishmentSupplyLine } from '../types/marketReplenishment'

interface Props { accountId: string; orderId: string; storeId: string; editable: boolean }
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const format = (value: number) => quantity.format(value)
interface InsufficientStockPrompt { lineId: string; attempted: number; available: number }
function errorMessage(error: unknown): { message: string; stock: number | null } {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  const stock = message.match(/INSUFFICIENT_STOCK:\s*saldo atual\s*([0-9.,-]+)/i)
  if (stock) return { message, stock: Number(stock[1].replace(',', '.')) }
  if (message.includes('SOURCE_INVALID')) return { message: 'O Galpão selecionado não está disponível para este abastecimento.', stock: null }
  if (message.includes('DESTINATION_INVALID')) return { message: 'A loja selecionada não está disponível para este abastecimento.', stock: null }
  if (message.includes('REQUEST_CONFLICT')) return { message: 'Esta confirmação já foi usada para outra operação.', stock: null }
  return { message: 'Não foi possível confirmar o abastecimento. Atualize a lista e tente novamente.', stock: null }
}

export function ReplenishmentStoreSupply({ accountId, orderId, storeId, editable }: Props) {
  const [lines, setLines] = useState<ReplenishmentSupplyLine[]>([])
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [insufficientStock, setInsufficientStock] = useState<InsufficientStockPrompt | null>(null)
  const reload = useCallback(async () => {
    setLoading(true)
    try { setLines(await getReplenishmentStoreSupply(accountId, orderId, storeId)) }
    catch (error) { setMessage(errorMessage(error).message) }
    finally { setLoading(false) }
  }, [accountId, orderId, storeId])
  useEffect(() => { void reload() }, [reload])
  async function supply(line: ReplenishmentSupplyLine) {
    const value = Number(inputs[line.id] ?? line.suggestedQuantity)
    if (!Number.isSafeInteger(value) || value <= 0) { setMessage('Informe uma quantidade inteira maior que zero.'); return }
    setBusy(line.id); setMessage('')
    try {
      await executeReplenishmentStoreSupply(accountId, orderId, line.allocationId, line.operationLineId, line.sourceStoreId, value, crypto.randomUUID())
      await reload()
    } catch (error) {
      const result = errorMessage(error)
      if (result.stock !== null && value > result.stock) setInsufficientStock({ lineId: line.id, attempted: value, available: Math.max(0, Math.floor(result.stock)) })
      else setMessage(result.message)
    }
    finally { setBusy(null) }
  }
  return <section className="market-replenishment-order-panel" aria-label="Abastecimento da Loja pelo Galpão">
    <h2>Abastecer Loja</h2>
    <p>A confirmação transfere a quantidade do Galpão para esta loja em uma única operação.</p>
    {message && <p role="alert">{message}</p>}
    {loading ? <p role="status">Carregando saldo do Galpão...</p> : !lines.length ? <p>Nenhum abastecimento pendente para esta loja.</p> : lines.map((line) => <article key={line.id} className="market-replenishment-order-item">
      <h3>{line.productName}</h3>
      <p>Necessidade: {format(line.remainingQuantity)} · Galpão {line.sourceStoreName}: {format(line.warehouseBalance)}</p>
      <label className="market-replenishment-supply-quantity">Quantidade para abastecer<input className="market-replenishment-quantity-input" type="number" min="1" step="1" inputMode="numeric" value={inputs[line.id] ?? line.suggestedQuantity} disabled={!editable || busy === line.id} onKeyDown={(event) => { if (['.', ',', 'e', 'E', '+', '-'].includes(event.key)) event.preventDefault() }} onChange={(event) => setInputs((current) => ({ ...current, [line.id]: event.target.value.replace(/\D/g, '') }))} /></label>
      {editable && <button className="button" disabled={busy !== null || line.suggestedQuantity <= 0} onClick={() => void supply(line)}>{busy === line.id ? 'Confirmando...' : 'Confirmar abastecimento'}</button>}
      <p>Já abastecido: {format(line.executedQuantity)} · Progresso da necessidade: {format(line.confirmedQuantity)} de {format(line.targetQuantity)}</p>
    </article>)}
    {insufficientStock && <ConfirmDialog
      title="Saldo insuficiente no Galpão"
      description={`Você tentou abastecer ${format(insufficientStock.attempted)} unidades, mas o saldo disponível é ${format(insufficientStock.available)}.`}
      confirmLabel={`Usar ${format(insufficientStock.available)}`}
      processingLabel="Usando saldo..."
      processing={false}
      confirmVariant="primary"
      onCancel={() => setInsufficientStock(null)}
      onConfirm={() => {
        setInputs((current) => ({ ...current, [insufficientStock.lineId]: String(insufficientStock.available) }))
        setInsufficientStock(null)
      }}
    />}
  </section>
}
