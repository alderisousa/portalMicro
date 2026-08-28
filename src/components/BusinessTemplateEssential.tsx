import { Mail, MapPin, MessageCircle, Navigation } from 'lucide-react'
import type { Business } from '../types/business'
import { getAddressPresentation, getShowcaseCopy } from '../utils/businessPresentation'
import { getBusinessMediaUrl } from '../utils/storage'
import { StoryContent } from './StoryContent'

export function BusinessTemplateEssential({ business }: { business: Business }) {
  const showcase = getShowcaseCopy(business.businessModel)
  const address = getAddressPresentation(business)
  const showLocation = business.showAddress !== false && address.lines.length > 0
  return <article className="business-template template-essential">
    <header className="essential-header"><div className="essential-brand-mark">{business.logo && <img src={getBusinessMediaUrl(business.logo)} alt={`Logo de ${business.name}`} />}</div><div className="essential-heading-copy">{business.area && <span className="essential-category">{business.area}</span>}<h1>{business.name}</h1></div></header>
    <div className="essential-content">
      {business.story && <section className="template-story essential-story" aria-labelledby="essential-story-title"><span className="template-section-kicker">Sobre o negócio</span><h2 id="essential-story-title">Nossa história</h2><StoryContent story={business.story} /></section>}
      {business.photos.length > 0 && <section aria-labelledby="essential-gallery-title"><span className="template-section-kicker">Vitrine</span><h2 id="essential-gallery-title">{showcase.publicTitle}</h2><div className="essential-gallery">{business.photos.map((photo) => <figure key={photo.id ?? photo.url}><img src={getBusinessMediaUrl(photo.url)} alt={photo.title || photo.description || `Item de ${business.name}`} />{(photo.title || photo.description) && <figcaption>{photo.title && <strong>{photo.title}</strong>}{photo.description && <span>{photo.description}</span>}</figcaption>}</figure>)}</div></section>}
      {(business.whatsapp || business.email) && <footer className="template-contacts essential-contact-card"><div className="essential-contact-copy"><span className="template-section-kicker">Contato</span><strong>Fale com a gente</strong></div>{business.whatsapp && <a className="button whatsapp-button" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"><MessageCircle size={18} /> Fale conosco no WhatsApp</a>}{business.email && <a className="template-email" href={`mailto:${business.email}`}><Mail size={17} /> {business.email}</a>}</footer>}
      {showLocation && <section className="business-location" aria-labelledby="essential-location-title"><span className="template-section-kicker"><MapPin size={15} /> Localização</span><h2 id="essential-location-title">Onde estamos</h2><address>{address.lines.map((line) => <span key={line}>{line}</span>)}</address>{address.mapsUrl && <a className="button button-outline" href={address.mapsUrl} target="_blank" rel="noopener noreferrer"><Navigation size={17} /> Como chegar</a>}</section>}
    </div>
  </article>
}
