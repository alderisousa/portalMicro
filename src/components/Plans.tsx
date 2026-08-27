import { Check } from 'lucide-react'

interface PlansProps {
  start: () => void
}

const plans = [
  {
    name: 'Free',
    price: 'R$ 0',
    complement: 'para começar',
    featured: true,
    hint: 'Ideal para começar',
    badge: 'Disponível agora',
    features: [
      'Página pública do seu negócio',
      'Informações e descrição da empresa',
      'Fotos de produtos ou serviços',
      'Endereço e região de atendimento',
      'WhatsApp e canais de contato',
    ],
  },
  {
    name: 'Profissional',
    price: 'Em breve',
    features: [
      'Tudo do plano Free',
      'Mais fotos e conteúdo',
      'Vídeos curtos',
      'Catálogo de produtos e serviços',
      'Mais opções de personalização',
    ],
  },
  {
    name: 'Destaque',
    price: 'Em breve',
    features: [
      'Tudo do Profissional',
      'Destaque na página principal',
      'Prioridade nas buscas',
      'Selo de negócio em destaque',
      'Recursos promocionais',
    ],
  },
]

export function Plans({ start }: PlansProps) {
  return (
    <section className="plans-section" id="planos">
      <div className="container">
        <div className="section-heading centered">
          <p className="eyebrow">Planos para todos os momentos</p>
          <h2>Escolha como você quer começar</h2>
        </div>

        <div className="plans">
          {plans.map((plan) => (
            <article
              className={`plan ${plan.featured ? 'featured' : ''}`}
              key={plan.name}
            >
              {plan.badge && <span className="popular">{plan.badge}</span>}
              <div className="plan-header">
                <h3>{plan.name}</h3>
                {plan.hint && <span className="plan-hint">{plan.hint}</span>}
                <div className="price">
                  {plan.price}
                  {plan.complement && <small>{plan.complement}</small>}
                </div>
              </div>
              <button
                className="button"
                disabled={!plan.featured}
                onClick={plan.featured ? start : undefined}
              >
                {plan.featured ? 'Divulgue seu negócio' : 'Em breve'}
              </button>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={15} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
