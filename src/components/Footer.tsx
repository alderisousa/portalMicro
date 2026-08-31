import { Brand } from './Brand'
import { APP_VERSION } from '../constants/appVersion'

interface FooterProps {
  onBrandClick: () => void
}

export function Footer({ onBrandClick }: FooterProps) {
  return (
    <footer className="footer container">
      <Brand onClick={onBrandClick} />

      <div className="footer-meta">
        <span>Seu negócio em movimento. · v{APP_VERSION}</span>
        <span>© 2026 GiroMicro · Feito para negócios que querem crescer.</span>
      </div>

      <div className="footer-links">
        <a href="#/privacidade">Política de Privacidade</a>
        <a href="#/termos">Termos de Uso</a>
      </div>
    </footer>
  )
}
