import { CheckCircle2, CircleAlert, KeyRound, PlugZap, RefreshCw } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import {
  ACCESYS_BASE_URL,
  findAccesysIntegrationId,
  getMarketIntegration,
  saveMarketIntegration,
  testMarketIntegration,
} from '../services/marketIntegration'
import type { MarketIntegrationConfiguration, MarketIntegrationStatus } from '../types/marketIntegration'

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

const emptyForm: FormState = {
  externalCompanyId: '',
  username: '',
  password: '',
  status: 'inactive',
}

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
  const [feedback, setFeedback] = useState<Feedback | null>(null)

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
    try {
      const integrationId = await findAccesysIntegrationId(marketAccountId)
      if (!integrationId) {
        setIntegration(null)
        setForm(emptyForm)
        return
      }
      applyIntegration(await getMarketIntegration(marketAccountId, integrationId))
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
    if (!integration?.id || !integration.hasCredentials || testing) return
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
          <label>Status<select value={form.status} disabled={saving || testing} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as MarketIntegrationStatus }))}><option value="active">Ativa</option><option value="inactive">Inativa</option></select></label>
        </div>
        <div className="admin-form-row">
          <label>Company ID<strong aria-hidden="true"> *</strong><input required autoComplete="off" value={form.externalCompanyId} disabled={saving || testing} onChange={(event) => setForm((current) => ({ ...current, externalCompanyId: event.target.value }))} /></label>
          <label>URL da API<input readOnly value={ACCESYS_BASE_URL} aria-describedby="accesys-url-note" /></label>
        </div>
        <p id="accesys-url-note" className="admin-form-note">Host oficial validado pelo backend. Esta URL não pode ser alterada nesta fase.</p>
        <div className="admin-form-row admin-integration-credentials">
          <label>Usuário / e-mail<strong aria-hidden="true"> *</strong><input required type="text" autoComplete="off" value={form.username} disabled={saving || testing} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} /></label>
          <label>Senha{!integration?.hasCredentials && <strong aria-hidden="true"> *</strong>}<input type="password" required={!integration?.hasCredentials} autoComplete="new-password" value={form.password} disabled={saving || testing} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} /></label>
        </div>
        <div className={`admin-credential-state ${integration?.hasCredentials ? 'is-configured' : ''}`}>
          <KeyRound size={17} />
          <div><strong>{integration?.hasCredentials ? 'Senha configurada' : 'Senha ainda não configurada'}</strong><span>{integration?.hasCredentials ? 'Deixe o campo vazio para manter a senha atual.' : 'A senha é obrigatória na primeira configuração.'}</span></div>
        </div>
        <div className="admin-form-actions"><button className="button button-small" disabled={saving || testing}>{saving ? 'Salvando...' : 'Salvar configuração'}</button></div>
      </form>

      <div className="admin-integration-test">
        <div>
          <span className="panel-kicker">TESTE DA CONEXÃO</span>
          <h3>Validar acesso à Accesys</h3>
          <dl><div><dt>Último teste</dt><dd>{formatTestDate(integration?.lastTestAt ?? null)}</dd></div><div><dt>Resultado</dt><dd className={integration?.lastTestSucceeded === true ? 'is-success' : integration?.lastTestSucceeded === false ? 'is-error' : ''}>{integration?.lastTestSucceeded === true ? <><CheckCircle2 size={16} /> Conexão realizada com sucesso.</> : integration?.lastTestSucceeded === false ? <><CircleAlert size={16} /> {integration.lastTestError || 'Falha ao validar a conexão.'}</> : 'Aguardando primeiro teste.'}</dd></div></dl>
        </div>
        <button type="button" className="button button-small button-outline" disabled={!integration?.id || !integration.hasCredentials || saving || testing} onClick={() => void testConnection()}>{testing ? <><RefreshCw size={15} /> Testando...</> : <><PlugZap size={15} /> Testar conexão</>}</button>
      </div>
      {!integration?.id && <p className="admin-form-note">Salve a primeira configuração antes de testar a conexão.</p>}
    </>}
  </section>
}
