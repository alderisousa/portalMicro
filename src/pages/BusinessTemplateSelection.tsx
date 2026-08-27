import { ArrowLeft, Check, Eye } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { BusinessTemplateEssential } from '../components/BusinessTemplateEssential'
import { BusinessTemplateFeatured } from '../components/BusinessTemplateFeatured'
import type { Business, BusinessTemplateKey } from '../types/business'

interface BusinessTemplateChooserProps {
  business: Business
  saving: boolean
  message: string
  onSave: (template: BusinessTemplateKey) => void
}

interface BusinessTemplateSelectionProps extends BusinessTemplateChooserProps {
  header: ReactNode
  onBack: () => void
}

const options: Array<{ key: BusinessTemplateKey; name: string; description: string }> = [
  { key: 'essential', name: 'Essencial', description: 'Um layout limpo e direto, com todas as informações importantes em destaque.' },
  { key: 'featured', name: 'Destaque', description: 'Uma apresentação mais visual, com foto de capa e WhatsApp em evidência.' },
]

export function BusinessTemplateChooser({ business, saving, message, onSave }: BusinessTemplateChooserProps) {
  const [previewTemplate, setPreviewTemplate] = useState<BusinessTemplateKey | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  const preview = (template: BusinessTemplateKey) => {
    setPreviewTemplate(template)
    window.requestAnimationFrame(() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }

  return (
    <>
      <div className="template-selection-heading">
        <p className="eyebrow">Modelo da página</p>
        <h1>Escolha como seu negócio será apresentado.</h1>
        <p>Os dois modelos usam os mesmos dados já cadastrados e estão disponíveis neste plano.</p>
      </div>

      <div className="template-option-grid">
        {options.map((option, index) => {
          const active = business.templateKey === option.key
          return (
            <article className={`template-option${active ? ' is-active' : ''}`} key={option.key}>
              <span className="template-number">Modelo {index + 1}</span>
              <div className="template-option-title"><h2>{option.name}</h2><span>Grátis</span></div>
              <p>{option.description}</p>
              {active && <strong className="current-template"><Check size={15} /> Modelo atual</strong>}
              <div className="template-option-actions">
                <button className="button button-outline" onClick={() => preview(option.key)} disabled={saving}>
                  <Eye size={16} /> Pré-visualizar
                </button>
                <button className="button" onClick={() => onSave(option.key)} disabled={saving || active}>
                  {saving ? 'Salvando...' : active ? 'Em uso' : 'Usar este modelo'}
                </button>
              </div>
            </article>
          )
        })}
      </div>

      {message && <p className="template-message" role="status">{message}</p>}

      {previewTemplate && (
        <div className="template-live-preview" ref={previewRef}>
          <div className="template-preview-heading">
            <div><span>Pré-visualização com seus dados</span><strong>{previewTemplate === 'essential' ? 'Essencial' : 'Destaque'}</strong></div>
            <button className="button button-small button-outline" onClick={() => setPreviewTemplate(null)}>Fechar prévia</button>
          </div>
          {previewTemplate === 'featured'
            ? <BusinessTemplateFeatured business={business} />
            : <BusinessTemplateEssential business={business} />}
        </div>
      )}
    </>
  )
}

export function BusinessTemplateSelection({ header, business, saving, message, onBack, onSave }: BusinessTemplateSelectionProps) {
  return (
    <main>
      {header}
      <section className="template-selection container">
        <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Meu painel</button>
        <BusinessTemplateChooser business={business} saving={saving} message={message} onSave={onSave} />
      </section>
    </main>
  )
}
