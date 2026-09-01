import { ArrowLeft, Pencil, Plus, Store, UserPlus } from 'lucide-react'
import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { listAuthenticatedUsers } from '../services/adminUsers'
import { addMarketMember, createMarketStore, getMarketAccount, listMarketMembers, listMarketStores, updateMarketAccountSettings, updateMarketMemberAccess, updateMarketStore } from '../services/market'
import type { AdminAuthenticatedUser } from '../types/adminUsers'
import type { MarketAccount, MarketAccountMember, MarketAccountStatus, MarketMemberRole, MarketMemberStatus, MarketPlanCode, MarketStore, MarketStoreInput, MarketStoreStatus, MarketStoreType } from '../types/market'

interface AdminMarketAccountProps { accountId: string; onBack: () => void }
type Feedback = { type: 'success' | 'error'; message: string }
type MemberForm = { userId: string; role: Exclude<MarketMemberRole, 'owner'>; status: Exclude<MarketMemberStatus, 'invited'>; allStores: boolean; storeIds: string[] }
const roleLabels = { owner: 'Proprietário', admin: 'Administrador', manager: 'Gerente', operator: 'Operador', viewer: 'Visualização' }
const accountStatusLabels = { pilot: 'Piloto', active: 'Ativo', suspended: 'Suspenso', cancelled: 'Cancelado' }
const emptyStore: MarketStoreInput = { name: '', external_code: null, description: null, store_type: 'store', status: 'active' }
const emptyMember: MemberForm = { userId: '', role: 'operator', status: 'active', allStores: true, storeIds: [] }
const friendlyError = (error: unknown, fallback: string) => {
  const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : ''
  return ['Usuário já vinculado', 'Selecione pelo menos uma loja', 'lojas não pertencem', 'proprietário não pode', 'Conta Market não encontrada', 'Usuário não encontrado', 'Acesso negado'].some((text) => message.includes(text)) ? message : fallback
}

