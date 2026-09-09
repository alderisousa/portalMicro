import { useState } from 'react'
import { Brand } from './Brand'
import { APP_VERSION, BUILD_COMMIT } from '../constants/appVersion'
import { usePwaInstallAction } from '../hooks/usePwaInstallAction'

interface FooterProps {
  onBrandClick: () => void
}

export function Footer({ onBrandClick }: FooterProps) {
  const installAction = usePwaInstallAction()
  const [showIosHint, setShowIosHint] = useState(false)

  return (
    <footer className="footer container">
      <Brand onClick={onBrandClick} />

      <div className="footer-meta">
        <span title={BUILD_COMMIT ? `build ${BUILD_COMMIT}` : undefined}>Seu negócio em movimento. · v{APP_VERSION}</span>
        <span>© 2026 GiroMicro · Feito para negócios que querem crescer.</span>

        {installAction.kind === 'prompt' && (
          <button type="button" className="footer-pwa-action" onClick={() => void installAction.install()}>
            {installAction.label}
          </button>
        )}

        {installAction.kind === 'ios-instructions' && (
          <div className="footer-pwa">
            <button type="button" className="footer-pwa-action" onClick={() => setShowIosHint((open) => !open)} aria-expanded={showIosHint}>
              {installAction.label}
            </button>
            {showIosHint && (
              <p className="footer-pwa-hint">No Safari, toque em Compartilhar e depois em Adicionar à Tela de Início.</p>
            )}
          </div>
        )}
      </div>

      <div className="footer-links">
        <a href="#/privacidade">Política de Privacidade</a>
        <a href="#/termos">Termos de Uso</a>
      </div>
    </footer>
  )
}
