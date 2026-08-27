import { Brand } from './Brand'

interface FooterProps {
  selectedCity: string
  onBrandClick: () => void
}

export function Footer({ selectedCity, onBrandClick }: FooterProps) {
  return (
    <footer className="footer container">
      <Brand selectedCity={selectedCity} onClick={onBrandClick} />

      <span>Presença digital para quem empreende.</span>

      <span>© 2026 {selectedCity} portalMicro</span>
    </footer>
  )
}
