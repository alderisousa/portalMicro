import { Mail, MapPin, MessageCircle } from 'lucide-react'
import type { Business } from '../types/business'
import { formatAddress } from '../utils/formatters'
import { getBusinessMediaUrl } from '../utils/storage'
import { StoryContent } from './StoryContent'

interface BusinessTemplateProps {
  business: Business
}

export function BusinessTemplateFeatured({ business }: BusinessTemplateProps) {
  const heroPhoto = business.photos[0]
  const galleryPhotos = heroPhoto ? business.photos.slice(1) : business.photos
  const address = formatAddress(business)

  return (
    <article className={`business-template template-featured${heroPhoto ? '' : ' without-hero-photo'}`}>
      <header
        className="featured-hero"
        style={heroPhoto ? { backgroundImage: `url(${getBusinessMediaUrl(heroPhoto.url)})` } : undefined}
      >
        <div className="featured-overlay">
          {business.logo && <div className="featured-logo"><img src={getBusinessMediaUrl(business.logo)} alt={`Logo de ${business.name}`} /></div>}
          {business.area && <span className="featured-category">{business.area}</span>}
          <h1>{business.name}</h1>
          {business.showAddress !== false && address && (
            <p className="featured-hero-address"><MapPin size={17} /> {address}</p>
          )}
          {business.whatsapp && (
            <a className="button featured-whatsapp" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
              <MessageCircle size={19} /> Chamar no WhatsApp
            </a>
          )}
        </div>
        {heroPhoto?.description && (
          <p className="featured-hero-caption">{heroPhoto.description}</p>
        )}
      </header>

      <div className="featured-content">
        {business.story && (
          <section className="template-story featured-story" aria-labelledby="featured-story-title">
            <p className="eyebrow">Conheça nosso trabalho</p>
            <h2 id="featured-story-title">Nossa história</h2>
            <StoryContent story={business.story} />
          </section>
        )}

        {galleryPhotos.length > 0 && (
          <section className="featured-gallery-section" aria-labelledby="featured-gallery-title">
            <p className="eyebrow">Imagens do negócio</p>
            <h2 id="featured-gallery-title">Galeria</h2>
            <div className="featured-gallery">
              {galleryPhotos.map((photo) => (
                <figure key={photo.id ?? photo.url}>
                  <img src={getBusinessMediaUrl(photo.url)} alt={photo.description || `Foto de ${business.name}`} />
                  {photo.description && <figcaption>{photo.description}</figcaption>}
                </figure>
              ))}
            </div>
          </section>
        )}

        {(business.email || business.whatsapp) && <footer className="featured-contact-card">
          <div>
            <span className="template-section-kicker">Entre em contato</span>
            {business.email && <a href={`mailto:${business.email}`}><Mail size={17} /> {business.email}</a>}
          </div>
          {business.whatsapp && (
            <a className="button" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
              <MessageCircle size={18} /> WhatsApp
            </a>
          )}
        </footer>}
      </div>
    </article>
  )
}
