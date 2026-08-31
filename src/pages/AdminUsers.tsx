import { RefreshCw, Search, UserRound } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { listAuthenticatedUsers } from '../services/adminUsers'
import type { AdminAuthenticatedUser } from '../types/adminUsers'

interface AdminUsersProps {
  onSelectUser: (user: AdminAuthenticatedUser) => void
  refreshToken?: number
}

export const formatAdminDate = (value: string | null) => {
  if (!value) return 'Não informado'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Não informado'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' }).format(date)
}

export const providerLabel = (provider: string | null) => {
  if (provider === 'google') return 'Google'
  if (provider === 'email') return 'E-mail'
  return provider?.trim() || 'Não informado'
}

export const userDisplayName = (user: Pick<AdminAuthenticatedUser, 'full_name' | 'email'>) =>
  user.full_name?.trim() || user.email?.trim() || 'Usuário sem nome'

export const UserAvatar = ({
  user,
}: {
  user: Pick<AdminAuthenticatedUser, 'full_name' | 'email' | 'avatar_url'>
}) => {
  const name = userDisplayName(user)
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  return user.avatar_url ? (
    <img className="admin-user-avatar" src={user.avatar_url} alt="" />
  ) : (
    <span className="admin-user-avatar fallback" aria-hidden="true">
      {initials || <UserRound size={20} />}
    </span>
  )
}

export function AdminUsers({ onSelectUser, refreshToken = 0 }: AdminUsersProps) {
  const [users, setUsers] = useState<AdminAuthenticatedUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')

  const loadUsers = useCallback(async () => {
    setLoading(true)
    setErrorMessage('')
    try {
      setUsers(await listAuthenticatedUsers())
    } catch (error) {
      console.error('Falha ao carregar usuários autenticados:', error)
      setUsers([])
      setErrorMessage('Não foi possível carregar os usuários. Tente novamente.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers, refreshToken])

  const filteredUsers = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('pt-BR')
    if (!normalizedQuery) return users
    return users.filter((user) =>
      `${user.full_name ?? ''} ${user.email ?? ''}`
        .toLocaleLowerCase('pt-BR')
        .includes(normalizedQuery)
    )
  }, [query, users])

  return (
    <div className="admin-users-section">
      <div className="admin-list-heading">
        <div>
          <span className="panel-kicker">ACESSOS</span>
          <h2>Usuários</h2>
        </div>
        <button className="button button-small button-outline" onClick={() => void loadUsers()} disabled={loading}>
          <RefreshCw size={15} /> Atualizar
        </button>
      </div>

      <label className="admin-user-search">
        <Search size={18} />
        <span className="sr-only">Buscar usuários por nome ou e-mail</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nome ou e-mail" />
      </label>

      {loading ? (
        <div className="admin-message" role="status">Carregando usuários...</div>
      ) : errorMessage ? (
        <div className="admin-message is-error" role="alert">
          <p>{errorMessage}</p>
          <button className="button button-small" onClick={() => void loadUsers()}>Tentar novamente</button>
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="admin-message">
          {query.trim() ? 'Nenhum usuário encontrado para esta busca.' : 'Nenhum usuário autenticado encontrado.'}
        </div>
      ) : (
        <div className="admin-user-list">
          {filteredUsers.map((user) => (
            <button className="admin-user-card" key={user.user_id} onClick={() => onSelectUser(user)}>
              <UserAvatar user={user} />
              <span className="admin-user-identity">
                <strong>{userDisplayName(user)}</strong>
                <span>{user.email || 'E-mail não informado'}</span>
              </span>
              <span className="admin-user-meta"><small>Provider</small>{providerLabel(user.provider)}</span>
              <span className="admin-user-meta"><small>Cadastro</small>{formatAdminDate(user.auth_created_at)}</span>
              <span className="admin-user-meta"><small>Último acesso</small>{formatAdminDate(user.last_sign_in_at)}</span>
              <span className="admin-user-counts">
                <span><small>Páginas</small><strong>{user.business_count}</strong></span>
                <span><small>Market</small><strong>{user.market_account_count}</strong></span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
