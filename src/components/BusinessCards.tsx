import { ArrowRight } from 'lucide-react'
import type { ClientSummary } from '../types/business'

interface BusinessCardsProps {
  clients: ClientSummary[]
}

export function BusinessCards({ clients }: BusinessCardsProps) {
  if (clients.length === 0) return null

  return (
    <section className="client-list container">
      <div className="section-heading">
        <p className="eyebrow">Visite nossos clientes</p>

        <h2>
          Negócios que já estão <em>online.</em>
        </h2>
      </div>

      <div className="client-grid">
        {clients.map((client) => (
          <a
            className="client-card"
            key={client.slug}
            href={`/?site=${client.slug}`}
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
    </section>
  )
}
