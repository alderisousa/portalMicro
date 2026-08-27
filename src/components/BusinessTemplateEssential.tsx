import { Mail, MapPin, MessageCircle } from 'lucide-react'
import type { Business } from '../types/business'
import { formatAddress } from '../utils/formatters'
import { getBusinessMediaUrl } from '../utils/storage'
import { StoryContent } from './StoryContent'

interface BusinessTemplateProps {
  business: Business
}

export function BusinessTemplateEssential({ business }: BusinessTemplateProps) {
  const address = formatAddress(business)

  return (
    <article className="business-template template-essential">
      <header className="essential-header">
        <div className="essential-brand-mark">
          {business.logo && (
            <img src={getBusinessMediaUrl(business.logo)} alt={`Logo de ${business.name}`} />
          )}
        </div>
        <div className="essential-heading-copy">
          {business.area && <span className="essential-category">{business.area}</span>}
          <h1>{business.name}</h1>
          {business.showAddress !== false && address && (
            <p className="essential-address"><MapPin size={16} /> {address}</p>
          )}
        </div>
      </header>

      <div className="essential-content">
        {business.story && (
          <section className="template-story essential-story" aria-labelledby="essential-story-title">
            <span className="template-section-kicker">Sobre o negócio</span>
            <h2 id="essential-story-title">Nossa história</h2>
            <StoryContent story={business.story} />
          </section>
        )}

        {business.photos.length > 0 && (
          <section aria-labelledby="essential-gallery-title">
            <span className="template-section-kicker">Conheça nosso trabalho</span>
            <h2 id="essential-gallery-title">Fotos</h2>
            <div className="essential-gallery">
              {business.photos.map((photo) => (
                <figure key={photo.id ?? photo.url}>
                  <img src={getBusinessMediaUrl(photo.url)} alt={photo.description || `Foto de ${business.name}`} />
                  {photo.description && <figcaption>{photo.description}</figcaption>}
                </figure>
              ))}
            </div>
          </section>
        )}

        {(business.whatsapp || business.email) && <footer className="template-contacts essential-contact-card">
          <div className="essential-contact-copy">
            <span className="template-section-kicker">Contato</span>
            <strong>Fale com a gente</strong>
          </div>
          {business.whatsapp && (
            <a className="button whatsapp-button" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
              <MessageCircle size={18} /> Fale conosco no WhatsApp
            </a>
          )}
          {business.email && <a className="template-email" href={`mailto:${business.email}`}><Mail size={17} /> {business.email}</a>}
        </footer>}
      </div>
    </article>
  )
}
