import { AlertTriangle, Camera, Copy, ImagePlus, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { checkImageQuality, type ImageQualityResult } from '../utils/imageQualityCheck'
import { prepareImageForOcr } from '../utils/imagePreprocess'

// PoC (checkpoint 5D.1/5D.1.1): so leitura local de texto bruto via Tesseract.js,
// para avaliar se OCR client-side e gratuito e suficiente para fotos reais de nota.
// Nao envia a imagem a lugar nenhum, nao monta itens/fornecedor/CNPJ e nao toca
// em market_purchases/conciliacao. O modelo em lista (varias "paginas") existe so
// para nao travar uma evolucao futura para 1..N imagens; cada pagina e analisada
// isoladamente, sem nenhuma consolidacao entre paginas neste checkpoint.

// Page Segmentation Mode do Tesseract, exposto como controle de diagnostico para
// calibrar com fotos reais — "Automático" e o comportamento padrao/anterior, nada
// muda a menos que o usuario troque. As chaves mapeiam para Tesseract.PSM em tempo
// de execucao (import dinamico), entao nao ha valor hardcoded aqui.
type PsmChoice = 'auto' | 'single_column' | 'single_block' | 'sparse_text'
const PSM_KEY_BY_CHOICE: Record<PsmChoice, 'AUTO' | 'SINGLE_COLUMN' | 'SINGLE_BLOCK' | 'SPARSE_TEXT'> = {
  auto: 'AUTO', single_column: 'SINGLE_COLUMN', single_block: 'SINGLE_BLOCK', sparse_text: 'SPARSE_TEXT',
}
const PSM_LABEL_BY_CHOICE: Record<PsmChoice, string> = {
  auto: 'Automático (padrão)',
  single_column: 'Coluna única (cupom estreito)',
  single_block: 'Bloco único de texto',
  sparse_text: 'Texto esparso (sem ordem)',
}

interface OcrState {
  status: 'idle' | 'running' | 'done' | 'error'
  text: string
  confidence: number | null
  progress: number
  elapsedMs: number | null
  error: string | null
  mode: 'original' | 'preprocessed' | null
  processedWidth: number | null
  processedHeight: number | null
}

interface PhotoPage {
  id: string
  file: File
  previewUrl: string
  quality: ImageQualityResult | 'loading' | null
  preprocessEnabled: boolean
  psm: PsmChoice
  ocr: OcrState
}

const idleOcr: OcrState = {
  status: 'idle', text: '', confidence: null, progress: 0, elapsedMs: null, error: null,
  mode: null, processedWidth: null, processedHeight: null,
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    // segue para o fallback abaixo
  }
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try { document.execCommand('copy') } catch { /* sem fallback disponível neste navegador */ }
  document.body.removeChild(textarea)
}

