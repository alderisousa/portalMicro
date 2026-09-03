import { CheckCircle2, CircleAlert, KeyRound, PackageSearch, PlugZap, RefreshCw } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import {
  ACCESYS_BASE_URL,
  findAccesysIntegrationId,
  getMarketProductSyncStatus,
  getMarketIntegration,
  previewMarketProducts,
  saveMarketIntegration,
  synchronizeMarketProducts,
  syncMarketSales,
  testMarketIntegration,
} from '../services/marketIntegration'
import type {
  MarketIntegrationConfiguration,
  MarketIntegrationStatus,
  MarketProductCatalogPreview,
  MarketProductSyncRun,
  MarketSalesSyncResult,
} from '../types/marketIntegration'

interface AdminMarketIntegrationProps {
  marketAccountId: string
}

type FormState = {
  externalCompanyId: string
  username: string
  password: string
  status: MarketIntegrationStatus
}

type Feedback = { type: 'success' | 'error'; message: string }
type SyncPeriod = { startDate: string; endDate: string }

const emptyForm: FormState = {
  externalCompanyId: '',
  username: '',
  password: '',
  status: 'inactive',
}

const todayInputValue = () => {
  const today = new Date()
  const year = today.getFullYear()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const formatInputDate = (value: string) => {
  const [year, month, day] = value.split('-')
  return `${day}/${month}/${year}`
}

const syncStatusLabels = {
  running: 'Em andamento',
  completed: 'Concluído',
  partial: 'Concluído com pendências',
  failed: 'Falhou',
} as const

const formatTestDate = (value: string | null) => {
  if (!value) return 'Ainda não realizado'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Data indisponível'
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date)
}

const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

