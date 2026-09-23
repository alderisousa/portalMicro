import { ArrowRight, Check, Image, Link2, Pause, Play, Sparkles, UserRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { BusinessCards } from '../components/BusinessCards'
import { Footer } from '../components/Footer'
import type { ClientSummary } from '../types/business'

interface HomeProps {
  header: ReactNode
  clients: ClientSummary[]
  start: () => void
  signedIn: boolean
  authLoading: boolean
  onBrandClick: () => void
}

const showcaseSlugs = [
  'jenifer-costa-psicanalista',
  'alderi-pereira-sousa',
  's-o-s-sistemas-t-i',
]

function HeroShowcase({ clients }: { clients: ClientSummary[] }) {
  const examples = showcaseSlugs.flatMap((slug) => {
    const client = clients.find((item) => item.slug === slug)
    return client ? [client] : []
  })
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const activeIndex = examples.length ? index % examples.length : 0

  useEffect(() => {
    // Reduced motion disables the CSS transition, not the rotation timer.
    if (examples.length < 2 || paused) return
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % examples.length)
    }, 4500)
    return () => window.clearInterval(timer)
  }, [examples.length, paused])

  return (
    <figure className="home-hero-visual home-hero-showcase"
      aria-label="Vitrine de páginas criadas no GiroMicro"
      onFocusCapture={(event) => {
        // Pause on focus entry; explicit Resume must work while focus stays here.
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(true)
      }}>
      <div className="home-hero-phone">
        <div className="home-hero-screen">
          <div className="home-hero-phone-top" aria-hidden="true"><span>9:41</span><span className="home-hero-camera" /><span>•••</span></div>
          <div className="home-hero-phone-address" aria-hidden="true"><Link2 size={13} /> giromicro.com.br/negocio/…</div>
          <div className="home-hero-slides" aria-live="off">
            {examples.map((client, slideIndex) => (
              <div key={client.slug}
                className={`home-hero-slide home-hero-slide-${showcaseSlugs.indexOf(client.slug)}${slideIndex === activeIndex ? ' is-active' : ''}`}
                aria-hidden={slideIndex !== activeIndex}>
                <div className="home-hero-showcase-cover" aria-hidden="true" />
                <div className="home-hero-showcase-logo">
                  <span aria-hidden="true">{client.name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join('')}</span>
                  {client.logo && <img src={client.logo} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} />}
                </div>
                {client.area && <span className="home-hero-showcase-area">{client.area}</span>}
                <strong className="home-hero-showcase-name">{client.name}</strong>
                <div className="home-hero-showcase-link"><Link2 size={16} aria-hidden="true" /><span>giromicro.com.br/negocio/<wbr />{client.slug}</span></div>
                <span className="home-hero-showcase-footer">Página no GiroMicro</span>
              </div>
            ))}
            {!examples.length && <div className="home-hero-showcase-empty">As páginas disponíveis serão apresentadas aqui.</div>}
          </div>
          <div className="home-hero-phone-bottom" aria-hidden="true" />
        </div>
      </div>
      {examples.length > 1 && <div className="home-hero-slide-controls" aria-label="Controles da vitrine">
        {examples.map((client, slideIndex) => (
          <button key={client.slug} type="button" aria-label={`Mostrar ${client.name}`}
            aria-pressed={slideIndex === activeIndex} onClick={() => { setIndex(slideIndex); setPaused(true) }}>
            <span />
          </button>
        ))}
        <button type="button" aria-label={paused ? 'Retomar troca automática' : 'Pausar troca automática'} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
        </button>
      </div>}
      <figcaption>Páginas criadas no GiroMicro<span>Uma prévia com dados reais de cada negócio.</span></figcaption>
    </figure>
  )
}