export function AdminMarketAccount({ accountId, onBack }: AdminMarketAccountProps) {
  const [account, setAccount] = useState<MarketAccount | null>(null)
  const [members, setMembers] = useState<MarketAccountMember[]>([])
  const [stores, setStores] = useState<MarketStore[]>([])
  const [users, setUsers] = useState<AdminAuthenticatedUser[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [settings, setSettings] = useState<{ plan: MarketPlanCode; status: MarketAccountStatus }>({ plan: 'pilot', status: 'pilot' })
  const [savingAction, setSavingAction] = useState('')
  const [editingStore, setEditingStore] = useState<MarketStore | 'new' | null>(null)
  const [storeForm, setStoreForm] = useState<MarketStoreInput>(emptyStore)
  const [showMemberForm, setShowMemberForm] = useState(false)
  const [editingMemberId, setEditingMemberId] = useState('')
  const [memberForm, setMemberForm] = useState<MemberForm>(emptyMember)
  const [userSearch, setUserSearch] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true); setErrorMessage('')
    try {
      const accountData = await getMarketAccount(accountId)
      if (!accountData || accountData.id !== accountId) throw new Error('Conta Market não encontrada ou sem acesso.')
      const [memberData, storeData, authenticatedUsers] = await Promise.all([listMarketMembers(accountId), listMarketStores(accountId), listAuthenticatedUsers()])
      const userMap = new Map(authenticatedUsers.map((user) => [user.user_id, user]))
      setAccount(accountData); setSettings({ plan: accountData.plan_code === 'pro' ? 'pro' : 'pilot', status: accountData.status })
      setMembers(memberData.map((member) => ({ ...member, full_name: userMap.get(member.user_id)?.full_name, email: userMap.get(member.user_id)?.email })))
      setStores(storeData); setUsers(authenticatedUsers)
    } catch (error) { console.error('Falha ao carregar conta Market:', error); setErrorMessage('Não foi possível carregar esta conta Market.') }
    finally { setLoading(false) }
  }, [accountId])
  useEffect(() => { void loadData() }, [loadData])

  const availableUsers = useMemo(() => {
    const memberIds = new Set(members.map((member) => member.user_id)); const query = userSearch.trim().toLocaleLowerCase('pt-BR')
    return users.filter((user) => !memberIds.has(user.user_id) && (!query || `${user.full_name ?? ''} ${user.email ?? ''}`.toLocaleLowerCase('pt-BR').includes(query)))
  }, [members, userSearch, users])
  const editingMember = editingMemberId ? members.find((member) => member.id === editingMemberId) ?? null : null
  const toggleStore = (storeId: string) => setMemberForm((current) => ({ ...current, storeIds: current.storeIds.includes(storeId) ? current.storeIds.filter((id) => id !== storeId) : [...current.storeIds, storeId] }))
  const openNewMember = () => { setEditingMemberId(''); setMemberForm(emptyMember); setUserSearch(''); setShowMemberForm(true); setFeedback(null) }
  const openMemberEdit = (member: MarketAccountMember) => {
    setEditingMemberId(member.id)
    setMemberForm({
      userId: member.user_id,
      role: member.role === 'owner' ? 'viewer' : member.role,
      status: member.status === 'disabled' ? 'disabled' : 'active',
      allStores: member.all_stores,
      storeIds: [...(member.store_ids ?? [])],
    })
    setShowMemberForm(true); setFeedback(null)
  }

  const saveMember = async (event: FormEvent) => {
    event.preventDefault()
    if (!memberForm.allStores && memberForm.storeIds.length === 0) { setFeedback({ type: 'error', message: 'Selecione pelo menos uma loja para o acesso restrito.' }); return }
    if (!editingMemberId && !memberForm.userId) { setFeedback({ type: 'error', message: 'Selecione um usuário autenticado.' }); return }
    setSavingAction('member'); setFeedback(null)
    try {
      if (editingMemberId) await updateMarketMemberAccess(accountId, editingMemberId, memberForm.role, memberForm.status, memberForm.allStores, memberForm.storeIds)
      else await addMarketMember(accountId, memberForm.userId, memberForm.role, memberForm.allStores, memberForm.storeIds)
      setShowMemberForm(false); await loadData(); setFeedback({ type: 'success', message: editingMemberId ? 'Acesso atualizado com sucesso.' : 'Usuário vinculado com sucesso.' })
    } catch (error) { console.error('Falha ao salvar membro Market:', error); setFeedback({ type: 'error', message: friendlyError(error, 'Não foi possível salvar o acesso deste usuário.') }) }
    finally { setSavingAction('') }
  }
  const saveSettings = async (event: FormEvent) => {
    event.preventDefault(); setSavingAction('settings'); setFeedback(null)
    try { await updateMarketAccountSettings(accountId, settings.plan, settings.status); await loadData(); setFeedback({ type: 'success', message: 'Configuração da conta atualizada com sucesso.' }) }
    catch (error) { console.error('Falha ao salvar configuração Market:', error); setFeedback({ type: 'error', message: friendlyError(error, 'Não foi possível alterar plano e status da conta.') }) }
    finally { setSavingAction('') }
  }
  const saveStore = async (event: FormEvent) => {
    event.preventDefault(); if (!storeForm.name.trim() || !account || account.id !== accountId) return
    setSavingAction('store'); setFeedback(null)
    const input = { ...storeForm, name: storeForm.name.trim(), external_code: storeForm.external_code?.trim() || null, description: storeForm.description?.trim() || null }
    try { if (editingStore === 'new') await createMarketStore(accountId, input); else if (editingStore) await updateMarketStore(accountId, editingStore.id, input); setEditingStore(null); setStores(await listMarketStores(accountId)); setFeedback({ type: 'success', message: editingStore === 'new' ? 'Local criado com sucesso.' : 'Local atualizado com sucesso.' }) }
    catch (error) { console.error('Falha ao salvar local de estoque:', error); setFeedback({ type: 'error', message: 'Não foi possível salvar o local de estoque.' }) }
    finally { setSavingAction('') }
  }

  if (loading) return <div className="admin-message" role="status">Carregando conta Market...</div>
  if (errorMessage || !account) return <div className="admin-message is-error"><p>{errorMessage}</p><button className="button button-small" onClick={onBack}>Voltar ao usuário</button></div>
  return <div className="admin-market-account">
    <button className="button button-small button-outline admin-detail-back" onClick={onBack}><ArrowLeft size={16} /> Voltar ao usuário</button>
    <header className="admin-market-header"><div><p className="eyebrow"><Store size={16} /> GiroMicro Market</p><h1>{account.name}</h1></div><dl><div><dt>Plano</dt><dd>{account.plan_code === 'pro' ? 'Pro' : 'Pilot'}</dd></div><div><dt>Status</dt><dd>{accountStatusLabels[account.status]}</dd></div></dl></header>
    {feedback && <p className={`admin-feedback ${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
    <section className="admin-market-block"><div className="admin-list-heading"><div><span className="panel-kicker">ADMINISTRAÇÃO</span><h2>Configuração da conta</h2></div></div><form className="admin-inline-form" onSubmit={saveSettings}><div className="admin-form-row"><label>Plano<select value={settings.plan} onChange={(event) => setSettings((current) => ({ ...current, plan: event.target.value as MarketPlanCode }))}><option value="pilot">Pilot</option><option value="pro">Pro</option></select></label><label>Status<select value={settings.status} onChange={(event) => setSettings((current) => ({ ...current, status: event.target.value as MarketAccountStatus }))}><option value="pilot">Piloto</option><option value="active">Ativo</option><option value="suspended">Suspenso</option><option value="cancelled">Cancelado</option></select></label></div><div className="admin-form-actions"><button className="button button-small" disabled={savingAction === 'settings'}>{savingAction === 'settings' ? 'Salvando...' : 'Salvar alterações'}</button></div></form></section>
    <section className="admin-market-block"><div className="admin-list-heading"><div><span className="panel-kicker">ACESSOS</span><h2>Usuários da conta</h2></div><button className="button button-small" onClick={openNewMember}><UserPlus size={15} /> Vincular usuário</button></div>
      {showMemberForm && <div className="confirm-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && savingAction !== 'member') setShowMemberForm(false) }}><form className="confirm-dialog admin-member-access-dialog" role="dialog" aria-modal="true" aria-labelledby="member-access-title" onSubmit={saveMember}><header><h2 id="member-access-title">{editingMemberId ? 'Editar acesso' : 'Vincular usuário existente'}</h2>{editingMember && <p>{editingMember.full_name?.trim() || 'Usuário'} · {editingMember.email || 'E-mail não informado'}</p>}</header>{!editingMemberId && <><label>Buscar usuário<input value={userSearch} onChange={(event) => setUserSearch(event.target.value)} placeholder="Nome ou e-mail" /></label><label className="admin-form-wide">Usuário<select required value={memberForm.userId} onChange={(event) => setMemberForm((current) => ({ ...current, userId: event.target.value }))}><option value="">Selecione</option>{availableUsers.map((user) => <option key={user.user_id} value={user.user_id}>{user.full_name?.trim() || 'Usuário'} — {user.email}</option>)}</select></label></>}<div className="admin-form-row"><label>Perfil<select value={memberForm.role} onChange={(event) => setMemberForm((current) => ({ ...current, role: event.target.value as MemberForm['role'] }))}><option value="admin">Administrador</option><option value="manager">Gerente</option><option value="operator">Operador</option><option value="viewer">Visualizador</option></select></label>{editingMemberId && <label>Status<select value={memberForm.status} onChange={(event) => setMemberForm((current) => ({ ...current, status: event.target.value as MemberForm['status'] }))}><option value="active">Ativo</option><option value="disabled">Desabilitado</option></select></label>}</div><fieldset className="admin-store-access"><legend>Acesso aos locais de estoque</legend><p>Escolha quais lojas e galpões este usuário poderá visualizar e operar.</p><label><input type="checkbox" checked={memberForm.allStores} onChange={(event) => setMemberForm((current) => ({ ...current, allStores: event.target.checked, storeIds: event.target.checked ? [] : current.storeIds }))} /> Todos os locais desta conta</label>{!memberForm.allStores && stores.map((store) => <label key={store.id}><input type="checkbox" checked={memberForm.storeIds.includes(store.id)} onChange={() => toggleStore(store.id)} /> {store.name} ({store.store_type === 'warehouse' ? 'Galpão' : 'Loja'}){store.external_code ? ` — ${store.external_code}` : ''}</label>)}</fieldset><p className="admin-form-note">Esta configuração altera somente o acesso do membro. O status global dos locais não será modificado.</p><div className="confirm-dialog-actions"><button type="button" className="button button-outline" onClick={() => setShowMemberForm(false)} disabled={savingAction === 'member'}>Cancelar</button><button className="button" disabled={savingAction === 'member'}>{savingAction === 'member' ? 'Salvando...' : editingMemberId ? 'Salvar alterações' : 'Vincular usuário'}</button></div></form></div>}
      <div className="admin-market-member-list">{members.map((member) => <article key={member.id}><div><strong>{member.full_name?.trim() || member.email || 'Usuário'}</strong><span>{member.email || 'E-mail não informado'}</span></div><dl><div><dt>Perfil</dt><dd>{roleLabels[member.role]}</dd></div><div><dt>Status</dt><dd>{member.status === 'active' ? 'Ativo' : member.status === 'invited' ? 'Convidado' : 'Desabilitado'}</dd></div><div><dt>Acesso</dt><dd>{member.all_stores ? 'Todos os locais' : (member.store_ids ?? []).map((id) => stores.find((store) => store.id === id)?.name).filter(Boolean).join(', ') || 'Nenhum local'}</dd></div></dl>{member.role === 'owner' ? <span className="admin-status published">Proprietário</span> : <button className="button button-small button-outline" onClick={() => openMemberEdit(member)}>Editar acesso</button>}</article>)}</div>
    </section>
    <section className="admin-market-block"><div className="admin-list-heading"><div><span className="panel-kicker">UNIDADES</span><h2>Locais de estoque</h2></div><button className="button button-small" onClick={() => { setEditingStore('new'); setStoreForm(emptyStore) }}><Plus size={15} /> Novo local</button></div>{editingStore && <form className="admin-inline-form" onSubmit={saveStore}><h3>{editingStore === 'new' ? 'Novo local' : 'Editar local'}</h3><div className="admin-form-row"><label>Nome<input required value={storeForm.name} onChange={(event) => setStoreForm((current) => ({ ...current, name: event.target.value }))} /></label><label>Tipo<select value={storeForm.store_type} onChange={(event) => setStoreForm((current) => ({ ...current, store_type: event.target.value as MarketStoreType }))}><option value="store">Loja</option><option value="warehouse">Galpão</option></select></label><label>Código externo<input value={storeForm.external_code ?? ''} onChange={(event) => setStoreForm((current) => ({ ...current, external_code: event.target.value }))} /></label></div><label className="admin-form-wide">Descrição<textarea value={storeForm.description ?? ''} onChange={(event) => setStoreForm((current) => ({ ...current, description: event.target.value }))} /></label><label>Status<select value={storeForm.status} onChange={(event) => setStoreForm((current) => ({ ...current, status: event.target.value as MarketStoreStatus }))}><option value="active">Ativo</option><option value="inactive">Inativo</option></select></label><div className="admin-form-actions"><button type="button" className="button button-small button-outline" onClick={() => setEditingStore(null)}>Cancelar</button><button className="button button-small" disabled={savingAction === 'store'}>{savingAction === 'store' ? 'Salvando...' : 'Salvar local'}</button></div></form>}{!stores.length ? <div className="admin-message">Nenhum local de estoque cadastrado nesta conta.</div> : <div className="admin-store-list">{stores.map((store) => <article key={store.id}><div><strong>{store.name}</strong><span>{store.store_type === 'warehouse' ? 'Galpão' : 'Loja'} · Código: {store.external_code || 'não informado'}</span>{store.description && <p>{store.description}</p>}</div><span className={`admin-status ${store.status === 'active' ? 'published' : 'paused'}`}>{store.status === 'active' ? 'Ativo' : 'Inativo'}</span><button className="button button-small button-outline" onClick={() => { setEditingStore(store); setStoreForm({ name: store.name, external_code: store.external_code, description: store.description, store_type: store.store_type, status: store.status }) }}><Pencil size={15} /> Editar</button></article>)}</div>}</section>
  </div>
}
