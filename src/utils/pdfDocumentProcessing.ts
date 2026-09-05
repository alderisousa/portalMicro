import type { PurchaseOcrDocument } from '../types/purchaseOcr'
import { computeWorkingImageScale } from './ocrImageLimits'
import {
  extractPurchaseOcrDocument, extractPurchaseOcrDocumentFromPdfTextItems, type PdfTextItemLike,
} from './purchaseOcrExtraction'

// Processamento de PDF 100% local (Sprint 5D.2.1/5D.2.2) — pdfjs-dist so e
// importado dinamicamente aqui (mesmo padrao ja usado para tesseract.js/
// @zxing/browser), entao ele nao entra no bundle inicial da tela de Compras.
//
// Estrategia em cascata por pagina:
// 1) Tenta a camada de texto do proprio PDF (getTextContent) — rapido, sem OCR.
// 2) Se a pagina nao tiver texto util (PDF escaneado), renderiza a pagina como
//    imagem e roda o MESMO pipeline Tesseract/parser ja usado para fotos.
// Em ambos os casos o resultado alimenta extractPurchaseOcrDocument(FromLines) —
// nenhuma regra de cabecalho/item e duplicada entre as origens.
//
// Paginas sao processadas SEQUENCIALMENTE (um for..await, nunca Promise.all) —
// nunca mais de um worker Tesseract nem mais de um canvas de pagina grande vivo
// ao mesmo tempo (Sprint 5D.2.2, parte C4/C5 — mesmo risco de memoria das fotos).

const MIN_TEXT_LAYER_CHARS = 20

type PdfJsModule = typeof import('pdfjs-dist')
type PdfDocumentProxy = Awaited<ReturnType<PdfJsModule['getDocument']>['promise']>
type PdfPageProxy = Awaited<ReturnType<PdfDocumentProxy['getPage']>>
// getTextContent() mistura TextItem (tem "str") e TextMarkedContent (nao tem) no
// mesmo array — este alias existe so para permitir o type guard abaixo sem
// depender de um import de tipo do caminho interno do pdfjs-dist.
type PdfTextContentItem = Awaited<ReturnType<PdfPageProxy['getTextContent']>>['items'][number]

let pdfWorkerConfigured = false

async function loadPdfJs() {
  const pdfjsLib = await import('pdfjs-dist')
  if (!pdfWorkerConfigured) {
    // Vite empacota o worker como asset estatico a partir deste padrao "new URL"
    // — o worker roda em thread separada, sem bloquear a UI durante o parse do PDF.
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href
    pdfWorkerConfigured = true
  }
  return pdfjsLib
}

export type PdfPageSource = 'pdf_text' | 'pdf_scanned_ocr'

export interface PdfPageResult {
  pageNumber: number
  pageCount: number
  source: PdfPageSource
  rawText: string
  document: PurchaseOcrDocument
  // Sempre um blob: URL (nunca data:/base64 em memoria de state) — ver nota em
  // PurchasePdfCapture.tsx sobre por que isso importa para memoria no mobile.
  previewUrl: string | null
  ocrConfidence: number | null
  elapsedMs: number
  // Diagnostico (Sprint 5D.2.2, parte C6): ajuda a calibrar a escala de render.
  pageWidthPt: number
  pageHeightPt: number
  renderedWidth: number
  renderedHeight: number
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
}

// Renderiza a pagina num canvas — usado tanto para a miniatura de preview quanto,
// quando necessario, como entrada do fallback de OCR (evita renderizar duas
// vezes). A escala e calculada a partir do tamanho REAL da pagina em pontos
// (getViewport({scale:1})) usando o MESMO envelope de resolucao de trabalho das
// fotos (ocrImageLimits.ts) — um PDF de scan em alta resolucao pode declarar uma
// pagina enorme, e renderizar isso sem limite tem o mesmo risco de memoria que
// uma foto de camera nao redimensionada.
async function renderPageToCanvas(page: PdfPageProxy) {
  const baseViewport = page.getViewport({ scale: 1 })
  const scale = computeWorkingImageScale(baseViewport.width, baseViewport.height)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D não suportado neste navegador.')
  await page.render({ canvas, canvasContext: context, viewport }).promise
  return { canvas, pageWidthPt: baseViewport.width, pageHeightPt: baseViewport.height }
}

export async function processPdfFile(
  file: File,
  onPageReady: (result: PdfPageResult) => void,
  onPageError: (pageNumber: number, message: string) => void,
): Promise<number> {
  const pdfjsLib = await loadPdfJs()
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
  const pageCount = pdf.numPages

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const startedAt = Date.now()
    let canvas: HTMLCanvasElement | null = null
    try {
      const page = await pdf.getPage(pageNumber)
      const textContent = await page.getTextContent()
      const textItems = textContent.items.filter(
        (item): item is Extract<PdfTextContentItem, { str: string }> => 'str' in item,
      )
      const rawText = textItems.map((item) => item.str).join(' ').trim()
      const hasTextLayer = rawText.replace(/\s+/g, '').length >= MIN_TEXT_LAYER_CHARS

      const rendered = await renderPageToCanvas(page)
      canvas = rendered.canvas
      const previewBlob = await canvasToBlob(canvas)
      const previewUrl = previewBlob ? URL.createObjectURL(previewBlob) : null
      const diagnostics = {
        pageWidthPt: rendered.pageWidthPt, pageHeightPt: rendered.pageHeightPt,
        renderedWidth: canvas.width, renderedHeight: canvas.height,
      }

      if (hasTextLayer) {
        onPageReady({
          pageNumber, pageCount, source: 'pdf_text', rawText,
          // Parser espacial por regioes/colunas (Sprint 5D.2.2) — nao o generico
          // por linhas usado para OCR de imagem (ver purchaseOcrExtraction.ts).
          document: extractPurchaseOcrDocumentFromPdfTextItems(textItems),
          previewUrl, ocrConfidence: null, elapsedMs: Date.now() - startedAt, ...diagnostics,
        })
        continue
      }

      // PDF escaneado (sem texto util): reaproveita o mesmo pipeline Tesseract do
      // checkpoint 5D.1/5D.2 sobre a pagina ja renderizada acima (ja no envelope
      // de resolucao de trabalho, nao no tamanho nativo do PDF).
      type TesseractModule = typeof import('tesseract.js')
      let worker: Awaited<ReturnType<TesseractModule['createWorker']>> | null = null
      try {
        const Tesseract = await import('tesseract.js')
        worker = await Tesseract.createWorker('por', Tesseract.OEM.LSTM_ONLY)
        await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.AUTO })
        const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true })
        onPageReady({
          pageNumber, pageCount, source: 'pdf_scanned_ocr', rawText: data.text,
          document: extractPurchaseOcrDocument(data.blocks), previewUrl,
          ocrConfidence: typeof data.confidence === 'number' ? data.confidence : null,
          elapsedMs: Date.now() - startedAt, ...diagnostics,
        })
      } finally {
        if (worker) await worker.terminate()
      }
    } catch {
      onPageError(pageNumber, `Não foi possível processar a página ${pageNumber} deste PDF. Tente novamente ou verifique o arquivo.`)
    } finally {
      // O canvas so era necessario para gerar a miniatura/alimentar o OCR acima;
      // libera o backing store imediatamente antes de seguir para a proxima
      // pagina (nunca mais de um canvas de pagina grande vivo por vez).
      if (canvas) { canvas.width = 0; canvas.height = 0 }
    }
  }

  return pageCount
}
