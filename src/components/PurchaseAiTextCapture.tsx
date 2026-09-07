import { ClipboardCopy, FileJson } from 'lucide-react'
import { useId, useState } from 'react'
import { PURCHASE_AI_TEXT_PROMPT } from '../constants/purchaseAiTextPrompt'
import { aiTextStagingDocument, parseAiTextResponse } from '../utils/purchaseAiTextParser'
import { sha256Hex } from '../utils/textHash'
import { PurchaseStagingReview, type PurchaseStagingDocument } from './PurchaseStagingReview'

// Texto IA: mais uma origem para o MESMO staging de PDF/NFC-e — o operador
// extrai o documento com uma IA externa (fora deste app, sem chave de API
// aqui) e cola a resposta em formato JSON. Nunca conciliação/match/estoque:
// só transforma texto em dados estruturados para a revisão humana já existente.
export function PurchaseAiTextCapture({ accountId, destinationStoreId, onImported }: {
  accountId: string; destinationStoreId: string; onImported: (id: string) => void;
}) {
  const responseFieldId = useId()
  const [promptExpanded, setPromptExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [rawText, setRawText] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [validated, setValidated] = useState<{ reference: string; original: PurchaseStagingDocument; warnings: string[] } | null>(null)

  const copyPrompt = async () => {
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(PURCHASE_AI_TEXT_PROMPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      setCopyError('Não foi possível copiar automaticamente. Use "Ver prompt" e copie manualmente.')
    }
  }

  const validate = async () => {
    setValidationError(null)
    const result = parseAiTextResponse(rawText)
    if (!result.ok) { setValidationError(result.error); return }
    // Referência estável: hash do JSON já normalizado pela validação (mesmo
    // conteúdo semântico -> mesmo hash, mesmo colado com formatação/espaços
    // diferentes), NUNCA do rascunho que o operador ainda vai corrigir na
    // revisão — senão a mesma origem poderia virar registros diferentes.
    const reference = `ai_text:${await sha256Hex(JSON.stringify(result.data))}`
    setValidated({ reference, original: aiTextStagingDocument(result.data), warnings: result.data.warnings })
  }

  const reset = () => { setValidated(null); setRawText(''); setValidationError(null) }

  if (validated) {
    return <div className="market-ai-text">
      <button type="button" className="button button-small button-outline" onClick={reset}>‹ Colar outro texto</button>
      <PurchaseStagingReview
        original={validated.original} accountId={accountId} destinationStoreId={destinationStoreId}
        reference={validated.reference} sourceType="ai_text" warnings={validated.warnings}
        onImported={(id) => { reset(); onImported(id) }}
      />
    </div>
  }

  return <div className="market-ai-text">
    <h3>Texto IA</h3>
    <p>Use esta opção quando o documento não puder ser processado corretamente por QR Code ou PDF. Copie o prompt, envie para uma IA (ChatGPT, Claude, etc.) junto com o documento e depois cole aqui a resposta.</p>
    <div className="market-ai-text-prompt-actions">
      <button type="button" className="button button-outline" onClick={() => void copyPrompt()}>
        <ClipboardCopy size={16} /> Copiar prompt para IA
      </button>
      <button type="button" className="button button-outline" onClick={() => setPromptExpanded((prev) => !prev)}>
        {promptExpanded ? 'Ocultar prompt' : 'Ver prompt'}
      </button>
      {copied && <span className="market-ai-text-copied" role="status">Prompt copiado</span>}
    </div>
    {copyError && <p role="alert">{copyError}</p>}
    {promptExpanded && <details className="market-ocr-poc-raw-details" open>
      <summary>Prompt completo</summary>
      <pre className="market-ocr-poc-text">{PURCHASE_AI_TEXT_PROMPT}</pre>
    </details>}

    <div className="market-ai-text-response">
      <h4><FileJson size={15} /> Resposta da IA</h4>
      <label htmlFor={responseFieldId}>Cole aqui o JSON retornado pela IA</label>
      <textarea id={responseFieldId} rows={10} value={rawText} onChange={(event) => { setRawText(event.target.value); setValidationError(null) }}
        placeholder="Cole aqui o JSON retornado pela IA" />
      {validationError && <p role="alert">{validationError}</p>}
      <button type="button" className="button" disabled={!rawText.trim()} onClick={() => void validate()}>Validar e revisar</button>
    </div>
  </div>
}
