import { ArrowLeft, ArrowRight, Check, Globe, ImagePlus, Menu, MessageCircle, Save, Sparkles, UserRound, X } from 'lucide-react'
import { signInWithPopup } from 'firebase/auth'
import { ChangeEvent, useEffect, useState } from 'react'
import { auth, firebaseConfigured, googleProvider } from './firebase'

const selectedCity = 'Itanhém'
const storageKey = 'portalmicro-business'
const sessionKey = 'portalmicro-session'
const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:4000'
const stepNames = ['Atuação', 'Identidade', 'Local', 'Sua história', 'Fotos', 'Contato']

type Photo = { url: string; description: string }
type Business = {
  area: string; name: string; logo: string; location: 'fisico' | 'online' | ''
  address: string; story: string; photos: Photo[]; whatsapp: string; published: boolean; publicUrl: string; step: number
}
const emptyBusiness: Business = { area: '', name: '', logo: '', location: '', address: '', story: '', photos: [], whatsapp: '', published: false, publicUrl: '', step: 0 }

function App() {
  const [view, setView] = useState<'home' | 'login' | 'dashboard' | 'wizard' | 'preview'>(() => new URLSearchParams(window.location.search).has('site') ? 'preview' : 'home')
  const [menuOpen, setMenuOpen] = useState(false)
  const [signedIn, setSignedIn] = useState(() => localStorage.getItem(sessionKey) === 'demo-user')
  const [authMessage, setAuthMessage] = useState('')
  const [business, setBusiness] = useState<Business>(() => JSON.parse(localStorage.getItem(storageKey) || 'null') || emptyBusiness)
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(business))
    const slug = business.name || business.area
    if (slug) fetch(`${apiUrl}/api/clients/${encodeURIComponent(slug)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(business) }).catch(() => undefined)
  }, [business])
  const update = (patch: Partial<Business>) => setBusiness((current) => ({ ...current, ...patch }))
  const start = () => setView(signedIn ? 'dashboard' : 'login')
  const signIn = async () => {
    setAuthMessage('')
    if (!firebaseConfigured || !auth) {
      setAuthMessage('A autenticação Google ainda precisa ser configurada no Firebase. Preencha as variáveis VITE_FIREBASE_* no arquivo .env.local.')
      return
    }
    try {
      await signInWithPopup(auth, googleProvider)
      localStorage.setItem(sessionKey, 'google-user')
      setSignedIn(true)
      setView('dashboard')
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as { code?: string }).code) : ''
      setAuthMessage(code === 'auth/unauthorized-domain'
        ? 'Este endereço ainda não está autorizado no Firebase. Adicione harmonious-belekoy-fd4647.netlify.app em Authentication > Settings > Authorized domains.'
        : `Não foi possível concluir o login Google${code ? ` (${code})` : ''}. Confirme o provedor Google no Firebase e tente novamente.`)
    }
  }
  const demoSignIn = () => { localStorage.setItem(sessionKey, 'demo-user'); setSignedIn(true); setView('dashboard') }
  const next = () => { update({ step: Math.min(business.step + 1, 5) }); setView('wizard') }
  const publish = () => {
    const slug = (business.name || business.area || selectedCity).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const publicUrl = `${window.location.origin}/?site=${slug || 'meu-negocio'}`
    update({ published: true, publicUrl })
    window.history.pushState({}, '', publicUrl)
    setView('preview')
  }
  const back = () => business.step === 0 ? setView('dashboard') : update({ step: business.step - 1 })
  const addPhotos = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []).slice(0, 10 - business.photos.length)
    const formData = new FormData()
    files.forEach((file) => formData.append('photos', file))
    const slug = business.name || business.area || selectedCity
    try {
      const result = await fetch(`${apiUrl}/api/clients/${encodeURIComponent(slug)}/upload`, { method: 'POST', body: formData })
      const uploaded = await result.json() as { files: { path: string }[] }
      update({ photos: [...business.photos, ...uploaded.files.map((file) => ({ url: `${apiUrl}${file.path}`, description: '' }))] })
    } catch {
      update({ photos: [...business.photos, ...files.map((file) => ({ url: URL.createObjectURL(file), description: '' }))] })
    }
    event.target.value = ''
  }
  const brand = <button className="brand brand-button" onClick={() => setView('home')} aria-label={`${selectedCity} portalMicro - início`}><span className="brand-mark">M</span><span><b className="brand-city">{selectedCity}</b> portal<span>micro</span></span></button>
  const header = <nav className="nav container">{brand}<button className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Abrir menu"><Menu size={22} /></button><div className={`nav-links ${menuOpen ? 'is-open' : ''}`}><a href="#como-funciona">Como funciona</a><button className="nav-login" onClick={start}><UserRound size={15} /> {signedIn ? 'Meu painel' : 'Entrar'}</button><button className="button button-small" onClick={start}>Criar minha página <ArrowRight size={16} /></button></div></nav>

  if (view === 'login') return <main>{header}<section className="auth-shell"><div className="auth-card"><span className="brand-mark large">M</span><p className="eyebrow centered-eyebrow">Seu espaço em {selectedCity}</p><h1>Vamos começar<br /><em>pelo seu negócio.</em></h1><p>Entre com sua conta Google para salvar seu progresso e criar sua página institucional.</p><button className="google-button" onClick={signIn}><span className="google-g">G</span> Continuar com Google</button>{authMessage && <p className="auth-message">{authMessage}</p>}<button className="demo-button" onClick={demoSignIn}>Continuar em modo demonstração</button><small>O modo demonstração salva os dados apenas neste navegador. O login Google será ativado quando o Firebase for configurado.</small><button className="back-link" onClick={() => setView('home')}><ArrowLeft size={15} /> Voltar</button></div></section></main>

  if (view === 'dashboard') return <main>{header}<section className="dashboard container"><div className="dashboard-top"><div><p className="eyebrow"><Sparkles size={16} /> Área do empreendedor</p><h1>Olá, <em>vamos construir?</em></h1><p className="hero-text">Seu espaço de criação fica salvo automaticamente neste navegador.</p></div><button className="button" onClick={() => setView('wizard')}>{business.step ? 'Continuar criação' : 'Começar meu site'} <ArrowRight size={18} /></button></div><div className="dashboard-grid"><article className="status-panel"><div className="panel-heading"><div><span className="panel-kicker">SITE INSTITUCIONAL</span><h2>{business.name || 'Seu negócio'}</h2></div><span className={`status ${business.published ? 'published' : ''}`}>{business.published ? 'Público' : 'Rascunho'}</span></div><div className="progress-row"><span>Progresso da criação</span><strong>{business.step === 5 ? '100' : Math.round((business.step / 6) * 100)}%</strong></div><div className="progress"><span style={{ width: `${business.step === 5 ? 100 : (business.step / 6) * 100}%` }} /></div><div className="panel-actions"><button className="button button-outline" onClick={() => setView('preview')}><Globe size={16} /> Visualizar</button><button className="text-link" onClick={publish}><Check size={16} /> {business.published ? 'Atualizar site público' : 'Publicar site'}</button></div>{business.publicUrl && <a className="public-url" href={business.publicUrl}>{business.publicUrl}</a>}</article><aside className="next-panel"><span className="step-number">{String(Math.min(business.step + 1, 6)).padStart(2, '0')}</span><h3>{business.step === 5 ? 'Tudo pronto para publicar' : `Próximo: ${stepNames[business.step]}`}</h3><p>Responda algumas perguntas e deixe o assistente organizar sua presença digital.</p><button className="text-link" onClick={() => setView('wizard')}>Abrir assistente <ArrowRight size={16} /></button></aside></div><div className="privacy-note"><Save size={16} /><span>Dados salvos localmente. A publicação só acontece quando você autorizar.</span></div></section></main>

  if (view === 'wizard') return <main>{header}<section className="wizard-shell container"><div className="wizard-intro"><button className="back-link" onClick={() => setView('dashboard')}><ArrowLeft size={15} /> Meu painel</button><p className="eyebrow"><Sparkles size={16} /> Assistente portalMicro</p><h1>Vamos dar voz ao<br /><em>seu negócio.</em></h1><p>Você pode voltar quando quiser. Nós salvamos cada resposta.</p></div><div className="wizard-card"><div className="stepper">{stepNames.map((step, index) => <button key={step} className={index === business.step ? 'active' : index < business.step ? 'done' : ''} onClick={() => index <= business.step && update({ step: index })}><span>{index < business.step ? <Check size={14} /> : index + 1}</span>{step}</button>)}</div><WizardQuestion business={business} update={update} addPhotos={addPhotos} /><div className="wizard-footer"><button className="button button-outline" onClick={back}><ArrowLeft size={16} /> Voltar</button>{business.step < 5 ? <button className="button" onClick={next}>Salvar e continuar <ArrowRight size={16} /></button> : <button className="button" onClick={() => setView('dashboard')}><Check size={16} /> Concluir cadastro</button>}</div></div></section></main>

  if (view === 'preview') return <main>{header}<section className="public-preview container"><div className="preview-toolbar"><button className="back-link" onClick={() => setView('dashboard')}><ArrowLeft size={15} /> Meu painel</button><span className={`status ${business.published ? 'published' : ''}`}>{business.published ? 'Site público' : 'Prévia privada'}</span><button className="button button-small" onClick={publish}>{business.published ? 'Atualizar site' : 'Publicar site'} <Globe size={15} /></button></div><article className="business-site"><div className="business-cover">{business.logo && <img src={business.logo} alt="Logo" />}<span>{business.area || 'Seu negócio'}</span><h1>{business.name || 'Nome da sua empresa'}</h1><small>{business.location === 'fisico' ? business.address || selectedCity : 'Atendimento online'}</small></div><div className="business-body"><StoryContent story={business.story} /><div className="business-photos">{business.photos.map((photo) => <figure key={photo.url}><img src={photo.url} alt={photo.description} /><figcaption>{photo.description}</figcaption></figure>)}</div>{business.whatsapp && <a className="button whatsapp-button" href={`https://wa.me/${business.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"><MessageCircle size={18} /> Fale conosco no WhatsApp</a>}{business.publicUrl && <p className="share-note">Endereço público: <a href={business.publicUrl}>{business.publicUrl}</a></p>}</div></article></section></main>

  return <main>{header}<section className="hero container" id="inicio"><div className="hero-copy"><p className="eyebrow"><Sparkles size={16} /> {selectedCity} · Feito para quem faz acontecer</p><h1>Seu negócio merece um lugar <em>à altura.</em></h1><p className="hero-text">Crie uma presença profissional em {selectedCity}, divulgue o que você faz e encontre novos clientes sem complicação.</p><div className="hero-actions"><button className="button" onClick={start}>Começar de graça <ArrowRight size={18} /></button><a className="text-link" href="#como-funciona">Ver como funciona <ArrowRight size={16} /></a></div><p className="trust-note">Sem cartão de crédito · Configuração em poucos minutos</p></div><div className="hero-art"><div className="art-label">Sua página, do seu jeito</div><div className="preview-window"><div className="preview-top"><span /><span /><span /><b>minhanegocio.com.br</b></div><div className="preview-content"><div className="preview-avatar">AF</div><div><strong>Ateliê Flor de Anis</strong><small>Doces artesanais · {selectedCity}</small></div><div className="preview-line" /><div className="preview-pills"><span>Encomendas</span><span>Cardápio</span><span>Contato</span></div></div></div><div className="floating-note"><span>●</span> Página publicada</div></div></section><section className="proof-band"><div className="container proof-content"><span>Para todos os tipos de negócio</span><strong>comércio</strong><strong>serviços</strong><strong>autônomos</strong><strong>criadores</strong></div></section><section className="section container" id="como-funciona"><div className="section-heading"><p className="eyebrow">Comece hoje</p><h2>Da ideia para a internet,<br /><em>sem perder tempo.</em></h2></div><div className="steps"><article><b>01</b><h3>Conte quem você é</h3><p>Cadastre os dados da sua empresa, seus serviços e os canais de contato.</p></article><article><b>02</b><h3>Escolha seu estilo</h3><p>Selecione um modelo e personalize a página com as cores da sua marca.</p></article><article><b>03</b><h3>Compartilhe por aí</h3><p>Publique seu endereço e envie para seus clientes pelo WhatsApp ou redes sociais.</p></article></div></section><section className="final-cta container"><div><p className="eyebrow">Seu próximo cliente está procurando</p><h2>Vamos colocar seu negócio<br /><em>no mapa?</em></h2></div><button className="button" onClick={start}>Criar minha página <ArrowRight size={18} /></button></section><footer className="footer container">{brand}<span>Presença digital para quem empreende.</span><span>© 2026 {selectedCity} portalMicro</span></footer></main>
}

