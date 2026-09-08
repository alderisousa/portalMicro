import { ArrowLeft, ChevronDown, FileKey2, History, Link2, PackageCheck, QrCode, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PurchaseItemReconciliationDialog } from '../components/PurchaseItemReconciliationDialog'
import { PurchaseItemReviewDialog } from '../components/PurchaseItemReviewDialog'
import { canReviewPurchaseItem, isHumanReviewed, isPurchaseItemReadyToReceive, isPurchaseItemUntouched } from '../utils/purchaseReview'
import { PurchaseAiTextCapture } from '../components/PurchaseAiTextCapture'
import { PurchasePdfCapture } from '../components/PurchasePdfCapture'
import { PurchasePhotoCapture } from '../components/PurchasePhotoCapture'
import { QrCodeScanner } from '../components/QrCodeScanner'
import {
  importMarketPurchase, isPurchaseReimportEligible, listMarketPurchaseItems,
  listMarketPurchaseSummaries, MarketPurchaseImportError, receivePurchaseReadyItems, deleteImportedPurchase,
} from '../services/marketPurchases'
import {
  listMarketProductsByIds, reprocessPurchasePendingItems, undoPurchaseItemReconciliation,
  ReconciliationError, type ReconciledProductSummary,
} from '../services/marketReconciliation'
// Mesma sincronização de catálogo já usada em Estoque/Admin da integração
// (market-integration-admin, ação sync-products) — nenhuma lógica nova de
// integração, só reaproveitando o serviço existente nesta tela.
import { findAccesysIntegrationId, getMarketProductSyncStatus, synchronizeMarketProducts } from '../services/marketIntegration'
import type { MarketProductSyncRun } from '../types/marketIntegration'
import type { MarketStore } from '../types/market'
import type {
  MarketPurchaseImportRequest, MarketPurchaseImportSourceType, MarketPurchaseItem,
  MarketPurchaseItemReconciliationStatus, MarketPurchaseListItem,
} from '../types/marketPurchases'

interface Props { accountId: string; warehouses: MarketStore[]; canImport: boolean; onBack: () => void }

const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 })
const date = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' })
const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
// Mesmo formato do card de sincronização de produtos da tela de Estoque
// (MarketStockDashboard) — texto idêntico, para os dois cards lerem igual.
const formatProductSyncDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  .format(new Date(value)).replace(', ', ' às ')
const formatMoney = (value: number | null) => (value === null ? '-' : currency.format(value))
const formatStockEntry = (item: MarketPurchaseItem) =>
  item.stockQuantity === null || item.stockUnit === null ? 'Aguardando conversão' : `${quantityFormat.format(item.stockQuantity)} ${item.stockUnit}`
// stock_unit_cost pode ser null por dois motivos bem diferentes: conversão
// ainda não resolvida (conversion_factor/stock_unit ausentes) ou conversão já
// resolvida mas nem net_amount nem gross_amount existem no documento (a
// coluna gerada já cai para gross_amount sozinha quando só net_amount falta
// — caso comum no Texto IA). Rótulos distintos para não sugerir "conversão
// pendente" quando na verdade é a linha que não trouxe nenhum valor usável.
const formatStockUnitCost = (item: MarketPurchaseItem) => {
  if (item.conversionFactor === null || item.stockUnit === null) return 'Aguardando conversão'
  if (item.stockUnitCost === null) return 'Custo não informado'
  return `${formatMoney(item.stockUnitCost)} / ${item.stockUnit}`
}

const statusLabels: Record<string, string> = { imported: 'Importada', reconciling: 'Conciliando', pending: 'Pendente', ready: 'Pronta', receiving: 'Parcialmente recebida', completed: 'Concluída', cancelled: 'Cancelada', failed: 'Falhou' }

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
interface ReceivePrompt { purchaseId: string; storeName: string; readyCount: number; remainingCount: number; receivedSoFar: number; totalItems: number }
interface DeletePrompt { purchaseId: string; invoiceNumber: string | null }

