import { Eye, Pencil, RefreshCw, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import type { AdminBusinessSummary } from '../types/business'
import type { AdminAuthenticatedUser } from '../types/adminUsers'
import { AdminBusinessEdit } from './AdminBusinessEdit'
import { AdminMarketAccount } from './AdminMarketAccount'
import { AdminUserDetail } from './AdminUserDetail'
import { AdminUsers } from './AdminUsers'

interface AdminProps {
  header: ReactNode
  onBack: () => void
}

type BusinessStatus = {
  label: string
  className: BusinessStatusKey
}

type BusinessStatusKey = 'published' | 'draft' | 'suspended' | 'paused'

type PendingAction = {
  businessId: string
  action: 'suspend' | 'reactivate'
}

type ActionFeedback = {
  type: 'success' | 'error'
  message: string
}

const getBusinessStatus = (
  business: AdminBusinessSummary
): BusinessStatus => {
  if (business.is_suspended) {
    return { label: 'Suspenso', className: 'suspended' }
  }

  if (business.status !== 'published') {
    return {
      label: business.status === 'draft' ? 'Rascunho' : 'Não publicado',
      className: 'draft',
    }
  }

  if (business.is_owner_paused) {
    return { label: 'Fora do ar', className: 'paused' }
  }

  return { label: 'Publicado', className: 'published' }
}

const formatCreatedAt = (value: string) => {
  const date = new Date(value)

  return Number.isNaN(date.getTime())
    ? 'Data não informada'
    : new Intl.DateTimeFormat('pt-BR', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
}

export function Admin({ header, onBack }: AdminProps) {
  const [activeArea, setActiveArea] = useState<'users' | 'businesses'>('users')
  const [selectedUser, setSelectedUser] = useState<AdminAuthenticatedUser | null>(null)
  const [marketAccountId, setMarketAccountId] = useState('')
  const [usersRefreshToken, setUsersRefreshToken] = useState(0)
  const [businesses, setBusinesses] = useState<AdminBusinessSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [processingBusinessId, setProcessingBusinessId] = useState('')
  const [actionFeedback, setActionFeedback] = useState<ActionFeedback | null>(null)
  const [editingBusinessId, setEditingBusinessId] = useState('')

  const loadBusinesses = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')

    const { data, error } = await supabase
      .from('businesses')
      .select(
        'id, name, slug, category, city, status, is_suspended, is_owner_paused, owner_id, created_at, updated_at'
      )
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Falha ao carregar negócios para administração:', error)
      setBusinesses([])
      setErrorMessage(
        'Não foi possível carregar os negócios. Tente novamente.'
      )
    } else {
      setBusinesses(data ?? [])
    }

    setLoading(false)
  }, [])

  useEffect(() => {
    void loadBusinesses()
  }, [loadBusinesses])

  const updateSuspension = async (
    business: AdminBusinessSummary,
    suspend: boolean
  ) => {
    if (processingBusinessId) return

    setProcessingBusinessId(business.id)
    setActionFeedback(null)

    const { error } = suspend
      ? await supabase.rpc('suspend_business', {
          target_business_id: business.id,
          reason: null,
        })
      : await supabase.rpc('reactivate_business', {
          target_business_id: business.id,
        })

    if (error) {
      console.error(
        `Falha ao ${suspend ? 'suspender' : 'reativar'} negócio:`,
        error
      )
      setActionFeedback({
        type: 'error',
        message: `Não foi possível ${
          suspend ? 'suspender' : 'reativar'
        } o negócio. Tente novamente.`,
      })
    } else {
      setBusinesses((current) =>
        current.map((item) =>
          item.id === business.id
            ? { ...item, is_suspended: suspend }
            : item
        )
      )
      setPendingAction(null)
      setActionFeedback({
        type: 'success',
        message: `Negócio ${
          suspend ? 'suspenso' : 'reativado'
        } com sucesso.`,
      })
    }

    setProcessingBusinessId('')
  }

  const totals = businesses.reduce(
    (summary, business) => {
      summary.total += 1

      if (business.is_suspended) {
        summary.suspended += 1
      } else if (business.is_owner_paused) {
        summary.paused += 1
      } else if (business.status === 'published') {
        summary.published += 1
      } else {
        summary.draft += 1
      }

      return summary
    },
    { total: 0, published: 0, draft: 0, suspended: 0, paused: 0 }
  )

  if (editingBusinessId) {
    return (
      <main>
        {header}
        <section className="admin-page container">
          <AdminBusinessEdit
            businessId={editingBusinessId}
            onCancel={() => setEditingBusinessId('')}
            onSaved={async () => {
              await loadBusinesses()
              setEditingBusinessId('')
              setActionFeedback({
                type: 'success',
                message: 'Negócio atualizado com sucesso.',
              })
            }}
          />
        </section>
      </main>
    )
  }

  if (selectedUser && marketAccountId) {
    return (
      <main>
        {header}
        <section className="admin-page container">
          <AdminMarketAccount
            accountId={marketAccountId}
            onBack={() => setMarketAccountId('')}
          />
        </section>
      </main>
    )
  }

  if (selectedUser) {
    return (
      <main>
        {header}
        <section className="admin-page container">
          <AdminUserDetail
            selectedUser={selectedUser}
            businesses={businesses}
            onBack={() => setSelectedUser(null)}
            onEditBusiness={setEditingBusinessId}
            onManageMarket={setMarketAccountId}
            onUserChanged={() => setUsersRefreshToken((value) => value + 1)}
          />
        </section>
      </main>
    )
  }

  return (
    <main>
      {header}

      <section className="admin-page container">
        <div className="admin-heading">
          <div>
            <p className="eyebrow">
              <ShieldCheck size={16} />
              Acesso restrito
            </p>
            <h1>Administração</h1>
            <p className="hero-text">
              Gerencie usuários autenticados e páginas cadastradas no GiroMicro.
            </p>
          </div>

          <button className="button button-outline" onClick={onBack}>
            Voltar ao meu painel
          </button>
        </div>

        <div className="admin-tabs" role="tablist" aria-label="Áreas da administração">
          <button role="tab" aria-selected={activeArea === 'users'} className={activeArea === 'users' ? 'is-active' : ''} onClick={() => setActiveArea('users')}>Usuários</button>
          <button role="tab" aria-selected={activeArea === 'businesses'} className={activeArea === 'businesses' ? 'is-active' : ''} onClick={() => setActiveArea('businesses')}>Negócios/Páginas</button>
        </div>

        {activeArea === 'users' ? (
          <AdminUsers onSelectUser={setSelectedUser} refreshToken={usersRefreshToken} />
        ) : (
          <>

        <div className="admin-summary" aria-label="Resumo dos negócios">
          <article><span>Total</span><strong>{totals.total}</strong></article>
          <article><span>Publicados</span><strong>{totals.published}</strong></article>
          <article><span>Rascunhos</span><strong>{totals.draft}</strong></article>
          <article><span>Suspensos</span><strong>{totals.suspended}</strong></article>
          <article><span>Fora do ar</span><strong>{totals.paused}</strong></article>
        </div>

        <div className="admin-list-heading">
          <div>
            <span className="panel-kicker">CADASTROS</span>
            <h2>Negócios</h2>
          </div>
          <button
            className="button button-small button-outline"
            onClick={() => void loadBusinesses()}
            disabled={loading}
          >
            <RefreshCw size={15} />
            Atualizar
          </button>
        </div>

        {actionFeedback && (
          <p
            className={`admin-feedback ${actionFeedback.type}`}
            role={actionFeedback.type === 'error' ? 'alert' : 'status'}
          >
            {actionFeedback.message}
          </p>
        )}

        {loading ? (
          <div className="admin-message" role="status">
            Carregando negócios...
          </div>
        ) : errorMessage ? (
          <div className="admin-message is-error" role="alert">
            <p>{errorMessage}</p>
            <button className="button button-small" onClick={() => void loadBusinesses()}>
              Tentar novamente
            </button>
          </div>
        ) : businesses.length === 0 ? (
          <div className="admin-message">
            Nenhum negócio cadastrado até o momento.
          </div>
        ) : (
          <div className="admin-business-list">
            {businesses.map((business) => {
              const status = getBusinessStatus(business)
              const isPublic =
                business.status === 'published' &&
                !business.is_suspended &&
                !business.is_owner_paused &&
                Boolean(business.slug)
              const isProcessing = processingBusinessId === business.id
              const isConfirming = pendingAction?.businessId === business.id

              return (
                <article className="admin-business-card" key={business.id}>
                  <div className="admin-business-main">
                    <div>
                      <span className={`admin-status ${status.className}`}>
                        {status.label}
                      </span>
                      <h3>{business.name?.trim() || 'Negócio sem nome'}</h3>
                      <p>
                        {business.category?.trim() || 'Categoria não informada'}
                        {' · '}
                        {business.city?.trim() || 'Cidade não informada'}
                      </p>
                    </div>

                    <div className="admin-business-actions">
                      <button
                        className="button button-small button-outline"
                        onClick={() => {
                          setActionFeedback(null)
                          setPendingAction(null)
                          setEditingBusinessId(business.id)
                        }}
                        disabled={Boolean(processingBusinessId)}
                      >
                        <Pencil size={15} />
                        Editar
                      </button>

                      {isPublic && (
                        <a
                          className="button button-small button-outline"
                          href={`/negocio/${encodeURIComponent(business.slug ?? '')}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Eye size={15} />
                          Visualizar
                        </a>
                      )}

                      <button
                        className={`button button-small${
                          business.is_suspended ? '' : ' admin-suspend-button'
                        }`}
                        onClick={() => {
                          setActionFeedback(null)
                          setPendingAction({
                            businessId: business.id,
                            action: business.is_suspended
                              ? 'reactivate'
                              : 'suspend',
                          })
                        }}
                        disabled={Boolean(processingBusinessId)}
                      >
                        {business.is_suspended ? 'Reativar' : 'Suspender'}
                      </button>
                    </div>
                  </div>

                  {isConfirming && (
                    <div
                      className="admin-action-confirmation"
                      role="dialog"
                      aria-modal="false"
                      aria-labelledby={`admin-confirmation-${business.id}`}
                    >
                      <div>
                        <strong id={`admin-confirmation-${business.id}`}>
                          {pendingAction.action === 'suspend'
                            ? `Suspender ${business.name?.trim() || 'este negócio'}?`
                            : `Reativar ${business.name?.trim() || 'este negócio'}?`}
                        </strong>
                        <p>
                          {pendingAction.action === 'suspend'
                            ? 'Ele deixará de aparecer no GiroMicro e sua página pública ficará indisponível até ser reativado.'
                            : 'Se estiver publicado e não estiver pausado pelo proprietário, voltará a ficar disponível no GiroMicro.'}
                        </p>
                      </div>
                      <div className="admin-confirmation-actions">
                        <button
                          className="button button-small button-outline"
                          onClick={() => setPendingAction(null)}
                          disabled={isProcessing}
                        >
                          Cancelar
                        </button>
                        <button
                          className="button button-small"
                          onClick={() =>
                            void updateSuspension(
                              business,
                              pendingAction.action === 'suspend'
                            )
                          }
                          disabled={isProcessing}
                        >
                          {isProcessing
                            ? pendingAction.action === 'suspend'
                              ? 'Suspendendo...'
                              : 'Reativando...'
                            : pendingAction.action === 'suspend'
                              ? 'Confirmar suspensão'
                              : 'Confirmar reativação'}
                        </button>
                      </div>
                    </div>
                  )}

                  <dl className="admin-business-details">
                    <div><dt>Slug</dt><dd>{business.slug || '—'}</dd></div>
                    <div><dt>Criado em</dt><dd>{formatCreatedAt(business.created_at)}</dd></div>
                    <div><dt>Proprietário</dt><dd>{business.owner_id}</dd></div>
                  </dl>
                </article>
              )
            })}
          </div>
        )}
          </>
        )}
      </section>
    </main>
  )
}
