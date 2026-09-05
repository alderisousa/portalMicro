import { FileText, Loader2, ScanText, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import type { PurchaseOcrDocument } from '../types/purchaseOcr'
import { processPdfFile, type PdfPageSource } from '../utils/pdfDocumentProcessing'
import { PurchaseOcrReview } from './PurchaseOcrReview'

// Entrada de PDF (Sprint 5D.2.1/5D.2.2) para o mesmo fluxo de OCR/revisao da
// 5D.2. Cada pagina do PDF vira um cartao independente (numero, texto, resultado
// e origem preservados por pagina — ver processPdfFile), reaproveitando o MESMO
// PurchaseOcrDocument/PurchaseOcrReview/validacao matematica das fotos. Nao envia
// o arquivo a lugar nenhum, nao grava em market_purchases/conciliacao.
interface PdfPage {
  id: string
  pdfFileName: string
  pageNumber: number
  pageCount: number
  status: 'done' | 'error'
  error: string | null
  source: PdfPageSource | null
  rawText: string
  document: PurchaseOcrDocument | null
  // Sempre um blob: URL (Sprint 5D.2.2 — antes era data:/base64 guardado direto no
  // state, o que a propria checklist de memoria pediu para evitar). Precisa de
  // URL.revokeObjectURL ao remover a pagina/desmontar (ver useEffect abaixo).
  previewUrl: string | null
  ocrConfidence: number | null
  elapsedMs: number | null
  pageWidthPt: number | null
  pageHeightPt: number | null
  renderedWidth: number | null
  renderedHeight: number | null
}

const ORIGIN_LABEL: Record<PdfPageSource, string> = {
  pdf_text: 'PDF — texto extraído localmente',
  pdf_scanned_ocr: 'PDF escaneado — OCR local',
}

export function PurchasePdfCapture() {
  const [pages, setPages] = useState<PdfPage[]>([])
  const [processingFileName, setProcessingFileName] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)
  const pagesRef = useRef(pages)
  pagesRef.current = pages

  useEffect(() => () => {
    pagesRef.current.forEach((page) => { if (page.previewUrl) URL.revokeObjectURL(page.previewUrl) })
  }, [])

  const handlePdfInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || processingFileName) return
    setGlobalError(null)
    setProcessingFileName(file.name)
    try {
      await processPdfFile(
        file,
        (result) => {
          setPages((prev) => [...prev, {
            id: crypto.randomUUID(), pdfFileName: file.name, pageNumber: result.pageNumber, pageCount: result.pageCount,
            status: 'done', error: null, source: result.source, rawText: result.rawText, document: result.document,
            previewUrl: result.previewUrl, ocrConfidence: result.ocrConfidence, elapsedMs: result.elapsedMs,
            pageWidthPt: result.pageWidthPt, pageHeightPt: result.pageHeightPt,
            renderedWidth: result.renderedWidth, renderedHeight: result.renderedHeight,
          }])
        },
        (pageNumber, message) => {
          setPages((prev) => [...prev, {
            id: crypto.randomUUID(), pdfFileName: file.name, pageNumber, pageCount: 0,
            status: 'error', error: message, source: null, rawText: '', document: null,
            previewUrl: null, ocrConfidence: null, elapsedMs: null,
            pageWidthPt: null, pageHeightPt: null, renderedWidth: null, renderedHeight: null,
          }])
        },
      )
    } catch {
      setGlobalError('Não foi possível abrir este PDF. Verifique se o arquivo não está corrompido ou protegido por senha.')
    } finally {
      setProcessingFileName(null)
    }
  }

  const removePage = (id: string) => {
    setPages((prev) => {
      const target = prev.find((page) => page.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((page) => page.id !== id)
    })
  }

  return <div className="market-ocr-pdf">
    <div className="market-ocr-pdf-add-row">
      <label className={`button button-outline market-ocr-pdf-add-btn${processingFileName ? ' is-disabled' : ''}`}>
        <FileText size={16} /> Selecionar PDF
        <input type="file" accept="application/pdf" disabled={!!processingFileName} onChange={(event) => void handlePdfInput(event)} />
      </label>
      {processingFileName && <span className="market-ocr-pdf-processing"><Loader2 size={14} className="market-ocr-poc-spin" /> Processando {processingFileName}...</span>}
    </div>

    {globalError && <div className="admin-message is-error" role="alert">{globalError}</div>}

    <div className="market-ocr-pdf-pages">
      {pages.map((page) => <article key={page.id} className="market-ocr-pdf-page">
        <div className="market-ocr-pdf-page-head">
          <div className="market-ocr-pdf-page-title">
            <ScanText size={16} />
            <span>{page.pdfFileName} — página {page.pageNumber}{page.pageCount ? ` de ${page.pageCount}` : ''}</span>
          </div>
          <button type="button" className="button button-small button-outline" onClick={() => removePage(page.id)}><Trash2 size={14} /> Remover</button>
        </div>

        {page.status === 'error' && <div className="admin-message is-error" role="alert">{page.error}</div>}

        {page.status === 'done' && <div className="market-ocr-pdf-page-body">
          {page.previewUrl && <div className="market-ocr-pdf-preview"><img src={page.previewUrl} alt={`Prévia da página ${page.pageNumber} do PDF`} /></div>}
          <details className="market-ocr-poc-raw-details">
            <summary>Diagnóstico técnico (texto bruto, memória e tempos)</summary>
            <p className="market-ocr-pdf-diagnostic-meta">
              {page.source && ORIGIN_LABEL[page.source]}
              {page.pageWidthPt !== null && page.pageHeightPt !== null && ` · Página PDF: ${Math.round(page.pageWidthPt)} × ${Math.round(page.pageHeightPt)} pt`}
              {page.renderedWidth !== null && page.renderedHeight !== null && ` · Resolução de trabalho: ${page.renderedWidth} × ${page.renderedHeight} px`}
              {page.elapsedMs !== null && ` · Tempo: ${(page.elapsedMs / 1000).toFixed(1)}s`}
              {page.ocrConfidence !== null && ` · Confiança OCR: ${Math.round(page.ocrConfidence)}%`}
            </p>
            <pre className="market-ocr-poc-text">{page.rawText || '(nenhum texto encontrado)'}</pre>
          </details>
          {page.document && page.source && <PurchaseOcrReview
            key={`pdf-review-${page.id}`}
            document={page.document}
            origin={ORIGIN_LABEL[page.source]}
            ocrConfidence={page.ocrConfidence}
            confidenceApplicable={page.source === 'pdf_scanned_ocr'}
            imageQualityWarningsCount={0}
          />}
        </div>}
      </article>)}
    </div>
  </div>
}