type QuestionProps = { business: Business; update: (patch: Partial<Business>) => void; addPhotos: (event: ChangeEvent<HTMLInputElement>) => void }
function StoryContent({ story }: { story: string }) {
  const source = story || 'Sua história e o jeito especial de trabalhar aparecerão aqui.'
  const normalized = source
    .replace(/\s+(?=#{1,3}\s)/g, '\n\n')
    .replace(/\s+\*\s+(?=[A-ZÁÉÍÓÚÀÂÃÊÔÇ])/g, '\n- ')
  const blocks: { type: 'heading' | 'paragraph' | 'list'; level?: number; text?: string; items?: string[] }[] = []
  let paragraph: string[] = []
  let list: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') })
    if (list.length) blocks.push({ type: 'list', items: list })
    paragraph = []
    list = []
  }
  normalized.split(/\n/).forEach((line) => {
    const clean = line.trim()
    if (!clean) return flush()
    const heading = clean.match(/^(#{1,3})\s+(.+)$/)
    const bullet = clean.match(/^[-•*]\s+(.+)$/)
    if (heading) { flush(); blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }) }
    else if (bullet) { if (paragraph.length) flush(); list.push(bullet[1]) }
    else { if (list.length) flush(); paragraph.push(clean) }
  })
  flush()
  return <div className="story-content">{blocks.map((block, index) => {
    if (block.type === 'heading') return block.level === 1 ? <h2 key={index}>{renderInline(block.text || '')}</h2> : <h3 key={index}>{renderInline(block.text || '')}</h3>
    if (block.type === 'list') return <ul key={index}>{block.items?.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}</ul>
    return <p key={index}>{renderInline(block.text || '')}</p>
  })}</div>
}

function renderInline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>
    return part
  })
}
function WizardQuestion({ business, update, addPhotos }: QuestionProps) {
  if (business.step === 0) return <div className="question"><h2>Qual a área de atuação da sua empresa?</h2><p>Conte para encontrarmos as melhores palavras para apresentar seu trabalho.</p><input autoFocus value={business.area} onChange={(event) => update({ area: event.target.value })} placeholder="Ex.: confeitaria, eletricista, loja de roupas..." /></div>
  if (business.step === 1) return <div className="question"><h2>Como as pessoas vão reconhecer sua marca?</h2><p>Adicione uma foto ou logo e o nome fantasia.</p><label className="upload-logo">{business.logo ? <img src={business.logo} alt="Logo da empresa" /> : <ImagePlus size={25} />}<span>{business.logo ? 'Logo adicionada' : 'Adicionar foto ou logo'}</span><input type="file" accept="image/*" onChange={(event) => { const file = event.target.files?.[0]; if (file) update({ logo: URL.createObjectURL(file) }) }} /></label><input value={business.name} onChange={(event) => update({ name: event.target.value })} placeholder="Nome fantasia" /></div>
  if (business.step === 2) return <div className="question"><h2>Onde você atende?</h2><p>Escolha como seus clientes encontram você.</p><div className="choice-grid"><button className={business.location === 'fisico' ? 'selected' : ''} onClick={() => update({ location: 'fisico' })}><strong>Local físico</strong><span>Recebo clientes em um endereço</span></button><button className={business.location === 'online' ? 'selected' : ''} onClick={() => update({ location: 'online', address: '' })}><strong>Somente online</strong><span>Atendo pela internet ou delivery</span></button></div>{business.location === 'fisico' && <input value={business.address} onChange={(event) => update({ address: event.target.value })} placeholder="Endereço completo" />}</div>
  if (business.step === 3) return <div className="question"><h2>Conte um pouco de você e da sua empresa.</h2><p>Capriche: esse texto ajuda as pessoas a se interessarem pelo seu trabalho.</p><textarea autoFocus value={business.story} onChange={(event) => update({ story: event.target.value })} placeholder="Como começou? O que torna seu trabalho especial?" rows={7} /></div>
  if (business.step === 4) return <div className="question"><h2>Mostre o que você faz.</h2><p>Você pode adicionar até 10 fotos e descrever cada produto ou serviço.</p><label className="photo-drop"><ImagePlus size={25} /><strong>Adicionar fotos</strong><span>{business.photos.length}/10 fotos adicionadas</span><input type="file" accept="image/*" multiple onChange={addPhotos} /></label><div className="photo-list">{business.photos.map((photo, index) => <div className="photo-item" key={photo.url}><img src={photo.url} alt="" /><input value={photo.description} onChange={(event) => update({ photos: business.photos.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item) })} placeholder="Descreva este produto ou serviço" /><button onClick={() => update({ photos: business.photos.filter((_, itemIndex) => itemIndex !== index) })} aria-label="Remover foto"><X size={16} /></button></div>)}</div></div>
  return <div className="question"><h2>Como seus clientes falam com você?</h2><p>Deixe um número de WhatsApp para o botão “Fale conosco”.</p><input autoFocus value={business.whatsapp} onChange={(event) => update({ whatsapp: event.target.value })} placeholder="(73) 99999-9999" /><div className="whatsapp-hint"><MessageCircle size={20} /><span>Depois de publicar, você poderá compartilhar seus produtos em grupos do WhatsApp.</span></div></div>
}

export default App
