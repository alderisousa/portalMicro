import { Mail, MapPin, MessageCircle, Navigation } from 'lucide-react'
import type { Business } from '../types/business'
import { getAddressPresentation, getShowcaseCopy } from '../utils/businessPresentation'
import { getBusinessMediaUrl } from '../utils/storage'
import { StoryContent } from './StoryContent'

export function BusinessTemplateFeatured({ business }: { business: Business }) {
  const heroPhoto = business.photos[0]
  const galleryPhotos = heroPhoto ? business.photos.slice(1) : business.photos
  const showcase = getShowcaseCopy(business.businessModel)
  const address = getAddressPresentation(business)
  const showLocation = business.showAddress !== false && address.lines.length > 0
  return <article className={`business-template template-featured${heroPhoto ? '' : ' without-hero-photo'}`}>
    <header className="featured-hero" style={heroPhoto ? { backgroundImage: `url(${getBusinessMediaUrl(heroPhoto.url)})` } : undefined}><div className="featured-overlay">{business.logo && <div className="featured-logo"><img src={getBusinessMediaUrl(business.logo)} alt={`Logo de ${business.name}`} /></div>}{business.area && <span className="featured-category">{business.area}</span>}<h1>{business.name}</h1>{business.whatsapp && <a className="button featured-whatsapp" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"><MessageCircle size={19} /> Chamar no WhatsApp</a>}</div>{heroPhoto?.description && <p className="featured-hero-caption">{heroPhoto.description}</p>}</header>
    <div className="featured-content">
      {business.story && <section className="template-story featured-story" aria-labelledby="featured-story-title"><p className="eyebrow">Apresentação</p><h2 id="featured-story-title">Saiba mais</h2><StoryContent story={business.story} /></section>}
      {galleryPhotos.length > 0 && <section className="featured-gallery-section" aria-labelledby="featured-gallery-title"><p className="eyebrow">Vitrine</p><h2 id="featured-gallery-title">{showcase.publicTitle}</h2><div className="featured-gallery">{galleryPhotos.map((photo) => <figure key={photo.id ?? photo.url}><img src={getBusinessMediaUrl(photo.url)} alt={photo.title || photo.description || `Item de ${business.name}`} />{(photo.title || photo.description) && <figcaption>{photo.title && <strong>{photo.title}</strong>}{photo.description && <span>{photo.description}</span>}</figcaption>}</figure>)}</div></section>}
      {(business.email || business.whatsapp) && <footer className="featured-contact-card"><div><span className="template-section-kicker">Entre em contato</span>{business.email && <a href={`mailto:${business.email}`}><Mail size={17} /> {business.email}</a>}</div>{business.whatsapp && <a className="button" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"><MessageCircle size={18} /> WhatsApp</a>}</footer>}
      {showLocation && <section className="business-location featured-location" aria-labelledby="featured-location-title"><span className="template-section-kicker"><MapPin size={15} /> Localização</span><h2 id="featured-location-title">Onde estamos</h2><address>{address.lines.map((line) => <span key={line}>{line}</span>)}</address>{address.mapsUrl && <a className="button button-outline" href={address.mapsUrl} target="_blank" rel="noopener noreferrer"><Navigation size={17} /> Como chegar</a>}</section>}
    </div>
  </article>
}
