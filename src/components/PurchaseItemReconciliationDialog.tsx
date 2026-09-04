import { HelpCircle, ScanBarcode, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { BarcodeScanner } from './BarcodeScanner'
import {
  confirmPurchaseItemReconciliation, detectPossiblePackaging, searchCatalogProducts,
  searchProductsByEan, searchReconciliationCandidates, ReconciliationError,
} from '../services/marketReconciliation'
import { analyzeBarcode } from '../utils/marketSalesImportParser'
import type { CatalogSearchResult, ReconciliationCandidate } from '../types/marketReconciliation'
import type { MarketPurchaseItem } from '../types/marketPurchases'

const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })

// Rotulos alinhados com o texto de ajuda ("Entenda as sugestões") - manter os
// dois em sincronia se um mudar.
const matchReasonLabels: Record<string, string> = {
  ean_exact: 'EAN exato', supplier_mapping: 'Correspondência salva', sku_match: 'Código igual',
  presentation_match: 'Peso/volume compatível', description_match: 'Descrição semelhante',
}

const formatProductMeta = (product: { ean: string | null; externalProductId: string | null; unit: string }) =>
  `${product.ean ? `EAN ${product.ean}` : 'Sem EAN'} · ${product.externalProductId ? `Accesys ${product.externalProductId}` : 'Sem código Accesys'} · ${product.unit}`

interface SelectedProduct { productId: string; name: string; ean: string | null; externalProductId: string | null; unit: string; foundByEan?: boolean }

interface Props {
  accountId: string
  item: MarketPurchaseItem
  onCancel: () => void
  onConfirmed: () => void
}

