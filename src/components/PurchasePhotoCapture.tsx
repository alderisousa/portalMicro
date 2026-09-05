import { AlertTriangle, Camera, Copy, ImagePlus, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { checkImageQuality, type ImageQualityResult } from '../utils/imageQualityCheck'
import { prepareImageForOcr } from '../utils/imagePreprocess'
import { extractPurchaseOcrDocument } from '../utils/purchaseOcrExtraction'
import type { PurchaseOcrDocument } from '../types/purchaseOcr'
import { PurchaseOcrReview } from './PurchaseOcrReview'

// PoC (checkpoint 5D.1/5D.1.1/5D.2/5D.2.2): leitura local de FOTO/IMAGEM via
// Tesseract.js + extracao de dados estruturados + validacao/revisao. A entrada de
// PDF tem tela propria (PurchasePdfCapture) desde a Sprint 5D.2.2, selecionada
// separadamente no formato de entrada da tela de Compras — nao mistura mais as
// duas fontes na mesma UI. Nao envia a imagem a lugar nenhum, nao grava em
// market_purchases/market_purchase_items e nao toca na conciliacao real. O modelo
// em lista (varias "paginas") existe so para nao travar uma evolucao futura para
// 1..N imagens; cada pagina e analisada e revisada isoladamente, sem nenhuma
// consolidacao entre paginas neste checkpoint.

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
  status: 'idle' | 'preparing' | 'running' | 'done' | 'error'
  text: string
  confidence: number | null
  progress: number
  elapsedMs: number | null
  error: string | null
  mode: 'original' | 'preprocessed' | null
  processedWidth: number | null
  processedHeight: number | null
  document: PurchaseOcrDocument | null
  // Diagnostico de memoria/desempenho (Sprint 5D.2.2) — ajuda a calibrar os
  // limites de resolucao de trabalho durante os testes em celular real.
  fileSizeBytes: number | null
  prepMs: number | null
  // Incrementado a cada execucao — usado so como "key" para remontar a tela de
  // revisao do zero (descartando edicoes antigas) quando o usuario reanalisa a
  // mesma pagina com outro PSM/pre-processamento.
  runId: number
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
  mode: null, processedWidth: null, processedHeight: null, document: null,
  fileSizeBytes: null, prepMs: null, runId: 0,
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
  // Trava global (nao por pagina): impede iniciar um segundo worker Tesseract
  // enquanto outro ainda roda — mobile com pouca memoria nao deve processar
  // varias fotos/paginas em paralelo (Sprint 5D.2.2, parte C4).
  const [ocrBusy, setOcrBusy] = useState(false)
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
    if (!page || ocrBusy) return
    setOcrBusy(true)
    const nextRunId = page.ocr.runId + 1
    setPages((prev) => prev.map((item) => (item.id === id ? {
      ...item,
      ocr: { ...idleOcr, status: 'preparing', fileSizeBytes: item.file.size, runId: nextRunId },
    } : item)))
    const startedAt = Date.now()
    // O pre-processamento (ampliar/tons de cinza/contraste) roda so numa copia em
    // canvas usada apenas para o OCR — a miniatura (previewUrl) segue vindo sempre
    // do arquivo original, sem nenhuma alteracao. "preparing" e um estado proprio
    // (distinto de "running") para nao dar a impressao de trava/falta de memoria
    // durante essa etapa em fotos grandes.
    let processed: Awaited<ReturnType<typeof prepareImageForOcr>> | null = null
    let prepError: string | null = null
    if (page.preprocessEnabled) {
      try {
        processed = await prepareImageForOcr(page.file)
      } catch {
        prepError = 'Não foi possível preparar esta imagem para leitura (etapa de redimensionamento). Tente novamente ou escolha outra foto.'
      }
    }
    const prepMs = Date.now() - startedAt
    if (prepError) {
      setPages((prev) => prev.map((item) => (item.id === id ? {
        ...item, ocr: { ...idleOcr, status: 'error', error: prepError, fileSizeBytes: item.file.size, prepMs, runId: nextRunId },
      } : item)))
      setOcrBusy(false)
      return
    }
    setPages((prev) => prev.map((item) => (item.id === id ? { ...item, ocr: { ...item.ocr, status: 'running', prepMs } } : item)))

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
      // blocks:true pede ao Tesseract os dados posicionais (words/lines/bbox/
      // confianca individual) usados pela extracao estruturada — sem isso so
      // teriamos o texto corrido, que a Sprint 5D.2 pediu para nao depender.
      const { data } = await worker.recognize(processed ? processed.canvas : page.file, {}, { text: true, blocks: true })
      const elapsedMs = Date.now() - startedAt
      const structuredDocument = extractPurchaseOcrDocument(data.blocks)
      setPages((prev) => prev.map((item) => (item.id === id ? {
        ...item,
        ocr: {
          status: 'done', text: data.text,
          confidence: typeof data.confidence === 'number' ? data.confidence : null,
          progress: 1, elapsedMs, error: null,
          mode: processed ? 'preprocessed' : 'original',
          processedWidth: processed ? processed.width : (item.quality && item.quality !== 'loading' ? item.quality.metrics.width : null),
          processedHeight: processed ? processed.height : (item.quality && item.quality !== 'loading' ? item.quality.metrics.height : null),
          document: structuredDocument, fileSizeBytes: item.file.size, prepMs, runId: nextRunId,
        },
      } : item)))
    } catch {
      const elapsedMs = Date.now() - startedAt
      setPages((prev) => prev.map((item) => (item.id === id ? {
        ...item,
        ocr: { ...idleOcr, status: 'error', elapsedMs, prepMs, fileSizeBytes: item.file.size, error: 'Não foi possível processar esta imagem localmente. Tente novamente ou use outra foto.', runId: nextRunId },
      } : item)))
    } finally {
      if (worker) await worker.terminate()
      // O canvas pre-processado so era necessario para o Tesseract acima; libera
      // o backing store imediatamente (celular com pouca memoria nao deve manter
      // esse buffer vivo esperando o coletor de lixo).
      if (processed) { processed.canvas.width = 0; processed.canvas.height = 0 }
      setOcrBusy(false)
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
    <p className="market-ocr-poc-note">Teste (PoC) de leitura local por OCR de imagem, com revisão dos dados extraídos. Nenhuma nota é importada, nenhum item é gravado e nenhum estoque é alterado aqui — é só para validar a leitura antes de decidirmos levar isso ao fluxo real de compras.</p>

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
                disabled={ocrBusy}
                onChange={(event) => setPreprocessEnabled(page.id, event.target.checked)}
              />
              Aplicar pré-processamento (ampliar/tons de cinza/contraste)
            </label>
            <label className="market-ocr-poc-psm-select">
              Modo de segmentação (PSM)
              <select
                value={page.psm}
                disabled={ocrBusy}
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
            <button type="button" className="button button-small" disabled={ocrBusy} onClick={() => void runOcr(page.id)}>
              {page.ocr.status === 'preparing' ? <><Loader2 size={14} className="market-ocr-poc-spin" /> Preparando imagem...</>
                : page.ocr.status === 'running' ? <><Loader2 size={14} className="market-ocr-poc-spin" /> Analisando documento...</>
                : 'Analisar documento'}
            </button>
          </div>

          {(page.ocr.status === 'preparing' || page.ocr.status === 'running') && <div className="market-ocr-poc-progress"><div style={{ width: `${Math.round(page.ocr.progress * 100)}%` }} /></div>}

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
            <details className="market-ocr-poc-raw-details">
              <summary>Diagnóstico técnico (texto bruto, memória e tempos)</summary>
              <p className="market-ocr-pdf-diagnostic-meta">
                {page.quality && page.quality !== 'loading' && `Resolução original: ${page.quality.metrics.width} × ${page.quality.metrics.height} px · `}
                {page.ocr.fileSizeBytes !== null && `Arquivo: ${(page.ocr.fileSizeBytes / (1024 * 1024)).toFixed(2)} MB · `}
                {page.ocr.prepMs !== null && `Preparação: ${(page.ocr.prepMs / 1000).toFixed(1)}s · `}
                {page.ocr.elapsedMs !== null && page.ocr.prepMs !== null && `OCR: ${((page.ocr.elapsedMs - page.ocr.prepMs) / 1000).toFixed(1)}s`}
              </p>
              <pre className="market-ocr-poc-text">{page.ocr.text || '(nenhum texto reconhecido)'}</pre>
              <button type="button" className="button button-small button-outline" onClick={() => void handleCopy(page)}>
                <Copy size={14} /> {copiedId === page.id ? 'Copiado!' : 'Copiar texto'}
              </button>
            </details>
            {page.ocr.document && <PurchaseOcrReview
              key={`review-${page.id}-${page.ocr.runId}`}
              document={page.ocr.document}
              origin="Foto / imagem — OCR local"
              ocrConfidence={page.ocr.confidence}
              imageQualityWarningsCount={page.quality && page.quality !== 'loading' ? page.quality.warnings.length : 0}
            />}
          </div>}
        </div>
      </article>)}
    </div>
  </div>
}
