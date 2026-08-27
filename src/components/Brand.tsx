interface BrandProps {
  selectedCity: string
  onClick: () => void
  publicMode?: boolean
}

export function Brand({ selectedCity, onClick, publicMode = false }: BrandProps) {
  return (
    <button
      className="brand brand-button"
      onClick={onClick}
      aria-label={
        publicMode
          ? 'Voltar à página inicial'
          : `${selectedCity} portalMicro - início`
      }
    >
      <span className="brand-mark">M</span>

      {publicMode ? (
        <span>
          portal<span>micro</span>
        </span>
      ) : (
        <span>
          <b className="brand-city">{selectedCity}</b>{' '}
          portal<span>micro</span>
        </span>
      )}
    </button>
  )
}
