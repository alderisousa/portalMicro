import { ArrowRight, Sparkles } from 'lucide-react'
import type { ReactNode } from 'react'
import { BusinessCards } from '../components/BusinessCards'
import { Footer } from '../components/Footer'
import { Plans } from '../components/Plans'
import type { ClientSummary } from '../types/business'

interface HomeProps {
  header: ReactNode
  clients: ClientSummary[]
  start: () => void
  signedIn: boolean
  authLoading: boolean
  selectedCity: string
  onBrandClick: () => void
}

export function Home({
  header,
  clients,
  start,
  signedIn,
  authLoading,
  selectedCity,
  onBrandClick,
}: HomeProps) {
  return (
    <main>
      {header}

      <section className="hero container" id="inicio">
        <div className="hero-copy">
          <p className="eyebrow">
            <Sparkles size={16} />
            {selectedCity} · Feito para quem faz acontecer
          </p>

          <h1>
            Seu negócio merece um lugar <em>à altura.</em>
          </h1>

          <p className="hero-text">
            Crie uma presença profissional em {selectedCity}, divulgue o que
            você faz e encontre novos clientes sem complicação.
          </p>

          <div className="hero-actions">
            <button className="button" onClick={start} disabled={authLoading}>
              {authLoading
                ? 'Verificando sessão...'
                : signedIn
                  ? 'Meu painel'
                  : 'Divulgue seu negócio'}{' '}
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
        </div>

        <div className="hero-art">
          <div className="art-label">Sua página, do seu jeito</div>

          <div className="preview-window">
            <div className="preview-top">
              <span />
              <span />
              <span />
              <b>minhanegocio.com.br</b>
            </div>

            <div className="preview-content">
              <div className="preview-avatar">AF</div>
              <div>
                <strong>Ateliê Flor de Anis</strong>
                <small>Doces artesanais · {selectedCity}</small>
              </div>
              <div className="preview-line" />
              <div className="preview-pills">
                <span>Encomendas</span>
                <span>Cardápio</span>
                <span>Contato</span>
              </div>
            </div>
          </div>

          <div className="floating-note">
            <span>●</span> Página publicada
          </div>
        </div>
      </section>

      <section className="proof-band">
        <div className="container proof-content">
          <span>Para todos os tipos de negócio</span>
          <strong>comércio</strong>
          <strong>serviços</strong>
          <strong>autônomos</strong>
          <strong>criadores</strong>
        </div>
      </section>

      <BusinessCards clients={clients} />

      <section className="section container" id="como-funciona">
        <div className="section-heading">
          <p className="eyebrow">{signedIn ? 'Como funciona' : 'Comece hoje'}</p>
          <h2>
            Da ideia para a internet,
            <br />
            <em>sem perder tempo.</em>
          </h2>
        </div>

        <div className="steps">
          <article>
            <b>01</b>
            <h3>Conte quem você é</h3>
            <p>
              Cadastre os dados da sua empresa, seus serviços e os canais de
              contato.
            </p>
          </article>
          <article>
            <b>02</b>
            <h3>Escolha seu estilo</h3>
            <p>
              Selecione um modelo e personalize a página com as cores da sua
              marca.
            </p>
          </article>
          <article>
            <b>03</b>
            <h3>Compartilhe por aí</h3>
            <p>
              Publique seu endereço e envie para seus clientes pelo WhatsApp ou
              redes sociais.
            </p>
          </article>
        </div>
      </section>

      {!signedIn && <Plans start={start} />}

      {!signedIn && (
        <section className="final-cta container" id="comece-hoje">
          <div>
            <p className="eyebrow">Seu próximo cliente está procurando</p>
            <h2>
              Vamos colocar seu negócio
              <br />
              <em>no mapa?</em>
            </h2>
          </div>

          <button className="button" onClick={start}>
            Divulgue seu negócio <ArrowRight size={18} />
          </button>
        </section>
      )}

      <Footer selectedCity={selectedCity} onBrandClick={onBrandClick} />
    </main>
  )
}
