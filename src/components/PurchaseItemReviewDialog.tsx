import { useEffect, useRef, useState } from 'react'
import type { MarketPurchaseItem, PurchaseReviewValues } from '../types/marketPurchases'
import { getMarketPurchaseItem, savePurchaseItemConversion, savePurchaseItemReview } from '../services/marketPurchases'
import { itemReviewValues, purchaseConversionRequired, reviewProblems } from '../utils/purchaseReview'
import { parseLooseNumber } from '../utils/purchaseOcrMath'
import { PurchaseReviewFields } from './PurchaseReviewFields'
import { PurchaseUnitConversionFields } from './PurchaseUnitConversionFields'

const factorDisplay = (factor: number | null) => (factor === null ? '' : String(factor).replace('.', ','))

export function PurchaseItemReviewDialog({ accountId, item, onCancel, onSaved }: {
  accountId: string; item: MarketPurchaseItem; onCancel: () => void; onSaved: () => void;
}) {
  // O item recebido por prop pode estar desatualizado (card ainda não reaberto
  // após conciliação/reprocessamento/correção do backend). Nunca renderiza a
  // partir dele diretamente: busca a versão atual do banco antes de mostrar o
  // formulário — evita repetir aqui o mesmo tipo de bug que já causou "Unidade
  // de estoque não identificada" para um item que já tinha stock_unit no banco.
  const [current, setCurrent] = useState<MarketPurchaseItem | null>(null)
  const [values, setValues] = useState<PurchaseReviewValues | null>(null)
  const [factorInput, setFactorInput] = useState('')
  // Marcado por padrão: o operador desmarca quando não quiser reaproveitar a
  // conversão para as próximas compras deste fornecedor/código. Este estado
  // não persiste nada sozinho — só é lido no momento em que o operador aciona
  // um dos botões de salvar abaixo.
  const [saveForReuse, setSaveForReuse] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialog = useRef<HTMLElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    let cancelled = false
    const applyItem = (resolved: MarketPurchaseItem, note: string | null) => {
      if (cancelled) return
      setCurrent(resolved); setValues(itemReviewValues(resolved)); setFactorInput(factorDisplay(resolved.conversionFactor)); setLoadError(note)
    }
    getMarketPurchaseItem(accountId, item.id)
      .then((fresh) => applyItem(fresh ?? item, fresh ? null : 'Item não encontrado; exibindo a última versão conhecida.'))
      .catch(() => applyItem(item, 'Não foi possível confirmar os dados mais recentes deste item; exibindo a última versão conhecida.'))
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, item.id])

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancel.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onCancel() }
      if (event.key !== 'Tab') return
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? [])
      const first = controls[0], last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown',onKeyDown)
    return () => { document.removeEventListener('keydown',onKeyDown); previous?.focus() }
  }, [onCancel])

  const refetchCurrent = async () => {
    const fresh = await getMarketPurchaseItem(accountId, item.id)
    const resolved = fresh ?? current
    if (resolved) setCurrent(resolved)
    return resolved
  }

  const problems = values ? reviewProblems(values) : []
  const conversionFactorValue = parseLooseNumber(factorInput)
  const conversionPending = current ? purchaseConversionRequired(current) && (conversionFactorValue === null || conversionFactorValue <= 0) : true
  const canConfirm = !!current && !!values && !problems.length && !!current.marketProductId && !conversionPending
  const save = async (confirm: boolean) => {
    if (!current || !values) return
    setBusy(true); setError(null)
    try {
      let working = current
      await savePurchaseItemReview(accountId, working, values, false)
      working = (await refetchCurrent()) ?? working
      if (working.marketProductId && conversionFactorValue !== null && conversionFactorValue !== working.conversionFactor) {
        await savePurchaseItemConversion(accountId, working, conversionFactorValue, saveForReuse)
        working = (await refetchCurrent()) ?? working
      }
      if (confirm) await savePurchaseItemReview(accountId, working, values, true)
      onSaved()
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Não foi possível salvar a conferência.') }
    finally { setBusy(false) }
  }
  return <div className="confirm-dialog-backdrop"><section ref={dialog} className="market-reconcile-dialog" role="dialog" aria-modal="true" aria-label={`Conferir item ${item.lineNumber}`} style={{ maxHeight: '90dvh', overflowY: 'auto', width: 'min(760px, 95vw)', padding: 20 }}>
    <h2>Conferir item {item.lineNumber}</h2>
    <p>O vínculo identifica o produto. Confira os dados abaixo antes de aprovar. Esta ação não recebe mercadoria.</p>
    {!current || !values
      ? <p role="status">Carregando dados atuais do item...</p>
      : <>
        {loadError && <p role="alert">{loadError}</p>}
        <h3>Dados do documento</h3>
        <PurchaseReviewFields values={values} original={current.originalData} onChange={setValues} disabled={busy} />
        <h3>Conversão para estoque</h3>
        <PurchaseUnitConversionFields item={current} factorInput={factorInput} onChangeFactor={setFactorInput}
          saveForReuse={saveForReuse} onChangeSaveForReuse={setSaveForReuse} disabled={busy} />
        {!!problems.length && <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
        {error && <p role="alert">{error}</p>}
      </>}
    <div className="market-purchase-items-toolbar">
      <button ref={cancel} type="button" className="button button-outline" disabled={busy} onClick={onCancel}>Cancelar</button>
      <button type="button" className="button" disabled={busy || !current || !values} onClick={() => void save(true)}>Salvar correções e conferir</button>
      <button type="button" className="button button-outline" disabled={busy || !canConfirm} onClick={() => void save(true)}>Conferi este item</button>
    </div>
    <p className="market-reconcile-dialog-hint">"Salvar correções e conferir" grava os dados e a conversão e, na sequência, confirma a conferência humana. Se a conferência ainda não puder ser confirmada (ex.: conversão pendente), os dados corrigidos são salvos mesmo assim e o motivo é exibido acima, sem fechar esta tela. "Conferi este item" confirma a conferência sem alterar os dados aqui. Nenhum dos dois recebe mercadoria nem movimenta estoque.</p>
  </section></div>
}
