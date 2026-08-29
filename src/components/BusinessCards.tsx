import { ArrowRight } from 'lucide-react'
import type { ClientSummary } from '../types/business'

interface BusinessCardsProps {
  clients: ClientSummary[]
}

export function BusinessCards({ clients }: BusinessCardsProps) {
  return (
    <section className="client-list container" id="negocios" aria-labelledby="businesses-title">
      <div className="section-heading">
        <p className="eyebrow">Negócios da região</p>
        <h2 id="businesses-title">Visite nossos clientes</h2>
        <p className="section-support">
          Conheça negócios, profissionais e serviços da sua região.
        </p>
      </div>

      {clients.length > 0 ? (
        <div className="client-grid">
          {clients.map((client) => (
          <a
            className="client-card"
            key={client.slug}
            href={`/negocio/${encodeURIComponent(client.slug)}`}
          >
            {client.logo && <img src={client.logo} alt="" />}

            <span>
              <strong>{client.name}</strong>
              <small>{client.area}</small>
            </span>

            <ArrowRight size={18} />
          </a>
          ))}
        </div>
      ) : (
        <p className="client-empty">Novos negócios serão apresentados aqui em breve.</p>
      )}
    </section>
  )
}
