import { Brand } from './Brand'

interface FooterProps {
  selectedCity: string
  onBrandClick: () => void
}

export function Footer({ selectedCity, onBrandClick }: FooterProps) {
  return (
    <footer className="footer container">
      <Brand onClick={onBrandClick} />

      <div className="footer-meta">
        <span>Presença digital para quem empreende.</span>
        <span>© 2026 PortalMicro · Atuação atual: {selectedCity}</span>
      </div>

      <div className="footer-links">
        <a href="#/privacidade">Política de Privacidade</a>
        <a href="#/termos">Termos de Uso</a>
      </div>
    </footer>
  )
}
