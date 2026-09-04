import { ArrowLeft, ChevronDown, FileKey2, Link2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PurchaseItemReconciliationDialog } from '../components/PurchaseItemReconciliationDialog'
import {
  importMarketPurchase, isPurchaseReimportEligible, listMarketPurchaseItems,
  listMarketPurchaseSummaries, MarketPurchaseImportError,
} from '../services/marketPurchases'
import {
  listMarketProductsByIds, reprocessPurchasePendingItems, undoPurchaseItemReconciliation,
  ReconciliationError, type ReconciledProductSummary,
} from '../services/marketReconciliation'
import type { MarketStore } from '../types/market'
import type {
  MarketPurchaseImportRequest, MarketPurchaseImportSourceType, MarketPurchaseItem,
  MarketPurchaseItemReconciliationStatus, MarketPurchaseListItem,
} from '../types/marketPurchases'

interface Props { accountId: string; warehouses: MarketStore[]; canImport: boolean; onBack: () => void }

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' })
const formatMoney = (value: number | null) => (value === null ? '-' : currency.format(value))

const statusLabels: Record<string, string> = { imported: 'Importada', reconciling: 'Conciliando', pending: 'Pendente', ready: 'Pronta', receiving: 'Recebendo', completed: 'Concluída', cancelled: 'Cancelada', failed: 'Falhou' }

const reconciliationLabels: Record<MarketPurchaseItemReconciliationStatus, string> = {
  pending: 'Pendente', matched_auto: 'Vinculado automaticamente', matched_manual: 'Vinculado manualmente',
  mapped: 'Mapeado (de/para)', not_found: 'Produto não encontrado', needs_review: 'Requer revisão',
}
const reconciliationMethodLabels: Record<string, string> = { ean_exact: 'EAN', purchase_mapping: 'De/para', manual: 'Manual' }
const isReconciledStatus = (status: MarketPurchaseItemReconciliationStatus) =>
  status === 'matched_auto' || status === 'matched_manual' || status === 'mapped'

interface ItemsState { loading: boolean; error: boolean; items: MarketPurchaseItem[]; products: Record<string, ReconciledProductSummary> }
interface ReimportPrompt { request: MarketPurchaseImportRequest; invoiceNumber: string | null; supplierName: string | null }
interface ReconcileTarget { purchaseId: string; item: MarketPurchaseItem }