export function PurchaseItemReconciliationDialog({ accountId, item, onCancel, onConfirmed }: Props) {
  const titleId = useId()
  const cancelButton = useRef<HTMLButtonElement>(null)
  const processingRef = useRef(false)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  const [candidates, setCandidates] = useState<ReconciliationCandidate[] | null>(null)
  const [candidatesError, setCandidatesError] = useState(false)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<CatalogSearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<SelectedProduct | null>(null)
  const [saveMapping, setSaveMapping] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scannerOpen, setScannerOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [scanMessage, setScanMessage] = useState<string | null>(null)
  const [scanResults, setScanResults] = useState<CatalogSearchResult[]>([])
  const [helpOpen, setHelpOpen] = useState(false)
  const helpOpenRef = useRef(false)

  const packaging = detectPossiblePackaging(item.descriptionRaw)

  useEffect(() => {
    let cancelled = false
    setCandidates(null); setCandidatesError(false)
    searchReconciliationCandidates(accountId, item.id).then((result) => {
      if (!cancelled) setCandidates(result)
    }).catch(() => { if (!cancelled) setCandidatesError(true) })
    return () => { cancelled = true }
  }, [accountId, item.id])

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length < 2) { setSearchResults([]); setSearching(false); return }
    setSearching(true)
    const timeout = setTimeout(() => {
      searchCatalogProducts(accountId, trimmed).then(setSearchResults).catch(() => setSearchResults([])).finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(timeout)
  }, [accountId, query])

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    cancelButton.current?.focus()
    // Esc fecha a ajuda primeiro, se estiver aberta - so um listener no
    // document (a ajuda nao tem o proprio), para nao fechar os dois juntos.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || processingRef.current) return
      event.preventDefault()
      if (helpOpenRef.current) { setHelpOpen(false); return }
      onCancelRef.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => { document.removeEventListener('keydown', handleKeyDown); previouslyFocused?.focus() }
  }, [])

  processingRef.current = confirming
  helpOpenRef.current = helpOpen

  const confirm = async () => {
    if (!selected) return
    setConfirming(true); setError(null)
    try {
      await confirmPurchaseItemReconciliation(accountId, item.id, selected.productId, saveMapping)
      onConfirmed()
    } catch (cause) {
      setError(cause instanceof ReconciliationError ? cause.message : 'Não foi possível concluir a conciliação.')
    } finally { setConfirming(false) }
  }

  // O EAN lido pela camera e so evidencia operacional para escolher o produto -
  // nunca e gravado no item fiscal, e a conciliacao so acontece com acao final
  // do usuario em "Confirmar conciliação".
  const handleScanned = async (code: string) => {
    setScannerOpen(false); setScanMessage(null); setScanResults([])
    const { normalized, status } = analyzeBarcode(code)
    if (status !== 'valid' || !normalized) {
      setScanMessage('Código de barras inválido.')
      return
    }
    setScanning(true)
    try {
      const results = await searchProductsByEan(accountId, normalized)
      if (results.length === 0) {
        setScanMessage('EAN não localizado no catálogo sincronizado.')
      } else if (results.length === 1) {
        setSelected({ ...results[0], foundByEan: true })
      } else {
        setScanMessage(`${results.length} produtos encontrados com este EAN — escolha um:`)
        setScanResults(results)
      }
    } catch (cause) {
      setScanMessage(cause instanceof ReconciliationError ? cause.message : 'Não foi possível consultar este EAN agora.')
    } finally { setScanning(false) }
  }

  return (
    <div className="confirm-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !confirming) onCancel() }}>
      <div className="market-reconcile-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="market-reconcile-dialog-header">
          <div>
            <span className="panel-kicker">CONCILIAR ITEM</span>
            <h2 id={titleId}>Linha {item.lineNumber}</h2>
          </div>
          <button
            type="button"
            className="market-reconcile-help-button"
            onClick={() => setHelpOpen(true)}
            aria-label="Como funciona a conciliação"
          >
            <HelpCircle size={20} />
          </button>
        </header>

        <div className="market-reconcile-dialog-body">
          <section className="market-reconcile-side market-reconcile-fiscal">
            <h3>Dados fiscais</h3>
            <dl>
              <div><dt>Descrição</dt><dd>{item.descriptionRaw || '-'}</dd></div>
              <div><dt>Código do fornecedor</dt><dd>{item.supplierProductCode || '-'}</dd></div>
              <div><dt>Quantidade</dt><dd>{quantityFormat.format(item.quantity)}</dd></div>
              <div><dt>Unidade</dt><dd>{item.unit || '-'}</dd></div>
              <div><dt>EAN</dt><dd>{item.barcodeNormalized || '-'}</dd></div>
            </dl>
            {packaging && <p className="market-reconcile-packaging-hint">Possível embalagem detectada: {packaging.quantity} {packaging.unit}</p>}
          </section>

          <section className="market-reconcile-side market-reconcile-catalog">
            <h3>Catálogo sincronizado</h3>

            {selected ? (
              <div className="market-reconcile-selected">
                <div>
                  <strong>{selected.name}</strong>
                  <span>{formatProductMeta(selected)}</span>
                  {selected.foundByEan && <span className="market-reconcile-reason-tag">Localizado por EAN</span>}
                </div>
                <button type="button" className="button button-small button-outline" onClick={() => setSelected(null)} disabled={confirming}>Trocar</button>
              </div>
            ) : (
              <>
                <div className="market-reconcile-search-row">
                  <input
                    className="market-reconcile-search-input"
                    placeholder="Buscar por EAN, SKU ou descrição"
                    value={query}
                    onChange={(event) => { setQuery(event.target.value); setScanMessage(null); setScanResults([]) }}
                  />
                  <button type="button" className="button button-small button-outline" onClick={() => { setScannerOpen(true); setScanMessage(null); setScanResults([]) }} disabled={confirming || scanning}>
                    <ScanBarcode size={15} /> Ler código de barras
                  </button>
                </div>
                <p className="market-reconcile-hint">Escolha o produto correspondente ao item da nota. Em caso de dúvida, use o código de barras.</p>

                {scanning && <p className="market-reconcile-status-text">Consultando EAN...</p>}
                {scanMessage && <p className="market-reconcile-status-text">{scanMessage}</p>}
                {scanResults.length > 0 && (
                  <ul className="market-reconcile-results">
                    {scanResults.map((result) => (
                      <li key={result.productId}>
                        <button type="button" onClick={() => setSelected({ ...result, foundByEan: true })}>
                          <strong>{result.name}</strong>
                          <span>{formatProductMeta(result)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {searching && <p className="market-reconcile-status-text">Buscando...</p>}
                {searchResults.length > 0 && (
                  <ul className="market-reconcile-results">
                    {searchResults.map((result) => (
                      <li key={result.productId}>
                        <button type="button" onClick={() => setSelected(result)}>
                          <strong>{result.name}</strong>
                          <span>{formatProductMeta(result)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {!query.trim() && (
                  <>
                    <h4 className="market-reconcile-suggestions-title">Sugestões</h4>
                    {candidates === null && !candidatesError && <p className="market-reconcile-status-text">Buscando sugestões...</p>}
                    {candidatesError && <p className="market-reconcile-status-text">Não foi possível carregar sugestões agora. Use a busca acima.</p>}
                    {candidates !== null && candidates.length === 0 && !candidatesError && (
                      <p className="market-reconcile-status-text">
                        Produto não encontrado no catálogo sincronizado.<br />
                        Sincronize os produtos, corrija o produto no sistema da franquia, ou reprocesse os pendentes depois.
                      </p>
                    )}
                    {candidates !== null && candidates.length > 0 && (
                      <ul className="market-reconcile-results market-reconcile-candidates">
                        {candidates.map((candidate) => (
                          <li key={candidate.productId}>
                            <button type="button" onClick={() => setSelected(candidate)}>
                              <strong>{candidate.name}</strong>
                              <span>{formatProductMeta(candidate)}</span>
                              <span className="market-reconcile-reasons">
                                {candidate.matchReasons.map((reason) => (
                                  <span key={reason} className="market-reconcile-reason-tag">{matchReasonLabels[reason] ?? reason}</span>
                                ))}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </div>

        {selected && item.supplierProductCode && (
          <label className="market-reconcile-mapping-checkbox">
            <input type="checkbox" checked={saveMapping} onChange={(event) => setSaveMapping(event.target.checked)} disabled={confirming} />
            Usar esta correspondência nas próximas notas deste fornecedor
          </label>
        )}

        {error && <div className="admin-message is-error">{error}</div>}

        <div className="confirm-dialog-actions">
          <button ref={cancelButton} type="button" className="button button-outline" onClick={onCancel} disabled={confirming}>Cancelar</button>
          <button type="button" className="button" onClick={() => void confirm()} disabled={!selected || confirming}>
            {confirming ? 'Confirmando...' : 'Confirmar conciliação'}
          </button>
        </div>
      </div>

      {scannerOpen && <BarcodeScanner onDetected={(code) => void handleScanned(code)} onClose={() => setScannerOpen(false)} />}
      {helpOpen && <ReconciliationHelp onClose={() => setHelpOpen(false)} />}
    </div>
  )
}

function ReconciliationHelp({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const closeButton = useRef<HTMLButtonElement>(null)

  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className="market-reconcile-help-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="market-reconcile-help" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="market-reconcile-help-header">
          <h2 id={titleId}>Como funciona a conciliação?</h2>
          <button ref={closeButton} type="button" className="market-reconcile-help-close" onClick={onClose} aria-label="Fechar ajuda">
            <X size={18} />
          </button>
        </header>
        <div className="market-reconcile-help-body">
          <section>
            <h3>Como conciliar</h3>
            <ol>
              <li><strong>Confira a sugestão.</strong> Compare o produto da nota com o produto do catálogo.</li>
              <li><strong>Ficou em dúvida?</strong> Use "Ler código de barras" e escaneie a embalagem.</li>
              <li><strong>Salve a correspondência.</strong> Se o produto estiver correto, você pode pedir ao GiroMicro para lembrar dessa relação.</li>
              <li><strong>Nas próximas compras</strong>, o mesmo código do fornecedor poderá ser reconhecido automaticamente.</li>
            </ol>
          </section>
          <section>
            <h3>Entenda as sugestões</h3>
            <dl className="market-reconcile-help-glossary">
              <div><dt>Descrição semelhante</dt><dd>Existem informações em comum entre a descrição da nota e o produto do catálogo.</dd></div>
              <div><dt>Peso/volume compatível</dt><dd>A apresentação encontrada é compatível, por exemplo 150g com 150g.</dd></div>
              <div><dt>Localizado por EAN</dt><dd>O código de barras lido corresponde ao produto do catálogo.</dd></div>
              <div><dt>Correspondência salva</dt><dd>Esse código do fornecedor já foi associado anteriormente a um produto.</dd></div>
            </dl>
          </section>
          <p className="market-reconcile-help-note">
            Os indicadores ajudam na escolha, mas não significam sozinhos que o produto está correto.
            O GiroMicro não altera o cadastro de produtos do Accesys.
          </p>
        </div>
      </div>
    </div>
  )
}
