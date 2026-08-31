import { ArrowLeft, Link2, Pencil, Plus, Save, Store, Trash2 } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { ConfirmDialog } from '../components/ConfirmDialog'
import {
  createMarketAccount,
  getAuthenticatedUser,
  linkUserToBusiness,
  listUserBusinesses,
  setBusinessPlan,
  unlinkUserFromBusiness,
  updateBusinessMember,
} from '../services/adminUsers'
import { listUserMarketAccounts } from '../services/market'
import type {
  AdminAuthenticatedUser,
  AdminUserBusiness,
  AdminUserDetail as AdminUserDetailData,
  BusinessMemberRole,
  BusinessMemberStatus,
  BusinessPlanCode,
} from '../types/adminUsers'
import type { AdminBusinessSummary } from '../types/business'
import type { AdminUserMarketAccount, MarketPlanCode } from '../types/market'
import { formatAdminDate, providerLabel, UserAvatar, userDisplayName } from './AdminUsers'

interface AdminUserDetailProps {
  selectedUser: AdminAuthenticatedUser
  businesses: AdminBusinessSummary[]
  onBack: () => void
  onEditBusiness: (businessId: string) => void
  onManageMarket: (accountId: string) => void
  onUserChanged: () => void
}

type Feedback = { type: 'success' | 'error'; message: string }
type Confirmation =
  | { type: 'owner'; business: AdminUserBusiness; role: BusinessMemberRole; status: BusinessMemberStatus }
  | { type: 'unlink'; business: AdminUserBusiness }

const roles: { value: BusinessMemberRole; label: string }[] = [
  { value: 'owner', label: 'Proprietário' },
  { value: 'admin', label: 'Administrador' },
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Visualização' },
]
const plans: { value: BusinessPlanCode; label: string }[] = [
  { value: 'free', label: 'Free' },
  { value: 'pilot', label: 'Pilot' },
  { value: 'pro', label: 'Pro' },
]

const roleLabel = (value: string) => roles.find((role) => role.value === value)?.label ?? value
const statusLabel = (value: string) => value === 'active' ? 'Ativo' : value === 'disabled' ? 'Desabilitado' : value
const businessStatusLabel = (value: string) => value === 'published' ? 'Publicado' : value === 'draft' ? 'Rascunho' : value
const templateLabel = (value: string | null) => value === 'featured' ? 'Destaque' : value === 'essential' ? 'Essencial' : value === 'market' ? 'Market' : value || 'Não definido'
const marketRoleLabel = (value: string) => ({ owner: 'Proprietário', admin: 'Administrador', manager: 'Gerente', operator: 'Operador', viewer: 'Visualização' }[value] ?? value)
const marketStatusLabel = (value: string) => value === 'active' ? 'Ativo' : value === 'invited' ? 'Convidado' : 'Desabilitado'
const marketAccountStatusLabel = (value: string) => value === 'pilot' ? 'Piloto' : value === 'active' ? 'Ativo' : value === 'suspended' ? 'Suspenso' : 'Cancelado'