export function AdminMarketIntegration({ marketAccountId }: AdminMarketIntegrationProps) {
  const [integration, setIntegration] = useState<MarketIntegrationConfiguration | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [previewingProducts, setPreviewingProducts] = useState(false)
  const [productSyncing, setProductSyncing] = useState(false)
  const [productSyncRun, setProductSyncRun] = useState<MarketProductSyncRun | null>(null)
  const [lastCompletedProductSyncRun, setLastCompletedProductSyncRun] = useState<MarketProductSyncRun | null>(null)
  const [productPreview, setProductPreview] = useState<MarketProductCatalogPreview | null>(null)
  const [productPreviewFeedback, setProductPreviewFeedback] = useState<Feedback | null>(null)
  const [productPreviewPage, setProductPreviewPage] = useState(1)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [syncFeedback, setSyncFeedback] = useState<Feedback | null>(null)
  const [syncResult, setSyncResult] = useState<MarketSalesSyncResult | null>(null)
  const [pendingSyncPeriod, setPendingSyncPeriod] = useState<SyncPeriod | null>(null)
  const [startDate, setStartDate] = useState(todayInputValue)
  const [endDate, setEndDate] = useState(todayInputValue)
  const syncInFlight = useRef(false)

  const applyIntegration = useCallback((value: MarketIntegrationConfiguration) => {
    setIntegration(value)
    setForm({
      externalCompanyId: value.externalCompanyId,
      username: value.username ?? '',
      password: '',
      status: value.status === 'active' ? 'active' : 'inactive',
    })
  }, [])

  const loadIntegration = useCallback(async () => {
    setLoading(true)
    setFeedback(null)
    setSyncFeedback(null)
    setPendingSyncPeriod(null)
    try {
      const integrationId = await findAccesysIntegrationId(marketAccountId)
      if (!integrationId) {
        setIntegration(null)
        setForm(emptyForm)
        return
      }
      const loaded = await getMarketIntegration(marketAccountId, integrationId)
      applyIntegration(loaded)
      const productStatus = await getMarketProductSyncStatus(marketAccountId, integrationId)
      setProductSyncRun(productStatus.run); setLastCompletedProductSyncRun(productStatus.lastCompletedRun)
    } catch (error) {
      setFeedback({
        type: 'error',
        message: safeMessage(error, 'Não foi possível carregar a integração Accesys.'),
      })
    } finally {
      setLoading(false)
    }
  }, [applyIntegration, marketAccountId])

  useEffect(() => { void loadIntegration() }, [loadIntegration])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (syncInFlight.current || syncing) return
    if (!form.externalCompanyId.trim() || !form.username.trim()) {
      setFeedback({ type: 'error', message: 'Informe o Company ID e o usuário da integração.' })
      return
    }
    if (!integration?.hasCredentials && !form.password) {
      setFeedback({ type: 'error', message: 'Informe a senha na primeira configuração.' })
      return
    }

    setSaving(true)
    setFeedback(null)
    try {
      const saved = await saveMarketIntegration({
        marketAccountId,
        integrationId: integration?.id,
        externalCompanyId: form.externalCompanyId,
        username: form.username,
        status: form.status,
        ...(form.password ? { password: form.password } : {}),
      })
      applyIntegration(saved)
      setFeedback({ type: 'success', message: 'Configuração da integração salva com segurança.' })
    } catch (error) {
      setFeedback({
        type: 'error',
        message: safeMessage(error, 'Não foi possível salvar a integração.'),
      })
    } finally {
      setSaving(false)
    }
  }

  const testConnection = async () => {
    if (!integration?.id || !integration.hasCredentials || testing || syncInFlight.current || syncing) return
    setTesting(true)
    setFeedback(null)
    try {
      await testMarketIntegration(marketAccountId, integration.id)
      const refreshed = await getMarketIntegration(marketAccountId, integration.id)
      applyIntegration(refreshed)
      setFeedback({ type: 'success', message: 'Conexão realizada com sucesso.' })
    } catch (error) {
      setFeedback({
        type: 'error',
        message: safeMessage(error, 'Falha ao testar a conexão da integração.'),
      })
      try {
        applyIntegration(await getMarketIntegration(marketAccountId, integration.id))
      } catch {
        // Mantém o erro sanitizado do teste; nenhum dado sensível é registrado.
      }
    } finally {
      setTesting(false)
    }
  }

  const requestSalesSync = () => {
    if (!integration?.id || syncInFlight.current || syncing || saving || testing) return
    setSyncFeedback(null)
    setSyncResult(null)
    if (!startDate || !endDate) {
      setSyncFeedback({ type: 'error', message: 'Informe a data inicial e a data final.' })
      return
    }
    const start = Date.parse(`${startDate}T00:00:00Z`)
    const end = Date.parse(`${endDate}T00:00:00Z`)
    const periodDays = Math.floor((end - start) / 86_400_000) + 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || periodDays < 1) {
      setSyncFeedback({ type: 'error', message: 'A data inicial deve ser anterior ou igual à data final.' })
      return
    }
    if (periodDays > 31) {
      setSyncFeedback({ type: 'error', message: 'O período máximo por sincronização é de 31 dias.' })
      return
    }
    setPendingSyncPeriod({ startDate, endDate })
  }

  const synchronizeSales = async () => {
    if (!integration?.id || !pendingSyncPeriod || syncInFlight.current || syncing || saving || testing) return
    const period = pendingSyncPeriod
    syncInFlight.current = true
    setPendingSyncPeriod(null)
    setSyncing(true)
    try {
      let runId = syncResult && (syncResult.status === 'failed' || syncResult.status === 'running') &&
          syncResult.period.startDate === period.startDate && syncResult.period.endDate === period.endDate
        ? syncResult.syncRunId : undefined
      let result: MarketSalesSyncResult
      do {
        result = await syncMarketSales({ marketAccountId, integrationId: integration.id,
          startDate: period.startDate, endDate: period.endDate, runId })
        setSyncResult(result)
        runId = result.syncRunId
      } while (result.continue)
      setSyncResult(result)
      setSyncFeedback(result.status === 'failed'
        ? { type: 'error', message: 'A sincronização falhou. Consulte o resumo e o ID da execução.' }
        : result.status === 'partial'
          ? { type: 'error', message: 'A sincronização terminou com pendências. Alguns pedidos não foram processados.' }
          : { type: 'success', message: 'Sincronização de vendas concluída.' })
    } catch (error) {
      setSyncFeedback({
        type: 'error',
        message: safeMessage(error, 'Não foi possível executar a sincronização de vendas.'),
      })
    } finally {
      syncInFlight.current = false
      setSyncing(false)
    }
  }

  const previewProducts = async () => {
    if (!integration?.id || previewingProducts || productSyncing || saving || testing || syncing) return
    setPreviewingProducts(true); setProductPreview(null); setProductPreviewFeedback(null)
    try {
      const preview = await previewMarketProducts(marketAccountId, integration.id, productPreviewPage)
      setProductPreview(preview)
      setProductPreviewFeedback({ type: 'success', message: `${preview.returnedCount} produtos encontrados nesta página.` })
    } catch (error) {
      setProductPreviewFeedback({ type: 'error', message: safeMessage(error, 'Não foi possível consultar o catálogo de produtos.') })
    } finally { setPreviewingProducts(false) }
  }

  const synchronizeProducts = async () => {
    if (!integration?.id || productSyncing || previewingProducts || saving || testing || syncing) return
    setProductSyncing(true); setProductPreviewFeedback(null)
    try {
      const run = await synchronizeMarketProducts(marketAccountId, integration.id, 'admin', productSyncRun, setProductSyncRun)
      if (run.status === 'completed') setLastCompletedProductSyncRun(run)
      setProductPreviewFeedback(run.status === 'completed'
        ? { type: 'success', message: 'Catálogo de produtos sincronizado com sucesso.' }
        : { type: 'error', message: run.errorMessage || 'A sincronização não foi concluída.' })
    } catch (error) {
      setProductPreviewFeedback({ type: 'error', message: safeMessage(error, 'A sincronização foi interrompida. Use Continuar para retomar da última página confirmada.') })
      try { const status = await getMarketProductSyncStatus(marketAccountId, integration.id); setProductSyncRun(status.run); setLastCompletedProductSyncRun(status.lastCompletedRun) } catch { /* Mantém o último progresso conhecido. */ }
    } finally { setProductSyncing(false) }
  }

  return <section className="admin-market-block admin-integration-section">
    <div className="admin-list-heading">
      <div><span className="panel-kicker">INTEGRAÇÕES</span><h2>Integração Accesys</h2></div>
      <span className={`admin-status ${form.status === 'active' ? 'published' : 'paused'}`}>
        {form.status === 'active' ? 'Ativa' : 'Inativa'}
      </span>
    </div>
    <p className="admin-integration-intro">Configuração centralizada e disponível somente para o Admin global GiroMicro.</p>
    {feedback && <p className={`admin-feedback ${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
    {loading ? <div className="admin-message" role="status"><RefreshCw size={18} /> Carregando integração...</div> : <>
      <form className="admin-inline-form admin-integration-form" onSubmit={save}>
        <div className="admin-form-row">
          <label>Provider<select value="accesys" disabled aria-label="Provider"><option value="accesys">Accesys</option></select></label>
          <label>Status<select value={form.status} disabled={saving || testing || syncing} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as MarketIntegrationStatus }))}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>
        </div>
        <div className="admin-form-row">
          <label>Company ID<strong aria-hidden="true"> *</strong><input required autoComplete="off" value={form.externalCompanyId} disabled={saving || testing || syncing} onChange={(event) => setForm((current) => ({ ...current, externalCompanyId: event.target.value }))} /></label>
          <label>URL da API<input readOnly value={ACCESYS_BASE_URL} aria-describedby="accesys-url-note" /></label>
        </div>
        <p id="accesys-url-note" className="admin-form-note">Host oficial validado pelo backend. Esta URL não pode ser alterada nesta fase.</p>
        <div className="admin-form-row admin-integration-credentials">
          <label>Usuário / e-mail<strong aria-hidden="true"> *</strong><input required type="text" autoComplete="off" value={form.username} disabled={saving || testing || syncing} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} /></label>
          <label>Senha{!integration?.hasCredentials && <strong aria-hidden="true"> *</strong>}<input type="password" required={!integration?.hasCredentials} autoComplete="new-password" value={form.password} disabled={saving || testing || syncing} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} /></label>
        </div>
        <div className={`admin-credential-state ${integration?.hasCredentials ? 'is-configured' : ''}`}>
          <KeyRound size={17} />
          <div><strong>{integration?.hasCredentials ? 'Senha configurada' : 'Senha ainda não configurada'}</strong><span>{integration?.hasCredentials ? 'Deixe o campo vazio para manter a senha atual.' : 'A senha é obrigatória na primeira configuração.'}</span></div>
        </div>
        <div className="admin-form-actions"><button className="button button-small" disabled={saving || testing || syncing}>{saving ? 'Salvando...' : 'Salvar configuração'}</button></div>
      </form>

      <div className="admin-integration-test">
        <div>
          <span className="panel-kicker">TESTE DA CONEXÃO</span>
          <h3>Validar acesso à Accesys</h3>
          <dl><div><dt>Último teste</dt><dd>{formatTestDate(integration?.lastTestAt ?? null)}</dd></div><div><dt>Resultado</dt><dd className={integration?.lastTestSucceeded === true ? 'is-success' : integration?.lastTestSucceeded === false ? 'is-error' : ''}>{integration?.lastTestSucceeded === true ? <><CheckCircle2 size={16} /> Conexão realizada com sucesso.</> : integration?.lastTestSucceeded === false ? <><CircleAlert size={16} /> {integration.lastTestError || 'Falha ao validar a conexão.'}</> : 'Aguardando primeiro teste.'}</dd></div></dl>
        </div>
        <button type="button" className="button button-small button-outline" disabled={!integration?.id || !integration.hasCredentials || saving || testing || syncing} onClick={() => void testConnection()}>{testing ? <><RefreshCw size={15} /> Testando...</> : <><PlugZap size={15} /> Testar conexão</>}</button>
      </div>
      {!integration?.id && <p className="admin-form-note">Salve a primeira configuração antes de testar a conexão.</p>}

      <div className="admin-sales-sync admin-product-sync">
        <div className="admin-sales-sync-heading">
          <div><span className="panel-kicker">CATÁLOGO</span><h3>Produtos</h3></div>
          <p>Consulte uma amostra ou sincronize o catálogo em páginas confirmadas e resumíveis. Estoque e configuração por loja não são alterados.</p>
        </div>
        <div className="admin-sales-sync-form">
          <label>Página do preview<input type="number" min="1" step="1" value={productPreviewPage} disabled={previewingProducts || productSyncing || saving || testing || syncing} onChange={(event) => setProductPreviewPage(Math.max(1, Number.parseInt(event.target.value, 10) || 1))} /></label>
          <button type="button" className="button button-small button-outline" disabled={!integration?.id || integration.status !== 'active' || !integration.hasCredentials || previewingProducts || productSyncing || saving || testing || syncing} onClick={() => void previewProducts()}>{previewingProducts ? <><RefreshCw size={15} /> Consultando...</> : <><PackageSearch size={15} /> Ver preview</>}</button>
          <button type="button" className="button button-small" disabled={!integration?.id || integration.status !== 'active' || !integration.hasCredentials || previewingProducts || productSyncing || saving || testing || syncing} onClick={() => void synchronizeProducts()}>{productSyncing ? <><RefreshCw size={15} /> Sincronizando...</> : productSyncRun?.status === 'running' ? 'Continuar sincronização' : 'Sincronizar produtos'}</button>
        </div>
        {(!integration?.id || integration.status !== 'active' || !integration.hasCredentials) && <p className="admin-form-note">A integração precisa estar ativa e com credenciais configuradas.</p>}
        {productPreviewFeedback && <p className={`admin-feedback ${productPreviewFeedback.type}`} role={productPreviewFeedback.type === 'error' ? 'alert' : 'status'}>{productPreviewFeedback.message}</p>}
        {productSyncRun && <div className={`admin-sales-sync-result is-${productSyncRun.status}`}>
          <div className="admin-sales-sync-result-heading"><strong>Status: {productSyncRun.status}</strong><small>Run: {productSyncRun.id}</small></div>
          <dl className="admin-sales-sync-metrics"><div><dt>Progresso</dt><dd>{productSyncRun.currentPage} / {productSyncRun.totalPages ?? '?'}</dd></div><div><dt>Recebidos</dt><dd>{productSyncRun.receivedCount}</dd></div><div><dt>Criados</dt><dd>{productSyncRun.createdCount}</dd></div><div><dt>Atualizados</dt><dd>{productSyncRun.updatedCount}</dd></div><div><dt>Sem alteração</dt><dd>{productSyncRun.unchangedCount}</dd></div><div><dt>Ignorados</dt><dd>{productSyncRun.ignoredCount}</dd></div></dl>
          {productSyncRun.errorMessage && <p>{productSyncRun.errorMessage}</p>}
        </div>}
        {lastCompletedProductSyncRun && lastCompletedProductSyncRun.id !== productSyncRun?.id && <p className="admin-form-note">Última conclusão: {formatTestDate(lastCompletedProductSyncRun.finishedAt)} · {lastCompletedProductSyncRun.receivedCount} recebidos.</p>}
        {productPreview && <div className="admin-sales-sync-result is-completed">
          <div className="admin-sales-sync-result-heading"><strong>Preview do catálogo</strong><small>HTTP {productPreview.providerHttpStatus} · página {productPreview.requestedPage} · limite {productPreview.pageSize}</small></div>
          <dl className="admin-sales-sync-metrics"><div><dt>Tipo da raiz</dt><dd>{productPreview.rootType}</dd></div><div><dt>Coleção</dt><dd>{productPreview.collectionKey ?? 'raiz'}</dd></div><div><dt>Registros</dt><dd>{productPreview.returnedCount}</dd></div></dl>
          <div className="admin-sales-sync-details"><h4>Chaves da raiz</h4><p>{productPreview.rootKeys.join(', ') || 'Nenhuma'}</p><h4>Chaves dos produtos</h4><p>{productPreview.productKeys.join(', ') || 'Nenhuma'}</p><h4>Paginação</h4><pre>{JSON.stringify(productPreview.paginationMetadata, null, 2)}</pre>{productPreview.products.length > 0 && <><h4>Amostra sanitizada</h4><pre>{JSON.stringify(productPreview.products, null, 2)}</pre></>}</div>
        </div>}
      </div>

      <div className="admin-sales-sync">
        <div className="admin-sales-sync-heading">
          <div><span className="panel-kicker">EXECUÇÃO MANUAL</span><h3>Sincronização de vendas</h3></div>
          <p>Consulta a empresa Accesys e persiste vendas, itens e pagamentos. Não altera o estoque.</p>
        </div>
        <div className="admin-sales-sync-form">
          <label>Data inicial<strong aria-hidden="true"> *</strong><input type="date" required value={startDate} disabled={syncing || saving || testing} onChange={(event) => setStartDate(event.target.value)} /></label>
          <label>Data final<strong aria-hidden="true"> *</strong><input type="date" required value={endDate} disabled={syncing || saving || testing} onChange={(event) => setEndDate(event.target.value)} /></label>
          <button type="button" className="button button-small" disabled={!integration?.id || integration.status !== 'active' || !integration.hasCredentials || syncing || saving || testing} onClick={requestSalesSync}>{syncing ? <><RefreshCw size={15} /> Sincronizando...</> : syncResult && (syncResult.status === 'failed' || syncResult.status === 'running') ? 'Continuar sincronização' : 'Sincronizar vendas'}</button>
        </div>
        {(!integration?.id || integration.status !== 'active' || !integration.hasCredentials) && <p className="admin-form-note">A integração precisa estar ativa e com credenciais configuradas.</p>}
        {syncFeedback && <p className={`admin-feedback ${syncFeedback.type}`} role={syncFeedback.type === 'error' ? 'alert' : 'status'}>{syncFeedback.message}</p>}
        {syncResult && <div className={`admin-sales-sync-result is-${syncResult.status}`}>
          <div className="admin-sales-sync-result-heading"><strong>Status: {syncStatusLabels[syncResult.status]}</strong><small>Sync run: {syncResult.syncRunId}</small></div>
          <dl className="admin-sales-sync-metrics">
            <div><dt>Pedidos lidos</dt><dd>{syncResult.ordersRead}</dd></div>
            <div><dt>Novos pedidos</dt><dd>{syncResult.ordersInserted}</dd></div>
            <div><dt>Pedidos atualizados</dt><dd>{syncResult.ordersUpdated}</dd></div>
            <div><dt>Itens processados</dt><dd>{syncResult.itemsProcessed}</dd></div>
            <div><dt>Pagamentos processados</dt><dd>{syncResult.paymentsProcessed}</dd></div>
            <div><dt>Pedidos ignorados</dt><dd>{syncResult.skippedOrders}</dd></div>
            <div><dt>Páginas lidas</dt><dd>{syncResult.pagesRead}</dd></div>
            <div><dt>Dias concluídos</dt><dd>{syncResult.completedDays} / {syncResult.totalDays}</dd></div>
            <div><dt>Último dia</dt><dd>{syncResult.lastCompletedDay ? formatInputDate(syncResult.lastCompletedDay) : '—'}</dd></div>
          </dl>
          {syncResult.unmappedSites.length > 0 && <div className="admin-sales-sync-details"><h4>Lojas sem mapeamento</h4><ul>{syncResult.unmappedSites.map((site) => <li key={site.externalStoreId}><strong>{site.externalStoreId}</strong>{site.siteName ? ` — ${site.siteName}` : ''}</li>)}</ul></div>}
          {syncResult.errors.length > 0 && <div className="admin-sales-sync-details"><h4>Pedidos com pendências</h4><ul>{syncResult.errors.map((error, index) => <li key={`${error.externalOrderId ?? 'unknown'}-${index}`}>Pedido: {error.externalOrderId ?? 'não informado'} · Loja: {error.externalStoreId ?? 'não informada'} · Código: <strong>{error.code}</strong></li>)}</ul></div>}
        </div>}
      </div>
      {pendingSyncPeriod && <ConfirmDialog
        title="Sincronizar vendas?"
        description={`Confirma a sincronização das vendas da Accesys de ${formatInputDate(pendingSyncPeriod.startDate)} até ${formatInputDate(pendingSyncPeriod.endDate)}?`}
        confirmLabel={syncResult && (syncResult.status === 'failed' || syncResult.status === 'running') ? 'Continuar sincronização' : 'Sincronizar vendas'}
        processingLabel="Sincronizando..."
        processing={false}
        confirmVariant="primary"
        onCancel={() => setPendingSyncPeriod(null)}
        onConfirm={() => void synchronizeSales()}
      />}
    </>}
  </section>
}