export function Home({
  header,
  clients,
  start,
  signedIn,
  authLoading,
  onBrandClick,
}: HomeProps) {
  return (
    <main className="home-page">
      {header}

      <section className="hero container home-hero" id="inicio">
        <div className="hero-copy">
          <p className="eyebrow">
            <Sparkles size={16} />
            Feito para quem faz acontecer
          </p>

          <h1>
            Seu negócio na internet.
            <span className="home-hero-free">GRÁTIS!</span>
          </h1>

          <p className="hero-text">
            Crie sua página profissional, divulgue seus produtos ou serviços
            e compartilhe seu negócio com seus clientes. Simples assim.
          </p>

          <div className="hero-actions">
            <button className="button" onClick={start} disabled={authLoading}>
              {authLoading
                ? 'Verificando sessão...'
                : signedIn
                  ? 'Meu painel'
                  : 'Criar minha página grátis'}{' '}
              <ArrowRight size={18} />
            </button>

            <a className="text-link" href="#como-funciona">
              Ver como funciona <ArrowRight size={16} />
            </a>
          </div>

          {!signedIn && (
            <p className="trust-note">
              Sem cartão de crédito · Configuração em poucos minutos
            </p>
          )}

          <ul className="home-hero-benefits">
            <li><Check size={17} aria-hidden="true" /> Página profissional</li>
            <li><Check size={17} aria-hidden="true" /> Link exclusivo para compartilhar</li>
            <li><Check size={17} aria-hidden="true" /> Seus produtos ou serviços em destaque</li>
          </ul>
        </div>

        <HeroShowcase clients={clients} />
      </section>

      <BusinessCards clients={clients} />

      <section className="section container home-how-it-works" id="como-funciona">
        <div className="section-heading">
          <p className="eyebrow">{signedIn ? 'Como funciona' : 'Comece hoje'}</p>
          <h2>
            Monte sua página em minutos,
            <br />
            <em>com poucos cliques.</em>
          </h2>
          <p className="section-support">Você conta sobre o seu negócio, escolhe seu estilo e o GiroMicro deixa tudo pronto para publicar e compartilhar.</p>
        </div>

        <ol className="home-journey">
          <li>
            <div className="journey-marker"><span>01</span><ArrowRight size={18} aria-hidden="true" /></div>
            <div className="journey-illustration" aria-hidden="true">
              <div className="journey-form">
                <div className="journey-profile"><UserRound size={23} /><div><i /><i /></div><Check size={16} /></div>
                <div className="journey-field" /><div className="journey-field journey-field-short" />
                <div className="journey-photo"><Image size={17} /><span>Seu negócio, do seu jeito</span></div>
              </div>
            </div>
            <h3>Conte sobre seu negócio</h3>
            <p>Dados, fotos, serviços e formas de contato.</p>
          </li>
          <li>
            <div className="journey-marker"><span>02</span><ArrowRight size={18} aria-hidden="true" /></div>
            <div className="journey-illustration" aria-hidden="true">
              <div className="journey-layout"><span className="journey-layout-avatar" /><i /><i /><small>Essencial</small></div>
              <div className="journey-layout journey-layout-selected"><Check className="journey-layout-check" size={17} /><span className="journey-layout-cover" /><i /><i /><small>Destaque</small></div>
            </div>
            <h3>Escolha seu estilo</h3>
            <p>Veja como sua página vai ficar e escolha o modelo que combina com você.</p>
          </li>
          <li>
            <div className="journey-marker journey-marker-complete"><span>03</span><Check size={18} aria-hidden="true" /></div>
            <div className="journey-illustration" aria-hidden="true">
              <div className="journey-published"><span className="journey-success"><Check size={23} /></span><strong>Sua página pronta!</strong><div><Link2 size={15} /><span>Pronta para compartilhar</span></div></div>
            </div>
            <h3>Publique e compartilhe</h3>
            <p>Sua página fica pronta para você divulgar aos seus clientes.</p>
          </li>
        </ol>
      </section>

      {!signedIn && (
        <section className="final-cta container" id="comece-hoje">
          <div>
            <p className="eyebrow">GiroMicro · Seu negócio em movimento.</p>
            <h2>
              Pronto para colocar seu negócio
              <br />
              <em>na internet?</em>
            </h2>
          </div>

          <button className="button" onClick={start} disabled={authLoading}>
            Criar minha página grátis <ArrowRight size={18} />
          </button>
        </section>
      )}

      <Footer onBrandClick={onBrandClick} />
    </main>
  )
}
