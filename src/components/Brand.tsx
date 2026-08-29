interface BrandProps {
  onClick: () => void
}

export function Brand({ onClick }: BrandProps) {
  return (
    <button
      className="brand brand-button"
      onClick={onClick}
      aria-label="GiroMicro - voltar à página inicial"
    >
      <img
        className="brand-logo"
        src="/brand/giromicro-logo.png"
        alt="GiroMicro"
      />
    </button>
  )
}
