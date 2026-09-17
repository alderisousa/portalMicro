import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ConfirmDialog } from './ConfirmDialog'
import { closeAndCreateReplenishmentOrder, executeReplenishmentSupplyBatch, getReplenishmentClosurePreview, getReplenishmentSupplyBatchPreview } from '../services/marketReplenishment'
import type { ReplenishmentClosurePreview, ReplenishmentSupplyBatchPreview, ReplenishmentNewCycleResult } from '../types/marketReplenishment'
import { replenishmentCycleError } from '../utils/replenishmentCycle'

interface Props {
  accountId: string; orderId: string; mode: 'close' | 'supply'; disabled?: boolean
  triggerLabel?: string
  onSuccess: (result?: ReplenishmentNewCycleResult) => Promise<void>
}
const format = (value: number) => new Intl.NumberFormat('pt-BR').format(value)

// O preview fica intacto ate o fim da tentativa, inclusive durante retry.
export function ReplenishmentCycleAction({ accountId, orderId, mode, disabled, triggerLabel, onSuccess }: Props) {
  const [closure, setClosure] = useState<ReplenishmentClosurePreview | null>(null)
  const [batch, setBatch] = useState<ReplenishmentSupplyBatchPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [reason, setReason] = useState('')
  const locked = useRef(false)
  const request = useRef<{ id: string; reason: string | null } | null>(null)
  const committed = useRef<{ result?: ReplenishmentNewCycleResult } | null>(null)
  const [attempted, setAttempted] = useState(false)
  const label = mode === 'close' ? 'Encerrar e abrir nova lista' : 'Confirmar abastecimentos'
  const open = !!closure || !!batch
  async function preview() {
    if (locked.current) return
    locked.current = true; setBusy(true); setMessage('')
    request.current = null; committed.current = null; setAttempted(false); setReason('')
    try {
      if (mode === 'close') setClosure(await getReplenishmentClosurePreview(accountId, orderId))
      else setBatch(await getReplenishmentSupplyBatchPreview(accountId, orderId))
    } catch (error) { setMessage(replenishmentCycleError(error)) }
    finally { locked.current = false; setBusy(false) }
  }
  function cancel() {
    if (locked.current || committed.current) return
    setClosure(null); setBatch(null); setMessage('')
  }
  async function confirm() {
    if (locked.current || !open) return
    locked.current = true; setBusy(true); setMessage(''); setAttempted(true)
    request.current ??= { id: crypto.randomUUID(), reason: reason.trim() || null }
    try {
      if (!committed.current) {
        if (mode === 'close') committed.current = { result: await closeAndCreateReplenishmentOrder(accountId, orderId, request.current.id, request.current.reason) }
        else {
          if (!batch?.items.length) return
          await executeReplenishmentSupplyBatch(accountId, orderId, batch.items, request.current.id)
          committed.current = {}
        }
      }
      await onSuccess(committed.current.result)
      setClosure(null); setBatch(null)
      setMessage(mode === 'close' ? 'Lista anterior encerrada e nova análise criada.' : 'Abastecimentos registrados com sucesso.')
    } catch (error) {
      setMessage(committed.current ? 'Operação registrada. Não foi possível atualizar a tela. Tente atualizar novamente.' : replenishmentCycleError(error))
    } finally { locked.current = false; setBusy(false) }
  }
  const summary = closure?.summary
  return <>
    <button type="button" className={`button button-small button-outline${mode === 'close' ? ' replenishment-close-action' : ''}`} disabled={disabled || busy} onClick={() => void preview()}>{busy && !open ? 'Carregando resumo...' : triggerLabel ?? label}</button>
    {!open && message && <p role="status">{message}</p>}
    {open && createPortal(<ConfirmDialog trapFocus className="replenishment-cycle-dialog" title={mode === 'close' ? 'Encerrar abastecimento atual?' : 'Confirmar abastecimentos?'}
      description={mode === 'close' ? 'Esta lista será encerrada e uma nova análise será feita com as vendas consolidadas e o estoque atual.' : 'Esta ação informa ao GiroMicro que a separação e a entrega dos itens abaixo já foram realizadas.'}
      cancelLabel="Voltar" cancelDisabled={!!committed.current} confirmLabel={committed.current ? 'Atualizar dados' : label} processingLabel="Processando..." processing={busy}
      confirmDisabled={mode === 'supply' && !batch?.items.length} confirmVariant={mode === 'close' ? 'destructive' : 'primary'} onCancel={cancel} onConfirm={() => void confirm()}>
      {summary && <>
        <dl className="replenishment-cycle-summary">
          <div><dt>Processados</dt><dd>{summary.processed} necessidades · {format(summary.processedUnits)} unidades</dd></div>
          <div><dt>Prontos para abastecer</dt><dd>{summary.readyToSupply} necessidades · {format(summary.readyToSupplyUnits)} unidades</dd></div>
          <div><dt>Aguardando entrada</dt><dd>{summary.awaitingReceipt} necessidades · {format(summary.awaitingReceiptUnits)} unidades</dd></div>
          <div><dt>Ainda para comprar</dt><dd>{summary.stillToBuy} necessidades · {format(summary.stillToBuyKnownUnits)} unidades conhecidas</dd></div>
        </dl>
        <p>Uma necessidade pode ter parcelas em mais de uma etapa.</p>
        {summary.unknownQuantityNeeds > 0 && <p>{summary.unknownQuantityNeeds} necessidades ainda sem quantidade definida.</p>}
        {summary.readyToSupply > 0 && <p className="admin-message is-error">ATENÇÃO: existem {format(summary.readyToSupplyUnits)} unidades disponíveis no Galpão para abastecimento que ainda não foram enviadas às lojas. Ao encerrar esta lista, esses abastecimentos serão cancelados. As mercadorias continuarão no estoque do Galpão.</p>}
        {summary.awaitingReceipt > 0 && <p>Compras ainda aguardando entrada deixarão de pertencer a esta lista. Uma NF recebida posteriormente continuará entrando normalmente no estoque do Galpão.</p>}
        {summary.stillToBuy > 0 && <p>Necessidades ainda não compradas serão abandonadas nesta lista. Se continuarem necessárias, poderão reaparecer na nova análise.</p>}
        <p><strong>O que já foi recebido ou abastecido não será desfeito.</strong></p>
        <label>Motivo do encerramento (opcional)<textarea value={reason} disabled={busy || attempted} onChange={event => setReason(event.target.value)} /></label>
      </>}
      {batch && <>
        <p>Todas as lojas desta lista, inclusive fora do filtro atual.</p>
        <p>{batch.storeCount} lojas · {batch.productCount} produtos · {batch.allocationCount} itens · {format(batch.totalUnits)} unidades</p>
        {batch.stores.map(store => <article key={store.storeId}><strong>{store.storeName}</strong><p>{store.allocationCount} itens · {format(store.totalUnits)} unidades</p></article>)}
        {!batch.items.length && <p>Nenhum abastecimento disponível. Volte e atualize a lista.</p>}
        <p>Após confirmar, o GiroMicro registrará a saída do Galpão e a entrada nas respectivas lojas. Use esta opção somente se a distribuição física já tiver sido realizada.</p>
      </>}
      {message && <p role="alert">{message}</p>}
    </ConfirmDialog>, document.body)}
  </>
}
