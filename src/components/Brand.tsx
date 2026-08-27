interface BrandProps {
  onClick: () => void
}

export function Brand({ onClick }: BrandProps) {
  return (
    <button
      className="brand brand-button"
      onClick={onClick}
      aria-label="PortalMicro - voltar à página inicial"
    >
      <img
        className="brand-logo"
        src="/brand/portalmicro-logo.png"
        alt="PortalMicro - Seu negócio em destaque"
      />
    </button>
  )
}