export function AdminUserDetail({ selectedUser, businesses, onBack, onEditBusiness, onManageMarket, onUserChanged }: AdminUserDetailProps) {
  const [user, setUser] = useState<AdminUserDetailData | null>(null)
  const [links, setLinks] = useState<AdminUserBusiness[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [processing, setProcessing] = useState('')
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [showLinkForm, setShowLinkForm] = useState(false)
  const [linkBusinessId, setLinkBusinessId] = useState('')
  const [linkRole, setLinkRole] = useState<BusinessMemberRole>('viewer')
  const [makeLegacyOwner, setMakeLegacyOwner] = useState(false)
  const [showMarketForm, setShowMarketForm] = useState(false)
  const [marketName, setMarketName] = useState('')
  const [marketPlan, setMarketPlan] = useState<MarketPlanCode>('pilot')
  const [marketAccounts, setMarketAccounts] = useState<AdminUserMarketAccount[]>([])

  const loadData = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')
    try {
      const [userData, userBusinesses, userMarketAccounts] = await Promise.all([
        getAuthenticatedUser(selectedUser.user_id),
        listUserBusinesses(selectedUser.user_id),
        listUserMarketAccounts(selectedUser.user_id),
      ])
      if (!userData) throw new Error('Usuário não encontrado')
      setUser(userData)
      setLinks(userBusinesses)
      setMarketAccounts(userMarketAccounts)
    } catch (error) {
      console.error('Falha ao carregar detalhes do usuário:', error)
      setErrorMessage('Não foi possível carregar os dados deste usuário.')
    } finally {
      setLoading(false)
    }
  }, [selectedUser.user_id])

  useEffect(() => { void loadData() }, [loadData])

  const availableBusinesses = useMemo(() => {
    const linkedIds = new Set(links.map((item) => item.business_id))
    return businesses.filter((business) => !linkedIds.has(business.id))
  }, [businesses, links])
  const ownedMarketAccount = marketAccounts.find((account) => account.role === 'owner')

  const showError = (message: string, error: unknown) => {
    console.error(message, error)
    const rpcMessage =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String(error.message)
          : String(error)
    setFeedback({
      type: 'error',
      message: rpcMessage.includes('Troque primeiro o proprietário principal')
        ? 'Troque primeiro o proprietário principal da página.'
        : message,
    })
  }

  const saveMember = async (business: AdminUserBusiness, role: BusinessMemberRole, status: BusinessMemberStatus) => {
    if (role === 'owner' && business.role !== 'owner') {
      setConfirmation({ type: 'owner', business, role, status })
      return
    }
    await performMemberUpdate(business, role, status)
  }

  const performMemberUpdate = async (business: AdminUserBusiness, role: BusinessMemberRole, status: BusinessMemberStatus) => {
    setProcessing(`member-${business.business_id}`)
    setFeedback(null)
    try {
      await updateBusinessMember(business.business_id, selectedUser.user_id, role, status)
      await loadData()
      setFeedback({ type: 'success', message: 'Perfil e acesso atualizados com sucesso.' })
      onUserChanged()
    } catch (error) {
      showError('Não foi possível atualizar o vínculo.', error)
    } finally {
      setProcessing('')
      setConfirmation(null)
    }
  }

  const changePlan = async (business: AdminUserBusiness, planCode: BusinessPlanCode) => {
    setProcessing(`plan-${business.business_id}`)
    setFeedback(null)
    try {
      await setBusinessPlan(business.business_id, planCode)
      await loadData()
      setFeedback({ type: 'success', message: 'Plano da página alterado com sucesso.' })
    } catch (error) {
      showError('Não foi possível alterar o plano da página.', error)
    } finally {
      setProcessing('')
    }
  }

  const submitLink = async (event: FormEvent) => {
    event.preventDefault()
    if (!linkBusinessId) return
    setProcessing('link')
    setFeedback(null)
    try {
      await linkUserToBusiness(selectedUser.user_id, linkBusinessId, linkRole, makeLegacyOwner)
      setShowLinkForm(false)
      setLinkBusinessId('')
      setLinkRole('viewer')
      setMakeLegacyOwner(false)
      await loadData()
      setFeedback({ type: 'success', message: 'Página vinculada com sucesso.' })
      onUserChanged()
    } catch (error) {
      showError('Não foi possível vincular a página.', error)
    } finally {
      setProcessing('')
    }
  }

  const performUnlink = async (business: AdminUserBusiness) => {
    setProcessing(`unlink-${business.business_id}`)
    setFeedback(null)
    try {
      await unlinkUserFromBusiness(business.business_id, selectedUser.user_id)
      await loadData()
      setFeedback({ type: 'success', message: 'Acesso removido com sucesso.' })
      onUserChanged()
    } catch (error) {
      showError('Não foi possível remover o acesso.', error)
    } finally {
      setProcessing('')
      setConfirmation(null)
    }
  }

  const submitMarket = async (event: FormEvent) => {
    event.preventDefault()
    if (!marketName.trim()) return
    setProcessing('market')
    setFeedback(null)
    try {
      await createMarketAccount(marketName.trim(), selectedUser.user_id, marketPlan)
      setShowMarketForm(false)
      setMarketName('')
      setMarketPlan('pilot')
      await loadData()
      setFeedback({ type: 'success', message: 'Conta GiroMicro Market criada com sucesso.' })
      onUserChanged()
    } catch (error) {
      showError('Não foi possível criar a conta Market.', error)
    } finally {
      setProcessing('')
    }
  }

  if (loading) return <div className="admin-message" role="status">Carregando detalhes do usuário...</div>
  if (errorMessage || !user) return <div className="admin-message is-error"><p>{errorMessage}</p><button className="button button-small" onClick={() => void loadData()}>Tentar novamente</button></div>

  return (
    <div className="admin-user-detail">
      <button className="button button-small button-outline admin-detail-back" onClick={onBack}><ArrowLeft size={16} /> Voltar aos usuários</button>

      <section className="admin-user-profile">
        <UserAvatar user={user} />
        <div><span className="panel-kicker">USUÁRIO</span><h2>{userDisplayName(user)}</h2><p>{user.email || 'E-mail não informado'}</p></div>
        <dl>
          <div><dt>Provider</dt><dd>{providerLabel(user.provider)}</dd></div>
          <div><dt>Cadastro</dt><dd>{formatAdminDate(user.auth_created_at)}</dd></div>
          <div><dt>Último acesso</dt><dd>{formatAdminDate(user.last_sign_in_at)}</dd></div>
        </dl>
      </section>

      {feedback && <p className={`admin-feedback ${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}

      <div className="admin-list-heading admin-detail-section-heading">
        <div><span className="panel-kicker">ACESSOS</span><h2>Páginas vinculadas</h2></div>
        <button className="button button-small" onClick={() => setShowLinkForm(true)} disabled={!availableBusinesses.length}><Link2 size={15} /> Vincular página existente</button>
      </div>

      {showLinkForm && (
        <form className="admin-inline-form" onSubmit={submitLink}>
          <h3>Vincular página existente</h3>
          <div className="admin-form-row">
            <label>Página<select required value={linkBusinessId} onChange={(event) => setLinkBusinessId(event.target.value)}><option value="">Selecione</option>{availableBusinesses.map((business) => <option key={business.id} value={business.id}>{business.name?.trim() || 'Página sem nome'}</option>)}</select></label>
            <label>Perfil<select value={linkRole} onChange={(event) => { const role = event.target.value as BusinessMemberRole; setLinkRole(role); if (role !== 'owner') setMakeLegacyOwner(false) }}>{roles.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
          </div>
          {linkRole === 'owner' && <label className="admin-edit-checkbox"><input type="checkbox" checked={makeLegacyOwner} onChange={(event) => setMakeLegacyOwner(event.target.checked)} /> Definir como proprietário principal</label>}
          <div className="admin-form-actions"><button type="button" className="button button-small button-outline" onClick={() => setShowLinkForm(false)}>Cancelar</button><button className="button button-small" disabled={processing === 'link'}><Plus size={15} /> {processing === 'link' ? 'Vinculando...' : 'Vincular'}</button></div>
        </form>
      )}

      {!links.length ? (
        <div className="admin-message"><p>Nenhuma página vinculada a este usuário.</p><button className="button button-small button-outline" disabled title="Criação administrativa será adicionada na próxima etapa.">Criar página</button><small className="admin-disabled-hint">Criação administrativa será adicionada na próxima etapa.</small></div>
      ) : (
        <div className="admin-user-businesses">
          {links.map((business) => <UserBusinessCard key={business.business_id} business={business} processing={processing} onEdit={() => onEditBusiness(business.business_id)} onPlanChange={(plan) => void changePlan(business, plan)} onMemberSave={(role, status) => void saveMember(business, role, status)} onUnlink={() => setConfirmation({ type: 'unlink', business })} />)}
        </div>
      )}

      <section className="admin-market-section">
        <div className="admin-list-heading"><div><span className="panel-kicker">CONTA COMERCIAL INDEPENDENTE</span><h2>GiroMicro Market</h2></div><span className="admin-market-count">{marketAccounts.length} {marketAccounts.length === 1 ? 'conta' : 'contas'}</span></div>
        {marketAccounts.length === 0 && <p>Nenhuma conta Market vinculada a este usuário.</p>}
        {marketAccounts.length > 0 && <div className="admin-market-account-list">{marketAccounts.map((account) => <article key={account.id}><div><strong>{account.name}</strong><span>Conta de gestão independente da página pública</span></div><dl><div><dt>Plano</dt><dd>{account.plan_code === 'pro' ? 'Pro' : 'Pilot'}</dd></div><div><dt>Perfil</dt><dd>{marketRoleLabel(account.role)}</dd></div><div><dt>Conta</dt><dd>{marketAccountStatusLabel(account.status)}</dd></div><div><dt>Vínculo</dt><dd>{marketStatusLabel(account.member_status)}</dd></div><div><dt>Lojas</dt><dd>{account.store_count}</dd></div></dl><button className="button button-small button-outline" onClick={() => onManageMarket(account.id)}>Gerenciar Market</button></article>)}</div>}
        {ownedMarketAccount && <p className="admin-market-owner-note">Este usuário já é proprietário da conta <strong>{ownedMarketAccount.name}</strong>. Gerencie a conta existente para alterar seu plano ou status.</p>}
        {!ownedMarketAccount && !showMarketForm && <button className="button button-small" onClick={() => setShowMarketForm(true)}><Store size={15} /> Criar conta Market</button>}
        {showMarketForm && <form className="admin-inline-form" onSubmit={submitMarket}><h3>Criar conta Market</h3><div className="admin-form-row"><label>Nome da conta<input required value={marketName} onChange={(event) => setMarketName(event.target.value)} /></label><label>Plano<select value={marketPlan} onChange={(event) => setMarketPlan(event.target.value as MarketPlanCode)}><option value="pilot">Pilot</option><option value="pro">Pro</option></select></label></div><div className="admin-form-actions"><button type="button" className="button button-small button-outline" onClick={() => setShowMarketForm(false)}>Cancelar</button><button className="button button-small" disabled={processing === 'market'}><Plus size={15} /> {processing === 'market' ? 'Criando...' : 'Criar conta'}</button></div></form>}
      </section>

      {confirmation?.type === 'owner' && <ConfirmDialog title="Alterar proprietário principal?" description="Este usuário passará a ser o proprietário principal desta página. Deseja continuar?" confirmLabel="Confirmar alteração" processingLabel="Alterando..." processing={processing.startsWith('member-')} onCancel={() => setConfirmation(null)} onConfirm={() => void performMemberUpdate(confirmation.business, confirmation.role, confirmation.status)} />}
      {confirmation?.type === 'unlink' && <ConfirmDialog title="Remover acesso?" description={`O usuário perderá o acesso à página ${confirmation.business.business_name?.trim() || ''}.`} confirmLabel="Remover acesso" processingLabel="Removendo..." processing={processing.startsWith('unlink-')} onCancel={() => setConfirmation(null)} onConfirm={() => void performUnlink(confirmation.business)} />}
    </div>
  )
}

function UserBusinessCard({ business, processing, onEdit, onPlanChange, onMemberSave, onUnlink }: { business: AdminUserBusiness; processing: string; onEdit: () => void; onPlanChange: (plan: BusinessPlanCode) => void; onMemberSave: (role: BusinessMemberRole, status: BusinessMemberStatus) => void; onUnlink: () => void }) {
  const [role, setRole] = useState(business.role)
  const [status, setStatus] = useState(business.member_status)
  useEffect(() => { setRole(business.role); setStatus(business.member_status) }, [business.role, business.member_status])
  const busy = processing.endsWith(business.business_id)
  return <article className="admin-business-card admin-user-business-card">
    <div className="admin-business-main"><div><span className="admin-status published">{businessStatusLabel(business.status)}</span><h3>{business.business_name?.trim() || 'Página sem nome'}</h3><p>{business.slug ? `/negocio/${business.slug}` : 'Slug não informado'}</p></div><button className="button button-small button-outline" onClick={onEdit} disabled={busy}><Pencil size={15} /> Editar página</button></div>
    <dl className="admin-linked-business-details"><div><dt>Plano</dt><dd>{business.plan_code}</dd></div><div><dt>Template</dt><dd>{templateLabel(business.template_key)}</dd></div><div><dt>Perfil</dt><dd>{roleLabel(business.role)}</dd></div><div><dt>Acesso</dt><dd>{statusLabel(business.member_status)}</dd></div><div><dt>Proprietário legado</dt><dd>{business.legacy_owner ? 'Sim' : 'Não'}</dd></div></dl>
    <div className="admin-business-management"><label>Plano<select value={business.plan_code} onChange={(event) => onPlanChange(event.target.value as BusinessPlanCode)} disabled={busy}>{plans.map((plan) => <option key={plan.value} value={plan.value}>{plan.label}</option>)}</select></label><label>Perfil<select value={role} onChange={(event) => setRole(event.target.value as BusinessMemberRole)} disabled={busy}>{roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label>Acesso<select value={status} onChange={(event) => setStatus(event.target.value as BusinessMemberStatus)} disabled={busy}><option value="active">Ativo</option><option value="disabled">Desabilitado</option></select></label><button className="button button-small" onClick={() => onMemberSave(role, status)} disabled={busy || (role === business.role && status === business.member_status)}><Save size={15} /> Salvar vínculo</button><button className="button button-small button-outline admin-remove-access" onClick={onUnlink} disabled={busy}><Trash2 size={15} /> Remover acesso</button></div>
  </article>
}