export function PurchasePhotoCapture() {
  const [pages, setPages] = useState<PhotoPage[]>([])
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  useEffect(() => () => {
    pagesRef.current.forEach((page) => URL.revokeObjectURL(page.previewUrl))
  }, [])

  const addFile = async (file: File) => {
    const id = crypto.randomUUID()
    const page: PhotoPage = {
      id, file, previewUrl: URL.createObjectURL(file), quality: 'loading',
      preprocessEnabled: true, psm: 'auto', ocr: idleOcr,
    }
    setPages((prev) => [...prev, page])
    try {
      const quality = await checkImageQuality(file)
      setPages((prev) => prev.map((item) => (item.id === id ? { ...item, quality } : item)))
    } catch {
      setPages((prev) => prev.map((item) => (item.id === id ? { ...item, quality: null } : item)))
    }
  }

  const replaceFile = async (id: string, file: File) => {
    setPages((prev) => prev.map((item) => {
      if (item.id !== id) return item
      URL.revokeObjectURL(item.previewUrl)
      return { ...item, file, previewUrl: URL.createObjectURL(file), quality: 'loading', ocr: idleOcr }
    }))
    // preprocessEnabled/psm sao mantidos como estavam: se o usuario ja ajustou
    // para calibrar, substituir a foto nao deveria resetar essa escolha.
    try {
      const quality = await checkImageQuality(file)
      setPages((prev) => prev.map((item) => (item.id === id ? { ...item, quality } : item)))
    } catch {
      setPages((prev) => prev.map((item) => (item.id === id ? { ...item, quality: null } : item)))
    }
  }

  const removePage = (id: string) => {
    setPages((prev) => {
      const target = prev.find((item) => item.id === id)
      if (target) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((item) => item.id !== id)
    })
  }

  const setPreprocessEnabled = (id: string, value: boolean) => {
    setPages((prev) => prev.map((item) => (item.id === id ? { ...item, preprocessEnabled: value } : item)))
  }

  const setPsm = (id: string, value: PsmChoice) => {
    setPages((prev) => prev.map((item) => (item.id === id ? { ...item, psm: value } : item)))
  }

  const runOcr = async (id: string) => {
    const page = pages.find((item) => item.id === id)
    if (!page || page.ocr.status === 'running') return
    setPages((prev) => prev.map((item) => (item.id === id ? { ...item, ocr: { ...idleOcr, status: 'running' } } : item)))
    const startedAt = Date.now()
    // O pre-processamento (ampliar/tons de cinza/contraste) roda so numa copia em
    // canvas usada apenas para o OCR — a miniatura (previewUrl) segue vindo sempre
    // do arquivo original, sem nenhuma alteracao.
    let processed: Awaited<ReturnType<typeof prepareImageForOcr>> | null = null
    if (page.preprocessEnabled) {
      try {
        processed = await prepareImageForOcr(page.file)
      } catch {
        processed = null // segue com a imagem original se o pre-processamento falhar
      }
    }
    type TesseractModule = typeof import('tesseract.js')
    let worker: Awaited<ReturnType<TesseractModule['createWorker']>> | null = null
    try {
      const Tesseract = await import('tesseract.js')
      worker = await Tesseract.createWorker('por', Tesseract.OEM.LSTM_ONLY, {
        logger: (message) => {
          if (message.status === 'recognizing text' && typeof message.progress === 'number') {
            setPages((prev) => prev.map((item) => (item.id === id ? { ...item, ocr: { ...item.ocr, progress: message.progress } } : item)))
          }
        },
      })
      await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM[PSM_KEY_BY_CHOICE[page.psm]] })
      const { data } = await worker.recognize(processed ? processed.canvas : page.file)
      const elapsedMs = Date.now() - startedAt
      setPages((prev) => prev.map((item) => (item.id === id ? {
        ...item,
        ocr: {
          status: 'done', text: data.text,
          confidence: typeof data.confidence === 'number' ? data.confidence : null,
          progress: 1, elapsedMs, error: null,
          mode: processed ? 'preprocessed' : 'original',
          processedWidth: processed ? processed.width : (item.quality && item.quality !== 'loading' ? item.quality.metrics.width : null),
          processedHeight: processed ? processed.height : (item.quality && item.quality !== 'loading' ? item.quality.metrics.height : null),
        },
      } : item)))
    } catch {
      const elapsedMs = Date.now() - startedAt
      setPages((prev) => prev.map((item) => (item.id === id ? {
        ...item,
        ocr: { ...idleOcr, status: 'error', elapsedMs, error: 'Não foi possível processar esta imagem localmente. Tente novamente ou use outra foto.' },
      } : item)))
    } finally {
      if (worker) await worker.terminate()
    }
  }

  const handleAddInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void addFile(file)
  }

  const handleReplaceInput = (event: ChangeEvent<HTMLInputElement>, id: string) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void replaceFile(id, file)
  }

  const handleCopy = async (page: PhotoPage) => {
    await copyText(page.ocr.text)
    setCopiedId(page.id)
    window.setTimeout(() => setCopiedId((current) => (current === page.id ? null : current)), 1800)
  }

  return <div className="market-ocr-poc">
    <div className="market-ocr-poc-privacy"><ShieldCheck size={16} /> Esta imagem é processada localmente neste dispositivo e não é enviada para nossos servidores.</div>
    <p className="market-ocr-poc-note">Teste (PoC) de leitura local de imagem por OCR. Nenhuma nota é importada e nenhum estoque é alterado aqui — é só para avaliar a qualidade do reconhecimento de texto.</p>

    <div className="market-ocr-poc-add-row">
      <label className="button button-outline market-ocr-poc-add-btn">
        <Camera size={16} /> Tirar foto
        <input type="file" accept="image/*" capture="environment" onChange={handleAddInput} />
      </label>
      <label className="button button-outline market-ocr-poc-add-btn">
        <ImagePlus size={16} /> Escolher da galeria/arquivo
        <input type="file" accept="image/*" onChange={handleAddInput} />
      </label>
    </div>

    {!pages.length && <p className="market-ocr-poc-empty">Nenhuma imagem adicionada ainda.</p>}

    <div className="market-ocr-poc-pages">
      {pages.map((page) => <article key={page.id} className="market-ocr-poc-page">
        <div className="market-ocr-poc-preview"><img src={page.previewUrl} alt="Pré-visualização da imagem selecionada" /></div>
        <div className="market-ocr-poc-page-body">
          <div className="market-ocr-poc-dims">
            {page.quality === 'loading'
              ? 'Analisando dimensões...'
              : page.quality
                ? `${page.quality.metrics.width} × ${page.quality.metrics.height} px`
                : 'Não foi possível ler as dimensões desta imagem.'}
          </div>

          {page.quality && page.quality !== 'loading' && page.quality.warnings.length > 0 && <ul className="market-ocr-poc-warnings">
            {page.quality.warnings.map((warning) => <li key={warning.code}><AlertTriangle size={14} /> {warning.message}</li>)}
          </ul>}

          <div className="market-ocr-poc-diagnostics">
            <label className="market-ocr-poc-checkbox">
              <input
                type="checkbox"
                checked={page.preprocessEnabled}
                disabled={page.ocr.status === 'running'}
                onChange={(event) => setPreprocessEnabled(page.id, event.target.checked)}
              />
              Aplicar pré-processamento (ampliar/tons de cinza/contraste)
            </label>
            <label className="market-ocr-poc-psm-select">
              Modo de segmentação (PSM)
              <select
                value={page.psm}
                disabled={page.ocr.status === 'running'}
                onChange={(event) => setPsm(page.id, event.target.value as PsmChoice)}
              >
                {(Object.keys(PSM_LABEL_BY_CHOICE) as PsmChoice[]).map((choice) => (
                  <option key={choice} value={choice}>{PSM_LABEL_BY_CHOICE[choice]}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="market-ocr-poc-page-actions">
            <label className="button button-small button-outline">
              <RefreshCw size={14} /> Substituir
              <input type="file" accept="image/*" onChange={(event) => handleReplaceInput(event, page.id)} />
            </label>
            <button type="button" className="button button-small button-outline" onClick={() => removePage(page.id)}><Trash2 size={14} /> Remover</button>
            <button type="button" className="button button-small" disabled={page.ocr.status === 'running'} onClick={() => void runOcr(page.id)}>
              {page.ocr.status === 'running' ? <><Loader2 size={14} className="market-ocr-poc-spin" /> Analisando...</> : 'Analisar imagem'}
            </button>
          </div>

          {page.ocr.status === 'running' && <div className="market-ocr-poc-progress"><div style={{ width: `${Math.round(page.ocr.progress * 100)}%` }} /></div>}

          {page.ocr.status === 'error' && <div className="admin-message is-error" role="alert">{page.ocr.error}</div>}

          {page.ocr.status === 'done' && <div className="market-ocr-poc-result">
            <div className="market-ocr-poc-result-meta">
              <span>{page.ocr.mode === 'preprocessed' ? 'OCR com pré-processamento' : 'OCR original'}</span>
              {page.ocr.processedWidth !== null && page.ocr.processedHeight !== null && (
                <span>Resolução usada: {page.ocr.processedWidth} × {page.ocr.processedHeight} px</span>
              )}
              <span>Tempo: {page.ocr.elapsedMs !== null ? `${(page.ocr.elapsedMs / 1000).toFixed(1)}s` : '-'}</span>
              {page.ocr.confidence !== null && <span>Confiança média (Tesseract): {Math.round(page.ocr.confidence)}%</span>}
            </div>
            <pre className="market-ocr-poc-text">{page.ocr.text || '(nenhum texto reconhecido)'}</pre>
            <button type="button" className="button button-small button-outline" onClick={() => void handleCopy(page)}>
              <Copy size={14} /> {copiedId === page.id ? 'Copiado!' : 'Copiar texto'}
            </button>
          </div>}
        </div>
      </article>)}
    </div>
  </div>
}
