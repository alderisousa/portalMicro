import { ChevronDown, LogOut, Menu, ShieldCheck, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Brand } from './Brand'

interface HeaderProps {
  requestedSite: string | null
  signedIn: boolean
  isAdmin: boolean
  accountName: string
  accountEmail: string
  accountAvatarUrl: string
  menuOpen: boolean
  setMenuOpen: (value: boolean) => void
  start: () => void
  logout: () => void
  setView: (view: 'home' | 'dashboard' | 'admin') => void
}

export function Header({
  requestedSite,
  signedIn,
  isAdmin,
  accountName,
  accountEmail,
  accountAvatarUrl,
  menuOpen,
  setMenuOpen,
  start,
  logout,
  setView,
}: HeaderProps) {
  const [accountOpen, setAccountOpen] = useState(false)
  const [avatarFailed, setAvatarFailed] = useState(false)
  const accountMenuRef = useRef<HTMLDivElement>(null)

  const displayName = accountName || accountEmail || 'Minha conta'
  const initials = displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase()

  useEffect(() => setAvatarFailed(false), [accountAvatarUrl])

  useEffect(() => {
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAccountOpen(false)
        setMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [setMenuOpen])

  const closeMenus = () => {
    setAccountOpen(false)
    setMenuOpen(false)
  }

  const goHome = () => {
    if (requestedSite) window.history.pushState({}, '', window.location.origin)
    closeMenus()
    setView('home')
  }

  const goToSection = (sectionId: string) => {
    goHome()
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        document.getElementById(sectionId)?.scrollIntoView()
      })
    })
  }

  const openCreationFlow = () => {
    closeMenus()
    start()
  }

  const goToView = (view: 'dashboard' | 'admin') => {
    closeMenus()
    setView(view)
  }

  const signOut = () => {
    closeMenus()
    logout()
  }

  return (
    <nav className={`nav container ${requestedSite ? 'public-nav' : ''}`} aria-label="Navegação principal">
      <Brand onClick={goHome} />

      <button
        className="menu-button"
        onClick={() => setMenuOpen(!menuOpen)}
        aria-label={menuOpen ? 'Fechar menu' : 'Abrir menu'}
        aria-expanded={menuOpen}
        aria-controls="header-navigation"
      >
        <Menu size={22} />
      </button>

      <div className={`nav-links ${menuOpen ? 'is-open' : ''}`} id="header-navigation">
        {!requestedSite && (
          <div className="main-navigation">
            <button className="nav-link" onClick={() => goToSection('negocios')}>Negócios</button>
            <button className="nav-link" onClick={() => goToSection('como-funciona')}>Como funciona</button>
            {!signedIn && (
              <>
                <button className="nav-link" onClick={() => goToSection('planos')}>Planos</button>
                <button className="button button-small" onClick={openCreationFlow}>Comece hoje</button>
              </>
            )}
          </div>
        )}

        <div className="account-navigation">
          {signedIn ? (
            <div className="account-menu" ref={accountMenuRef}>
              <button
                className="account-trigger"
                onClick={() => setAccountOpen((open) => !open)}
                aria-expanded={accountOpen}
                aria-haspopup="menu"
              >
                <span className="account-avatar" aria-hidden="true">
                  {accountAvatarUrl && !avatarFailed ? (
                    <img src={accountAvatarUrl} alt="" referrerPolicy="no-referrer" onError={() => setAvatarFailed(true)} />
                  ) : (
                    initials || <UserRound size={17} />
                  )}
                </span>
                <span className="account-trigger-name">{displayName}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>

              {accountOpen && (
                <div className="account-dropdown" role="menu" aria-label="Menu da conta">
                  <div className="account-summary">
                    <strong>{displayName}</strong>
                    {accountEmail && <span>{accountEmail}</span>}
                  </div>
                  <button role="menuitem" onClick={() => goToView('dashboard')}>
                    <UserRound size={16} /> Meu painel
                  </button>
                  {isAdmin && (
                    <button role="menuitem" onClick={() => goToView('admin')}>
                      <ShieldCheck size={16} /> Administração
                    </button>
                  )}
                  <button role="menuitem" onClick={signOut}>
                    <LogOut size={16} /> Sair
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="nav-login button button-small button-outline" onClick={openCreationFlow}>
              <UserRound size={15} /> Entrar
            </button>
          )}
        </div>
      </div>
    </nav>
  )
}
