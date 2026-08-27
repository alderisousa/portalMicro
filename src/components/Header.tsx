import { ArrowRight, Menu, ShieldCheck, UserRound } from 'lucide-react'
import { Brand } from './Brand'

interface HeaderProps {
  selectedCity: string
  requestedSite: string | null
  signedIn: boolean
  isAdmin: boolean
  pageOwner: boolean
  menuOpen: boolean
  setMenuOpen: (value: boolean) => void
  start: () => void
  logout: () => void
  setView: (view: 'home' | 'dashboard' | 'admin') => void
}

export function Header({
  selectedCity,
  requestedSite,
  signedIn,
  isAdmin,
  pageOwner,
  menuOpen,
  setMenuOpen,
  start,
  logout,
  setView,
}: HeaderProps) {
  const goHome = () => {
    if (requestedSite) {
      window.history.pushState({}, '', window.location.origin)
    }

    setView('home')
  }

  return (
    <>
      <nav className={`nav container ${requestedSite ? 'public-nav' : ''}`}>
        <Brand
          selectedCity={selectedCity}
          onClick={goHome}
          publicMode={Boolean(requestedSite)}
        />

        <button
          className="menu-button"
          onClick={() => setMenuOpen(!menuOpen)}
          aria-label="Abrir menu"
        >
          <Menu size={22} />
        </button>

        <div className={`nav-links ${menuOpen ? 'is-open' : ''}`}>
          {requestedSite ? (
            <button
              className="button button-small"
              onClick={pageOwner ? logout : start}
            >
              {pageOwner ? 'Sair' : 'Login'} <UserRound size={15} />
            </button>
          ) : (
            <>
              <a href="#como-funciona">Como funciona</a>
              <a href="#planos">Planos</a>

              {signedIn && (
                <button
                  className="nav-login button button-small"
                  onClick={() => setView('dashboard')}
                >
                  <UserRound size={15} />
                  Meu painel
                </button>
              )}

              {signedIn && isAdmin && (
                <button
                  className="button button-small button-outline"
                  onClick={() => setView('admin')}
                >
                  <ShieldCheck size={15} />
                  Administração
                </button>
              )}

              {signedIn && (
                <button className="button button-small" onClick={logout}>
                  Sair
                </button>
              )}

              {!signedIn && (
                <button
                  className="nav-login button button-small"
                  onClick={start}
                >
                  <UserRound size={15} />
                  Entrar
                </button>
              )}

              <button className="button button-small" onClick={start}>
                Divulgue seu negócio <ArrowRight size={16} />
              </button>
            </>
          )}
        </div>
      </nav>

    </>
  )
}