export function MarketPurchases({ accountId, warehouses, canImport, onBack }: Props) {
  const [purchases, setPurchases] = useState<MarketPurchaseListItem[]>([])
  const [sourceType, setSourceType] = useState<MarketPurchaseImportSourceType>('qrcode_url')
  const [sourceValue, setSourceValue] = useState('')
  const [destinationStoreId, setDestinationStoreId] = useState(warehouses[0]?.id ?? '')
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [itemsState, setItemsState] = useState<Record<string, ItemsState>>({})
  const [reimportPrompt, setReimportPrompt] = useState<ReimportPrompt | null>(null)
  const [reimporting, setReimporting] = useState(false)
  const [reconcileTarget, setReconcileTarget] = useState<ReconcileTarget | null>(null)
  const [reviewTarget, setReviewTarget] = useState<ReconcileTarget | null>(null)
  const [undoingItemId, setUndoingItemId] = useState<string | null>(null)
  const [reprocessingId, setReprocessingId] = useState<string | null>(null)
  const [receivePrompt, setReceivePrompt] = useState<ReceivePrompt | null>(null)
  const [receivingId, setReceivingId] = useState<string | null>(null)
  const [deletePrompt, setDeletePrompt] = useState<DeletePrompt | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'compras' | 'historico'>('compras')
  const [productIntegrationId, setProductIntegrationId] = useState<string | null>(null)
  const [productSyncRun, setProductSyncRun] = useState<MarketProductSyncRun | null>(null)
  const [lastProductSync, setLastProductSync] = useState<MarketProductSyncRun | null>(null)
  const [productSyncing, setProductSyncing] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scannerError, setScannerError] = useState<string | null>(null)
  // PoC (checkpoint 5D.1/5D.2.2): habilita so a UI de teste local de OCR (foto OU
  // PDF, mutuamente exclusivos): nao afeta sourceType/submit, que seguem
  // exclusivos do fluxo NFC-e ja existente.
  const [ocrEntrySource, setOcrEntrySource] = useState<'photo' | 'pdf' | 'ai_text' | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try { setPurchases(await listMarketPurchaseSummaries(accountId)) }
    catch { setMessage({ error: true, text: 'Não foi possível carregar as notas importadas.' }) }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { void load() }, [load])

  // Resolvido uma única vez por conta: só para saber se há integração Accesys
  // ativa e mostrar o status da última sincronização no card "Última
  // sincronização de produtos" (mesmo dado carregado em MarketStockDashboard
  // no load()). Falha aqui não é grave — o card só mostra o estado disponível.
  useEffect(() => {
    let cancelled = false
    findAccesysIntegrationId(accountId).then(async (id) => {
      if (cancelled) return
      setProductIntegrationId(id ?? null)
      if (!id) { setProductSyncRun(null); setLastProductSync(null); return }
      try {
        const status = await getMarketProductSyncStatus(accountId, id)
        if (!cancelled) { setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun) }
      } catch { if (!cancelled) { setProductSyncRun(null); setLastProductSync(null) } }
    }).catch(() => { if (!cancelled) setProductIntegrationId(null) })
    return () => { cancelled = true }
  }, [accountId])

  // Mensagens de sucesso não devem ficar presas na tela; erro continua
  // visível até a próxima ação (mesmo padrão de antes, sem mudança).
  useEffect(() => {
    if (!message || message.error) return
    const timer = setTimeout(() => setMessage(null), 4000)
    return () => clearTimeout(timer)
  }, [message])

  // Retorna os itens recém-carregados (além de já atualizar itemsState) para
  // que quem chamou possa decidir o próximo passo (avanço automático) sem
  // depender de um closure de estado que ainda não recommitou.
  const loadItems = useCallback(async (purchaseId: string): Promise<MarketPurchaseItem[] | undefined> => {
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
      return items
    } catch {
      setItemsState((prev) => ({ ...prev, [purchaseId]: { loading: false, error: true, items: [], products: {} } }))
      return undefined
    }
  }, [accountId])

  // Avanço automático entre itens: abre sozinho o próximo item ainda pendente
  // de conferência (stockEntryStatus pending + não conferido) da mesma nota,
  // na mesma ordem visual da lista (listMarketPurchaseItems já ordena por
  // line_number). Se ele já tem produto vinculado (conciliado manualmente ou
  // resolvido pelo reprocessamento em cascata), pula direto para a
  // conferência; senão abre o vínculo primeiro. Não abre nada quando não há
  // mais item pendente — quem chama decide parar o fluxo (Cancelar) sem
  // passar por aqui.
  const openNextPendingItem = (purchaseId: string, items: MarketPurchaseItem[]) => {
    const next = items.find((item) => canReviewPurchaseItem(item) && !isHumanReviewed(item))
    if (!next) return
    if (next.marketProductId) setReviewTarget({ purchaseId, item: next })
    else setReconcileTarget({ purchaseId, item: next })
  }

  // itemsAutoResolved > 0 só acontece quando "usar esta correspondência" foi
  // marcado e o mapping recém-persistido resolveu produto de outras linhas
  // pendentes da MESMA compra (RPC de conciliação já reprocessa isso na
  // mesma transação). Resolver produto não é conferir: essas linhas ainda
  // precisam da conferência humana normal antes de poderem ser recebidas.
  const handleReconciled = async (itemsAutoResolved: number) => {
    if (!reconcileTarget) return
    const { purchaseId, item } = reconcileTarget
    const items = await loadItems(purchaseId)
    void load()
    setReconcileTarget(null)
    if (itemsAutoResolved > 0) setMessage({
      error: false,
      text: `Correspondência salva. ${itemsAutoResolved} ${itemsAutoResolved === 1 ? 'outro item foi reconhecido' : 'outros itens foram reconhecidos'} automaticamente.`,
    })
    // Vínculo acabado de salvar: avança direto para a conferência do MESMO
    // item, sem exigir outro clique — nunca confere sozinho, só abre a tela.
    const justConfirmed = items?.find((current) => current.id === item.id)
    if (justConfirmed) setReviewTarget({ purchaseId, item: justConfirmed })
  }

  // onSaved só dispara quando a conferência foi de fato confirmada (ver
  // PurchaseItemReviewDialog.save: uma falha na confirmação cai no catch e
  // nunca chama onSaved) — por isso é o ponto certo para avançar sozinho.
  const handleReviewSaved = async () => {
    if (!reviewTarget) return
    const { purchaseId } = reviewTarget
    const items = await loadItems(purchaseId)
    void load()
    setReviewTarget(null)
    if (items) openNextPendingItem(purchaseId, items)
  }
  // "Dar entrada": único botão, sempre automático sobre todos os itens ainda
  // não recebidos que já estejam conciliados + conversão resolvida +
  // conferidos (isPurchaseItemReadyToReceive). Sem seleção manual de linha.
  // A RPC revalida tudo de novo; a contagem usada aqui é só para a confirmação.
  const confirmReceive = (purchase: MarketPurchaseListItem, items: MarketPurchaseItem[]) => {
    const remaining = items.filter((item) => item.stockEntryStatus !== 'received')
    const ready = remaining.filter(isPurchaseItemReadyToReceive)
    if (!ready.length) return
    const storeName = warehouses.find((store) => store.id === purchase.destinationStoreId)?.name ?? 'do galpão selecionado'
    setReceivePrompt({
      purchaseId: purchase.id, storeName, readyCount: ready.length, remainingCount: remaining.length,
      receivedSoFar: items.length - remaining.length, totalItems: items.length,
    })
  }
  const handleReceive = async () => {
    if (!receivePrompt) return
    const { purchaseId } = receivePrompt
    setReceivingId(purchaseId); setMessage(null)
    try {
      const result = await receivePurchaseReadyItems(accountId, purchaseId)
      setReceivePrompt(null)
      await loadItems(purchaseId); await load()
      setMessage({
        error: false,
        text: result.itemsReceivedTotal === result.itemsTotal
          ? `Entrada registrada: ${result.itemsReceivedNow} ${result.itemsReceivedNow === 1 ? 'item' : 'itens'} lançados no estoque. Compra concluída e movida para o Histórico.`
          : `Entrada registrada: ${result.itemsReceivedNow} ${result.itemsReceivedNow === 1 ? 'item' : 'itens'} lançados agora. ${result.itemsReceivedTotal} recebidos, ${result.itemsTotal - result.itemsReceivedTotal} restantes.`,
      })
    } catch (cause) {
      setReceivePrompt(null)
      setMessage({ error: true, text: cause instanceof Error ? cause.message : 'Não foi possível dar entrada no estoque.' })
      await loadItems(purchaseId); await load()
    } finally { setReceivingId(null) }
  }

  const confirmDelete = (purchase: MarketPurchaseListItem) => setDeletePrompt({ purchaseId: purchase.id, invoiceNumber: purchase.invoiceNumber })
  const handleDelete = async () => {
    if (!deletePrompt) return
    const { purchaseId } = deletePrompt
    setDeletingId(purchaseId); setMessage(null)
    try {
      await deleteImportedPurchase(accountId, purchaseId)
      setDeletePrompt(null)
      setItemsState((prev) => { if (!(purchaseId in prev)) return prev; const next = { ...prev }; delete next[purchaseId]; return next })
      setExpandedId((prev) => (prev === purchaseId ? null : prev))
      await load()
      setMessage({ error: false, text: 'Nota excluída.' })
    } catch (cause) {
      setDeletePrompt(null)
      setMessage({ error: true, text: cause instanceof Error ? cause.message : 'Não foi possível excluir esta nota.' })
      await loadItems(purchaseId); await load()
    } finally { setDeletingId(null) }
  }

  // Reaproveita 100% a sincronização já usada em Estoque/Admin da integração
  // (mesma função de serviço, mesma RPC/edge function, mesma fonte Accesys).
  // Não mexe em nota aberta, item em revisão nem conciliação em andamento:
  // só busca de novo os produtos do card atualmente expandido (loadItems),
  // sem tocar em reviewTarget/reconcileTarget/itemsState de outros cards.
  const syncProducts = async () => {
    if (!productIntegrationId || productSyncing) return
    setProductSyncing(true); setMessage(null)
    try {
      const run = await synchronizeMarketProducts(accountId, productIntegrationId, 'inventory', productSyncRun, setProductSyncRun)
      if (run.status !== 'completed') throw new Error(run.errorMessage || 'Sincronização não concluída.')
      const status = await getMarketProductSyncStatus(accountId, productIntegrationId)
      setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
      if (expandedId) await loadItems(expandedId)
      setMessage({ error: false, text: 'Catálogo de mercadorias atualizado.' })
    } catch (cause) {
      setMessage({ error: true, text: cause instanceof Error ? cause.message : 'Não foi possível atualizar as mercadorias. O catálogo existente foi preservado.' })
      try {
        const status = await getMarketProductSyncStatus(accountId, productIntegrationId)
        setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
      } catch { /* Mantém o último estado confiável carregado. */ }
    } finally { setProductSyncing(false) }
  }

  const itemActions = (purchase: MarketPurchaseListItem, item: MarketPurchaseItem) => {
    if (!canImport || !canReviewPurchaseItem(item) || !['imported','reconciling','pending','ready','receiving'].includes(purchase.status)) return null
    return <div className="market-purchase-items-toolbar">
      <button type="button" className="button button-small" onClick={() => setReviewTarget({ purchaseId:purchase.id,item })}>Revisar dados</button>
      <button type="button" className="button button-small button-outline" onClick={() => setReconcileTarget({ purchaseId:purchase.id,item })}>{item.marketProductId ? 'Trocar produto' : 'Conciliar produto'}</button>
      {item.marketProductId && <button type="button" className="button button-small button-outline" disabled={undoingItemId===item.id} onClick={() => void handleUndo(purchase.id,item.id)}>Desfazer vínculo</button>}
    </div>
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

  // Sempre recarrega ao expandir (não só na primeira vez): dados derivados de
  // conciliação/conversão podem ter mudado desde a última vez que este card
  // esteve aberto (reprocessamento em outra aba, correção de backend com
  // backfill, etc.) — carregar uma única vez por sessão deixava o card preso
  // num snapshot obsoleto até alguma ação explícita forçar outro reload.
  const toggle = (purchaseId: string) => {
    const opening = expandedId !== purchaseId
    setExpandedId(opening ? purchaseId : null)
    if (opening) void loadItems(purchaseId)
  }

  const handleQrDetected = (rawValue: string) => {
    const value = rawValue.trim()
    const isUrl = /^https?:\/\//i.test(value)
    const isAccessKey = /^\d{44}$/.test(value)
    setScannerOpen(false)
    if (!isUrl && !isAccessKey) {
      setScannerError('QR Code não reconhecido como nota fiscal. Tente novamente ou informe os dados manualmente.')
      return
    }
    setScannerError(null)
    setSourceType(isAccessKey ? 'access_key' : 'qrcode_url')
    setSourceValue(value)
  }

  // Comum ao sucesso de uma importacao nova e de uma reimportacao confirmada: atualiza
  // a lista e mostra so o resumo (nao expande automaticamente). Invalida qualquer cache
  // de itens dessa nota — relevante sobretudo na reimportacao, cujos itens antigos nao
  // podem sobrar visiveis — e garante que o card comece/fique recolhido, para que o
  // proximo "Ver itens" sempre busque os dados atualizados.
  const finishSuccessfulImport = async (purchaseId: string, successText: string) => {
    setMessage({ error: false, text: successText })
    setSourceValue('')
    // Invalida o cache e recolhe ANTES do await: se isto rodasse depois de
    // `load()`, uma chamada concorrente de loadItems(purchaseId) (ex.: o
    // auto-expandir após importar PDF) poderia terminar primeiro e ter seu
    // resultado fresco apagado por este cleanup chegando atrasado.
    setItemsState((prev) => {
      if (!(purchaseId in prev)) return prev
      const next = { ...prev }
      delete next[purchaseId]
      return next
    })
    setExpandedId((prev) => (prev === purchaseId ? null : prev))
    await load()
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
            <select
              value={ocrEntrySource ?? sourceType}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'photo' || value === 'pdf' || value === 'ai_text') { setOcrEntrySource(value); return }
                setOcrEntrySource(null)
                setSourceType(value as MarketPurchaseImportSourceType)
              }}
            >
              <option value="access_key">Chave de acesso (44 dígitos)</option>
              <option value="qrcode_url">URL do QR Code</option>
              <option value="photo">Foto / imagem da nota</option>
              <option value="pdf">PDF da nota fiscal</option>
              <option value="ai_text">Texto IA</option>
            </select>
          </label>
          <label>Galpão de destino
            <select required value={destinationStoreId} onChange={(event) => setDestinationStoreId(event.target.value)}>
              <option value="">Selecione</option>
              {warehouses.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
            </select>
          </label>
        </div>
        {!ocrEntrySource && <div className="market-purchase-import-row market-purchase-import-row-main">
          <label>{sourceType === 'access_key' ? <FileKey2 size={16} /> : <Link2 size={16} />} {sourceType === 'access_key' ? 'Chave de 44 dígitos' : 'URL HTTPS do QR Code'}
            <div className="market-purchase-import-input-group">
              <input required value={sourceValue} onChange={(event) => setSourceValue(event.target.value)} placeholder={sourceType === 'access_key' ? 'Cole a chave da nota' : 'https://...'} />
              <button type="button" className="market-scanner-button" onClick={() => { setScannerError(null); setScannerOpen(true) }} aria-label="Ler QR Code da nota" title="Ler QR Code da nota"><QrCode /></button>
            </div>
          </label>
          <button className="button" disabled={importing || !destinationStoreId || !!reimportPrompt}>{importing ? 'Importando...' : 'Importar nota'}</button>
        </div>}
      </form>
      {!ocrEntrySource && scannerError && <div className="admin-message is-error" role="alert">{scannerError} <button type="button" className="button button-small button-outline" onClick={() => { setScannerError(null); setScannerOpen(true) }}>Tentar novamente</button></div>}
      {ocrEntrySource === 'photo' && <PurchasePhotoCapture />}
      {ocrEntrySource === 'pdf' && <PurchasePdfCapture key={accountId} accountId={accountId} destinationStoreId={destinationStoreId}
        onImported={(id) => { void finishSuccessfulImport(id,'PDF salvo no staging. Concilie e confira os itens.').then(() => { setExpandedId(id); void loadItems(id) }) }} />}
      {ocrEntrySource === 'ai_text' && <PurchaseAiTextCapture key={accountId} accountId={accountId} destinationStoreId={destinationStoreId}
        onImported={(id) => { void finishSuccessfulImport(id,'Dados da IA salvos no staging. Concilie e confira os itens.').then(() => { setExpandedId(id); void loadItems(id) }) }} />}
      {!ocrEntrySource && <p className="template-market-note">A nota será importada para conferência antes de entrar no estoque.</p>}
    </section>}
    {scannerOpen && <QrCodeScanner onDetected={handleQrDetected} onClose={() => setScannerOpen(false)} />}
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

    {deletePrompt && <ConfirmDialog
      title="Excluir esta nota importada?"
      description={`Esta ação removerá a nota${deletePrompt.invoiceNumber ? ` ${deletePrompt.invoiceNumber}` : ''} e seus itens. A exclusão é permitida porque nenhum item desta compra foi conciliado, conferido ou recebido.`}
      confirmLabel="Excluir nota"
      processingLabel="Excluindo..."
      processing={deletingId === deletePrompt.purchaseId}
      confirmVariant="destructive"
      onCancel={() => setDeletePrompt(null)}
      onConfirm={() => void handleDelete()}
    />}

    {receivePrompt && <ConfirmDialog
      title={receivePrompt.readyCount === receivePrompt.remainingCount ? 'Dar entrada no estoque?' : 'Dar entrada parcial no estoque?'}
      description={receivePrompt.readyCount === receivePrompt.remainingCount
        ? `${receivePrompt.readyCount} de ${receivePrompt.remainingCount} itens serão lançados no estoque do ${receivePrompt.storeName}. Após a entrada, esses itens ficarão bloqueados para alteração.`
        : `${receivePrompt.readyCount} itens serão lançados agora no estoque do ${receivePrompt.storeName}. Depois desta operação: ${receivePrompt.receivedSoFar + receivePrompt.readyCount} recebidos, ${receivePrompt.totalItems - receivePrompt.receivedSoFar - receivePrompt.readyCount} restantes. Os itens recebidos ficarão bloqueados para alteração.`}
      confirmLabel="Confirmar entrada"
      processingLabel="Registrando entrada..."
      processing={receivingId === receivePrompt.purchaseId}
      confirmVariant="primary"
      onCancel={() => setReceivePrompt(null)}
      onConfirm={() => void handleReceive()}
    />}

    {/* Mesmo card/padrão visual e responsivo de MarketStockDashboard
        (.market-product-sync-card) — reaproveita a classe existente em vez de
        duplicar estilo. Card sempre visível (mesmo sem integração ou para
        quem só consulta); só o botão de ação é restrito por canImport, como
        Estoque restringe por role !== 'viewer'. */}
    <section className="market-product-sync-card">
      <div>
        <span className="panel-kicker">CATÁLOGO</span>
        <h2>Última sincronização de produtos</h2>
        <p>{lastProductSync?.finishedAt ? formatProductSyncDate(lastProductSync.finishedAt) : 'Nenhuma sincronização de produtos concluída.'}</p>
        {lastProductSync && <small>{quantityFormat.format(lastProductSync.receivedCount)} produtos sincronizados</small>}
      </div>
      {canImport && <button className="button button-small" disabled={!productIntegrationId || productSyncing} onClick={() => void syncProducts()}>
        <RefreshCw size={15} /> {productSyncing ? 'Sincronizando...' : productSyncRun?.status === 'running' ? 'Continuar sincronização' : 'Sincronizar produtos'}
      </button>}
    </section>

    <section className="market-dashboard-section">
      <div className="market-section-heading">
        <div><span className="panel-kicker">{activeTab === 'compras' ? 'EM CONFERÊNCIA' : 'HISTÓRICO'}</span><h2>{activeTab === 'compras' ? 'Notas importadas' : 'Compras concluídas'}</h2></div>
        <div className="market-purchase-header-actions">
          <button className="button button-small button-outline" onClick={() => void load()} disabled={loading}><RefreshCw size={15} /> Atualizar</button>
        </div>
      </div>
      <div className="market-purchase-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={activeTab === 'compras'} className={`market-purchase-tab${activeTab === 'compras' ? ' is-active' : ''}`} onClick={() => setActiveTab('compras')}>Compras</button>
        <button type="button" role="tab" aria-selected={activeTab === 'historico'} className={`market-purchase-tab${activeTab === 'historico' ? ' is-active' : ''}`} onClick={() => setActiveTab('historico')}><History size={14} /> Histórico</button>
      </div>
      {(() => {
        const visiblePurchases = purchases.filter((purchase) => (activeTab === 'historico') === (purchase.status === 'completed'))
        return loading ? <div className="admin-message">Carregando notas...</div>
          : !visiblePurchases.length ? <div className="admin-message">{activeTab === 'historico' ? 'Nenhuma compra concluída ainda.' : 'Nenhuma nota importada.'}</div>
          : <div className="market-purchase-list">
        {visiblePurchases.map((purchase) => {
          const expanded = expandedId === purchase.id
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
                <div><dt>Itens da nota</dt><dd>{purchase.totalItems}</dd></div>
                <div><dt>Recebidos</dt><dd>{purchase.receivedItems} / {purchase.totalItems}</dd></div>
                <div><dt>Restantes</dt><dd>{purchase.totalItems - purchase.receivedItems}</dd></div>
                <div><dt>Status</dt><dd><span className={`market-row-status ${purchase.status}`}>{statusLabels[purchase.status]}</span></dd></div>
              </dl>
              <span className="market-purchase-card-toggle">{expanded ? 'Ocultar itens' : 'Ver itens'} <ChevronDown size={16} /></span>
            </button>
            {expanded && <div className="market-purchase-card-items">
              {!state || state.loading ? <p className="market-purchase-card-items-status">Carregando itens...</p>
                : state.error ? <p className="market-purchase-card-items-status">Não foi possível carregar os itens desta nota. <button type="button" className="button button-small button-outline" onClick={() => void loadItems(purchase.id)}>Tentar de novo</button></p>
                : !state.items.length ? <p className="market-purchase-card-items-status">Nenhum item encontrado.</p>
                : (() => {
                    const activeStatuses = ['imported', 'reconciling', 'pending', 'ready', 'receiving']
                    const pendingCount = state.items.filter((item) => !isReconciledStatus(item.reconciliationStatus)).length
                    // Itens já recebidos saem do destaque principal (seção recolhida no
                    // final) para que o operador enxergue primeiro o que ainda falta.
                    const remainingItems = state.items.filter((item) => item.stockEntryStatus !== 'received')
                    const receivedItemsList = state.items.filter((item) => item.stockEntryStatus === 'received')
                    const readyItems = remainingItems.filter(isPurchaseItemReadyToReceive)
                    const canDeleteNote = state.items.every(isPurchaseItemUntouched)
                    return <>
                      <div className="market-purchase-items-toolbar">
                        <p>{pendingCount > 0 ? `${pendingCount} ${pendingCount === 1 ? 'item pendente' : 'itens pendentes'} de conciliação` : 'Todos os itens estão conciliados.'}</p>
                        <button type="button" className="button button-small button-outline" disabled={!canImport || pendingCount === 0 || reprocessingId === purchase.id || !activeStatuses.includes(purchase.status)} onClick={() => void handleReprocess(purchase.id)}>
                          {reprocessingId === purchase.id ? 'Reprocessando...' : 'Reprocessar pendentes'}
                        </button>
                      </div>
                      <div className="market-purchase-items-toolbar">
                        <p>{state.items.filter(isHumanReviewed).length} / {state.items.length} itens conferidos pelo operador. Match automático não é conferência.</p>
                        {canImport && canDeleteNote && <button type="button" className="button button-small button-outline" onClick={() => confirmDelete(purchase)}><Trash2 size={14} /> Excluir nota</button>}
                      </div>
                      {remainingItems.length > 0 && <div className="market-purchase-items-list">{remainingItems.map((item) => {
                        const reconciled = isReconciledStatus(item.reconciliationStatus)
                        const product = item.marketProductId ? state.products[item.marketProductId] : undefined
                        const reviewed = isHumanReviewed(item)
                        return <article key={item.id} className="market-purchase-item-row">
                          <div className="market-purchase-item-row-summary">
                            <span className="market-purchase-item-row-line">Linha {item.lineNumber}</span>
                            <strong className="market-purchase-item-row-desc">{item.descriptionRaw || '-'}</strong>
                            <span className="market-purchase-item-row-qty">{quantityFormat.format(item.quantity)} {item.unit || ''}</span>
                            <span className={`market-row-status ${item.reconciliationStatus}`}>{reconciliationLabels[item.reconciliationStatus]}</span>
                            <span className={`market-purchase-item-row-review${reviewed ? ' is-reviewed' : ''}`}>{reviewed ? 'Conferido pelo operador' : 'Não conferido'}</span>
                          </div>
                          {reconciled && product && <div className="market-purchase-item-product">
                            <strong>{product.name}</strong>
                            <span>{product.sku ? `SKU ${product.sku}` : 'Sem SKU'}{item.reconciliationMethod ? ` · ${reconciliationMethodLabels[item.reconciliationMethod] ?? item.reconciliationMethod}` : ''}</span>
                          </div>}
                          <dl className="market-purchase-item-row-details">
                            <div><dt>Código do fornecedor</dt><dd>{item.supplierProductCode || '-'}</dd></div>
                            <div><dt>Valor unitário</dt><dd>{formatMoney(item.unitPrice)}</dd></div>
                            <div><dt>Total da linha</dt><dd>{formatMoney(item.grossAmount)}</dd></div>
                            <div><dt>Custo</dt><dd>Documento: {formatMoney(item.calculatedUnitCost)}/{item.unit || ''} · Estoque: {formatStockUnitCost(item)}</dd></div>
                            {reconciled && <div><dt>Entrada prevista</dt><dd>{formatStockEntry(item)}</dd></div>}
                          </dl>
                          {itemActions(purchase, item)}
                        </article>
                      })}</div>}
                      {canImport && readyItems.length > 0 && activeStatuses.includes(purchase.status) && <div className="market-purchase-items-toolbar">
                        <p>{readyItems.length} de {remainingItems.length} {remainingItems.length === 1 ? 'item pronto' : 'itens prontos'} para entrada no estoque.</p>
                        <button type="button" className="button" disabled={receivingId === purchase.id} onClick={() => confirmReceive(purchase, state.items)}>
                          <PackageCheck size={16} /> {readyItems.length === remainingItems.length ? 'Dar entrada no estoque' : 'Dar entrada dos itens prontos'}
                        </button>
                      </div>}
                      {receivedItemsList.length > 0 && <details className="market-purchase-received-section">
                        <summary>Recebidos no estoque ({receivedItemsList.length})</summary>
                        <div className="market-purchase-items-list">{receivedItemsList.map((item) => {
                          const product = item.marketProductId ? state.products[item.marketProductId] : undefined
                          const totalCost = item.stockQuantity !== null && item.stockUnitCost !== null ? item.stockQuantity * item.stockUnitCost : null
                          return <article key={item.id} className="market-purchase-item-row market-purchase-item-row-received">
                            <div className="market-purchase-item-row-summary">
                              <span className="market-purchase-item-row-line">Linha {item.lineNumber}</span>
                              <strong className="market-purchase-item-row-desc">{item.descriptionRaw || '-'}</strong>
                              <span className="market-purchase-item-row-review is-reviewed">Recebido</span>
                            </div>
                            {product && <div className="market-purchase-item-product"><strong>{product.name}</strong>{product.sku && <span>SKU {product.sku}</span>}</div>}
                            <dl className="market-purchase-item-row-details">
                              <div><dt>Quantidade recebida</dt><dd>{formatStockEntry(item)}</dd></div>
                              <div><dt>Custo unitário</dt><dd>{item.stockUnitCost !== null ? formatMoney(item.stockUnitCost) : '-'}</dd></div>
                              <div><dt>Custo total</dt><dd>{totalCost !== null ? formatMoney(totalCost) : '-'}</dd></div>
                              <div><dt>Recebido em</dt><dd>{item.receivedAt ? dateTimeFormat.format(new Date(item.receivedAt)) : '-'}</dd></div>
                            </dl>
                          </article>
                        })}</div>
                      </details>}
                    </>
                  })()}
            </div>}
          </article>
        })}
      </div>
      })()}
    </section>

    {reconcileTarget && <PurchaseItemReconciliationDialog
      accountId={accountId}
      item={reconcileTarget.item}
      onCancel={() => setReconcileTarget(null)}
      onConfirmed={handleReconciled}
    />}
    {reviewTarget && <PurchaseItemReviewDialog key={reviewTarget.item.id} accountId={accountId} item={reviewTarget.item}
      onCancel={() => setReviewTarget(null)} onSaved={handleReviewSaved} />}
  </>
}