export function MarketPurchases({ accountId, warehouses, canImport, onBack }: Props) {
  const [purchases, setPurchases] = useState<MarketPurchaseListItem[]>([])
  const [sourceType, setSourceType] = useState<MarketPurchaseImportSourceType>('qrcode_url')
  const [sourceValue, setSourceValue] = useState('')
  const [destinationStoreId, setDestinationStoreId] = useState(warehouses[0]?.id ?? '')
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [itemsState, setItemsState] = useState<Record<string, ItemsState>>({})
  const [reimportPrompt, setReimportPrompt] = useState<ReimportPrompt | null>(null)
  const [reimporting, setReimporting] = useState(false)
  const [reconcileTarget, setReconcileTarget] = useState<ReconcileTarget | null>(null)
  const [undoingItemId, setUndoingItemId] = useState<string | null>(null)
  const [reprocessingId, setReprocessingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setPurchases(await listMarketPurchaseSummaries(accountId)) }
    catch { setMessage({ error: true, text: 'Não foi possível carregar as notas importadas.' }) }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { void load() }, [load])

  const loadItems = useCallback(async (purchaseId: string) => {
    setItemsState((prev) => ({
      ...prev,
      [purchaseId]: { loading: true, error: false, items: prev[purchaseId]?.items ?? [], products: prev[purchaseId]?.products ?? {} },
    }))
    try {
      const items = await listMarketPurchaseItems(accountId, purchaseId)
      const productIds = Array.from(new Set(items.map((item) => item.marketProductId).filter((id): id is string => Boolean(id))))
      const products = await listMarketProductsByIds(accountId, productIds)
      const productsById = Object.fromEntries(products.map((product) => [product.id, product]))
      setItemsState((prev) => ({ ...prev, [purchaseId]: { loading: false, error: false, items, products: productsById } }))
    } catch {
      setItemsState((prev) => ({ ...prev, [purchaseId]: { loading: false, error: true, items: [], products: {} } }))
    }
  }, [accountId])

  const handleReconciled = () => {
    if (!reconcileTarget) return
    void loadItems(reconcileTarget.purchaseId)
    void load()
    setReconcileTarget(null)
  }

  const handleUndo = async (purchaseId: string, itemId: string) => {
    setUndoingItemId(itemId); setMessage(null)
    try {
      await undoPurchaseItemReconciliation(accountId, itemId)
      await loadItems(purchaseId)
      await load()
    } catch (cause) {
      setMessage({ error: true, text: cause instanceof ReconciliationError ? cause.message : 'Não foi possível desfazer a conciliação.' })
    } finally { setUndoingItemId(null) }
  }

  const handleReprocess = async (purchaseId: string) => {
    setReprocessingId(purchaseId); setMessage(null)
    try {
      const result = await reprocessPurchasePendingItems(accountId, purchaseId)
      await loadItems(purchaseId)
      await load()
      setMessage({
        error: false,
        text: result.itemsMatched > 0
          ? `Reprocessado: ${result.itemsMatched} de ${result.itemsProcessed} itens conciliados automaticamente.`
          : `Reprocessado: nenhum dos ${result.itemsProcessed} itens pendentes encontrou correspondência ainda.`,
      })
    } catch (cause) {
      setMessage({ error: true, text: cause instanceof ReconciliationError ? cause.message : 'Não foi possível reprocessar os pendentes.' })
    } finally { setReprocessingId(null) }
  }

  const toggle = (purchaseId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(purchaseId)) next.delete(purchaseId)
      else next.add(purchaseId)
      return next
    })
    if (!itemsState[purchaseId]) void loadItems(purchaseId)
  }

  // Comum ao sucesso de uma importacao nova e de uma reimportacao confirmada: atualiza
  // a lista e mostra so o resumo (nao expande automaticamente). Invalida qualquer cache
  // de itens dessa nota — relevante sobretudo na reimportacao, cujos itens antigos nao
  // podem sobrar visiveis — e garante que o card comece/fique recolhido, para que o
  // proximo "Ver itens" sempre busque os dados atualizados.
  const finishSuccessfulImport = async (purchaseId: string, successText: string) => {
    setMessage({ error: false, text: successText })
    setSourceValue(''); await load()
    setItemsState((prev) => {
      if (!(purchaseId in prev)) return prev
      const next = { ...prev }
      delete next[purchaseId]
      return next
    })
    setExpandedIds((prev) => {
      if (!prev.has(purchaseId)) return prev
      const next = new Set(prev)
      next.delete(purchaseId)
      return next
    })
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setImporting(true); setMessage(null)
    const request: MarketPurchaseImportRequest = { marketAccountId: accountId, destinationStoreId, sourceType, sourceValue }
    try {
      const result = await importMarketPurchase(request)
      if (result.duplicate) {
        // O backend so informa "ja existe" (idempotencia por invoice_key); a elegibilidade
        // para reimportar e checada aqui so para decidir a UI — quem garante a regra de
        // verdade e market_reimport_purchase_staging, revalidando com lock na transacao.
        const items = await listMarketPurchaseItems(accountId, result.purchaseId)
        if (isPurchaseReimportEligible(result.status, items)) {
          setReimportPrompt({ request, invoiceNumber: result.invoiceNumber, supplierName: result.supplierName })
        } else {
          setMessage({ error: true, text: 'Esta nota já possui itens conciliados ou movimentação de estoque e não pode ser reimportada.' })
        }
        return
      }
      await finishSuccessfulImport(result.purchaseId, `Nota importada com ${result.itemCount} itens pendentes.`)
    } catch (error) {
      setMessage({ error: true, text: error instanceof MarketPurchaseImportError ? error.message : 'Não foi possível importar a nota fiscal.' })
    } finally { setImporting(false) }
  }

  const confirmReimport = async () => {
    if (!reimportPrompt) return
    setReimporting(true)
    try {
      const result = await importMarketPurchase({ ...reimportPrompt.request, mode: 'reimport' })
      setReimportPrompt(null)
      await finishSuccessfulImport(result.purchaseId, 'Nota reimportada com sucesso.')
    } catch (error) {
      setReimportPrompt(null)
      setMessage({ error: true, text: error instanceof MarketPurchaseImportError ? error.message : 'Não foi possível reimportar a nota.' })
    } finally { setReimporting(false) }
  }

  return <>
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Voltar</button>
    <header className="market-dashboard-header"><p className="eyebrow"><FileKey2 size={16} /> Compras</p><h1>Notas de entrada</h1><p>Importe dados estruturados pela chave de acesso ou URL do QR Code.</p></header>

    {canImport && <section className="market-purchase-import-card">
      <span className="panel-kicker">IMPORTAR NOTA</span>
      <h2>Importar nota fiscal</h2>
      <form className="market-purchase-import-form" onSubmit={submit}>
        <div className="market-purchase-import-row">
          <label>Formato de entrada
            <select value={sourceType} onChange={(event) => setSourceType(event.target.value as MarketPurchaseImportSourceType)}>
              <option value="access_key">Chave de acesso (44 dígitos)</option>
              <option value="qrcode_url">URL do QR Code</option>
              <option value="photo" disabled>Foto da nota (em breve)</option>
            </select>
          </label>
          <label>Galpão de destino
            <select required value={destinationStoreId} onChange={(event) => setDestinationStoreId(event.target.value)}>
              <option value="">Selecione</option>
              {warehouses.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </label>
        </div>
        <div className="market-purchase-import-row market-purchase-import-row-main">
          <label>{sourceType === 'access_key' ? <FileKey2 size={16} /> : <Link2 size={16} />} {sourceType === 'access_key' ? 'Chave de 44 dígitos' : 'URL HTTPS do QR Code'}
            <input required value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder={sourceType === 'access_key' ? 'Cole a chave da nota' : 'https://...'} />
          </label>
          <button className="button" disabled={importing || !destinationStoreId || !!reimportPrompt}>{importing ? 'Importando...' : 'Importar nota'}</button>
        </div>
      </form>
      <p className="template-market-note">A nota será importada para conferência antes de entrar no estoque.</p>
    </section>}
    {!canImport && <div className="admin-message">Seu perfil permite consultar as compras, mas não importar novas notas.</div>}
    {message && <div className={`admin-message${message.error ? ' is-error' : ''}`} role={message.error ? 'alert' : 'status'}>{message.text}</div>}

    {reimportPrompt && <ConfirmDialog
      title="Esta nota já foi importada"
      description={`Deseja substituir a importação atual${reimportPrompt.invoiceNumber ? ` da nota ${reimportPrompt.invoiceNumber}` : ''}${reimportPrompt.supplierName ? ` (${reimportPrompt.supplierName})` : ''} e carregar novamente os dados da nota? Os itens ainda não conciliados desta importação serão substituídos.`}
      confirmLabel="Reimportar nota"
      processingLabel="Reimportando..."
      processing={reimporting}
      confirmVariant="destructive"
      onCancel={() => setReimportPrompt(null)}
      onConfirm={() => void confirmReimport()}
    />}

    <section className="market-dashboard-section">
      <div className="market-section-heading"><div><span className="panel-kicker">EM CONFERÊNCIA</span><h2>Notas importadas</h2></div><button className="button button-small button-outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Atualizar</button></div>
      {loading ? <div className="admin-message">Carregando notas...</div> : !purchases.length ? <div className="admin-message">Nenhuma nota importada.</div> : <div className="market-purchase-list">
        {purchases.map((purchase) => {
          const expanded = expandedIds.has(purchase.id)
          const state = itemsState[purchase.id]
          return <article key={purchase.id} className={`market-purchase-card${expanded ? ' is-expanded' : ''}`}>
            <button type="button" className="market-purchase-card-header" onClick={() => toggle(purchase.id)} aria-expanded={expanded}>
              <div className="market-purchase-card-main">
                <strong>Nota fiscal {purchase.invoiceNumber || 'sem número'}</strong>
                <span>{purchase.supplierName || 'Fornecedor não informado'}</span>
              </div>
              <dl className="market-purchase-card-stats">
                <div><dt>Emissão</dt><dd>{purchase.issuedAt ? date.format(new Date(purchase.issuedAt)) : '-'}</dd></div>
                <div><dt>Valor final</dt><dd>{purchase.totalAmount === null ? '-' : currency.format(purchase.totalAmount)}</dd></div>
                <div><dt>Itens</dt><dd>{purchase.totalItems}</dd></div>
                <div><dt>Conciliados</dt><dd>{purchase.reconciledItems} / {purchase.totalItems}</dd></div>
                <div><dt>Pendentes</dt><dd>{purchase.pendingItems}</dd></div>
                <div><dt>Status</dt><dd><span className={`market-row-status ${purchase.status}`}>{statusLabels[purchase.status]}</span></dd></div>
              </dl>
              <span className="market-purchase-card-toggle">{expanded ? 'Ocultar itens' : 'Ver itens'} <ChevronDown size={16} /></span>
            </button>
            {expanded && <div className="market-purchase-card-items">
              {!state || state.loading ? <p className="market-purchase-card-items-status">Carregando itens...</p>
                : state.error ? <p className="market-purchase-card-items-status">Não foi possível carregar os itens desta nota. <button type="button" className="button button-small button-outline" onClick={() => void loadItems(purchase.id)}>Tentar de novo</button></p>
                : !state.items.length ? <p className="market-purchase-card-items-status">Nenhum item encontrado.</p>
                : <>
                  {(() => {
                    const pendingCount = state.items.filter((item) => !isReconciledStatus(item.reconciliationStatus)).length
                    return <div className="market-purchase-items-toolbar">
                      <p>{pendingCount > 0 ? `${pendingCount} ${pendingCount === 1 ? 'item pendente' : 'itens pendentes'} de conciliação` : 'Todos os itens estão conciliados.'}</p>
                      <button type="button" className="button button-small button-outline" disabled={pendingCount === 0 || reprocessingId === purchase.id} onClick={() => void handleReprocess(purchase.id)}>
                        {reprocessingId === purchase.id ? 'Reprocessando...' : 'Reprocessar pendentes'}
                      </button>
                    </div>
                  })()}
                  <div className="market-purchase-items-table-wrap"><table className="market-purchase-items-table">
                  <thead><tr><th>Linha</th><th>Descrição</th><th>Código do fornecedor</th><th className="is-numeric">Quantidade</th><th>Unidade</th><th className="is-numeric">Valor unitário</th><th className="is-numeric">Total da linha</th><th className="is-numeric">Custo unit. calculado</th><th>Conciliação</th><th>Ação</th></tr></thead>
                  <tbody>{state.items.map((item) => {
                    const reconciled = isReconciledStatus(item.reconciliationStatus)
                    const product = item.marketProductId ? state.products[item.marketProductId] : undefined
                    return <tr key={item.id}>
                    <td>{item.lineNumber}</td>
                    <td className="market-purchase-item-desc">{item.descriptionRaw || '-'}</td>
                    <td>{item.supplierProductCode || '-'}</td>
                    <td className="is-numeric">{quantityFormat.format(item.quantity)}</td>
                    <td>{item.unit || '-'}</td>
                    <td className="is-numeric">{formatMoney(item.unitPrice)}</td>
                    <td className="is-numeric">{formatMoney(item.grossAmount)}</td>
                    <td className="is-numeric">{formatMoney(item.calculatedUnitCost)}</td>
                    <td>
                      <span className={`market-row-status ${item.reconciliationStatus}`}>{reconciliationLabels[item.reconciliationStatus]}</span>
                      {reconciled && product && <div className="market-purchase-item-product">
                        <strong>{product.name}</strong>
                        <span>{product.sku ? `SKU ${product.sku}` : 'Sem SKU'}{item.reconciliationMethod ? ` · ${reconciliationMethodLabels[item.reconciliationMethod] ?? item.reconciliationMethod}` : ''}</span>
                      </div>}
                    </td>
                    <td>
                      {reconciled
                        ? (item.stockEntryStatus === 'pending'
                          ? <button type="button" className="button button-small button-outline" disabled={undoingItemId === item.id} onClick={() => void handleUndo(purchase.id, item.id)}>
                              {undoingItemId === item.id ? 'Desfazendo...' : 'Desfazer'}
                            </button>
                          : null)
                        : <button type="button" className="button button-small" onClick={() => setReconcileTarget({ purchaseId: purchase.id, item })}>Conciliar</button>}
                    </td>
                  </tr>
                  })}</tbody>
                </table></div>
                </>}
            </div>}
          </article>
        })}
      </div>}
    </section>

    {reconcileTarget && <PurchaseItemReconciliationDialog
      accountId={accountId}
      item={reconcileTarget.item}
      onCancel={() => setReconcileTarget(null)}
      onConfirmed={handleReconciled}
    />}
  </>
}
