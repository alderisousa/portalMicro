import { AlertTriangle, ArrowLeft, CheckCircle2, FileSpreadsheet, RefreshCw, Upload, XCircle } from 'lucide-react'
import { ChangeEvent, useEffect, useRef, useState } from 'react'
import { getMarketSalesImportContext } from '../services/marketSalesImport'
import { confirmMarketSalesImport } from '../services/marketSalesImport'
import { MarketSalesImportError, type MarketSalesImportAnalysis, type MarketSalesImportBeginResult, type MarketSalesImportConfirmationResult, type MarketSalesImportContext } from '../types/marketSalesImport'
import { parseMarketSalesImport } from '../utils/marketSalesImportParser'

interface MarketSalesImportsProps { accountId: string; onBack: () => void }
const numberFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const currencyFormat = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
const formatDate = (iso: string | null) => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`)) : 'Não identificado'
const statusLabel = { ok: 'OK', product_pending: 'Produto pendente', store_pending: 'Loja não localizada', store_not_allowed: 'Loja sem acesso', error: 'Erro' }

export function MarketSalesImports({ accountId, onBack }: MarketSalesImportsProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [context, setContext] = useState<MarketSalesImportContext | null>(null)
  const [contextLoading, setContextLoading] = useState(true)
  const [analysis, setAnalysis] = useState<MarketSalesImportAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [errorDetails, setErrorDetails] = useState<string[]>([])
  const [confirmMode, setConfirmMode] = useState<'summary' | 'overlap' | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [progress, setProgress] = useState({ persisted: 0, total: 0 })
  const [confirmationResult, setConfirmationResult] = useState<MarketSalesImportConfirmationResult | null>(null)
  const [duplicateImport, setDuplicateImport] = useState<MarketSalesImportBeginResult | null>(null)

  useEffect(() => {
    let active = true
    setContextLoading(true)
    void getMarketSalesImportContext(accountId)
      .then((result) => { if (active) { setContext(result); if (!result.canImport) setErrorMessage('Seu perfil possui acesso somente para visualização e não pode importar vendas.') } })
      .catch((error) => { console.error('Falha ao preparar importação:', error); if (active) setErrorMessage(error instanceof Error ? error.message : 'Não foi possível validar o acesso à conta Market.') })
      .finally(() => { if (active) setContextLoading(false) })
    return () => { active = false }
  }, [accountId])

  const analyzeFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !context?.canImport) return
    setAnalysis(null); setErrorMessage(''); setErrorDetails([]); setConfirmationResult(null); setDuplicateImport(null); setConfirmMode(null); setAnalyzing(true)
    try {
      setAnalysis(await parseMarketSalesImport({ file, stores: context.stores, hasAllStoresAccess: context.access.all_stores || ['owner', 'admin'].includes(context.access.role), products: context.products, productMappings: context.productMappings }))
    } catch (error) {
      console.error('Falha ao analisar planilha:', error)
      setErrorMessage(error instanceof MarketSalesImportError ? error.message : 'Não foi possível analisar esta planilha.')
      setErrorDetails(error instanceof MarketSalesImportError ? error.details : [])
    } finally { setAnalyzing(false) }
  }

  const confirmImport = async (acceptOverlap: boolean) => {
    if (!analysis || confirming) return
    setConfirming(true); setErrorMessage(''); setConfirmMode(null); setProgress({ persisted: 0, total: analysis.rows.length })
    try {
      const outcome = await confirmMarketSalesImport(accountId, analysis, acceptOverlap, (persisted, total) => setProgress({ persisted, total }))
      if (outcome.type === 'overlap') setConfirmMode('overlap')
      else if (outcome.type === 'duplicate') setDuplicateImport(outcome.existing)
      else setConfirmationResult(outcome.result)
    } catch (error) {
      console.error('Falha ao confirmar importação:', error)
      setErrorMessage(error instanceof Error ? error.message : 'Não foi possível confirmar a importação.')
    } finally { setConfirming(false) }
  }

  if (contextLoading) return <div className="admin-message" role="status">Validando acesso para importação...</div>
  if (!context || !context.canImport) return <section className="market-import-page"><button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Voltar ao Market</button><div className="market-access-blocked"><XCircle size={28} /><h1>Importação indisponível</h1><p>{errorMessage || 'Você não possui permissão para importar vendas nesta conta.'}</p></div></section>

  return <section className="market-import-page">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Voltar ao Market</button>
    <header className="market-import-header"><p className="eyebrow"><FileSpreadsheet size={16} /> GiroMicro Market</p><h1>Importação de vendas</h1><p>Envie a planilha de itens vendidos exportada pelo sistema da sua loja.</p><dl><div><dt>Conta Market</dt><dd>{context.access.name}</dd></div><div><dt>Formato aceito</dt><dd>XLSX · até 10 MB</dd></div></dl></header>

    {!analysis && <div className="market-file-picker"><Upload size={30} /><h2>Selecionar planilha</h2><p>O arquivo será lido e analisado somente no seu navegador. Nenhum dado será gravado nesta etapa.</p><button className="button" onClick={() => inputRef.current?.click()} disabled={analyzing}>{analyzing ? <><RefreshCw size={17} /> Analisando planilha...</> : <><FileSpreadsheet size={17} /> Selecionar planilha</>}</button><input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(event) => void analyzeFile(event)} /></div>}

    {errorMessage && context.canImport && <div className="admin-message is-error" role="alert"><p>{errorMessage}</p>{errorDetails.length > 0 && <ul className="market-error-details">{errorDetails.map((detail) => <li key={detail}>{detail}</li>)}</ul>}<button className="button button-small" onClick={() => inputRef.current?.click()}>Selecionar outro arquivo</button></div>}

    {confirmationResult && analysis && <ImportSuccess analysis={analysis} result={confirmationResult} />}
    {duplicateImport && <DuplicateImportMessage duplicate={duplicateImport} onChangeFile={() => inputRef.current?.click()} />}
    {confirming && <p className="admin-feedback" role="status">Importando vendas... Processando {numberFormat.format(progress.persisted)} de {numberFormat.format(progress.total)} linhas.</p>}
    {analysis && !confirmationResult && !duplicateImport && <ImportPreview analysis={analysis} onChangeFile={() => inputRef.current?.click()} onRequestConfirm={() => setConfirmMode('summary')} confirming={confirming} confirmed={false} />}
    {analysis && confirmMode && <ImportConfirmationDialog analysis={analysis} overlap={confirmMode === 'overlap'} processing={confirming} onCancel={() => setConfirmMode(null)} onConfirm={() => void confirmImport(confirmMode === 'overlap')} />}
  </section>
}

function DuplicateImportMessage({ duplicate, onChangeFile }: { duplicate: MarketSalesImportBeginResult; onChangeFile: () => void }) {
  const importedAt = duplicate.createdAt
    ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(duplicate.createdAt))
    : null
  return <div className="admin-message is-error" role="alert">
    <p><strong>Esta planilha já foi importada para esta conta.</strong></p>
    <p>Período: {formatDate(duplicate.periodStart ?? null)} a {formatDate(duplicate.periodEnd ?? null)}</p>
    <small>Importação: {duplicate.importId} · Status: {duplicate.status || 'concluída'}{importedAt ? ` · ${importedAt}` : ''}</small>
    <div><button className="button button-small" onClick={onChangeFile}>Selecionar outro arquivo</button></div>
  </div>
}

function ImportPreview({ analysis, onChangeFile, onRequestConfirm, confirming, confirmed }: { analysis: MarketSalesImportAnalysis; onChangeFile: () => void; onRequestConfirm: () => void; confirming: boolean; confirmed: boolean }) {
  const invalidExamples = analysis.rows.filter((row) => row.barcodeStatus === 'invalid').slice(0, 5)
  const hasBlockingStores = analysis.stores.some((store) => store.status !== 'resolved')
  const canConfirm = !hasBlockingStores && analysis.stats.errorRows === 0 && !confirmed
  return <div className="market-import-preview">
    <div className="market-preview-file"><div><span className="panel-kicker">ARQUIVO ANALISADO</span><h2>{analysis.fileName}</h2><p>Período: {formatDate(analysis.periodStart)} a {formatDate(analysis.periodEnd)} · SHA-256: {analysis.fileHash.slice(0, 16)}…</p></div><button className="button button-small button-outline" onClick={onChangeFile}>Selecionar outro arquivo</button></div>
    {analysis.warnings.map((warning) => <p className="market-preview-warning" key={warning}><AlertTriangle size={16} /> {warning}</p>)}

    <section><span className="panel-kicker">RESUMO</span><div className="market-preview-stats"><article><strong>{numberFormat.format(analysis.stats.totalRows)}</strong><span>Linhas encontradas</span></article><article><strong>{analysis.stats.distinctStores}</strong><span>Lojas no arquivo</span></article><article><strong>{numberFormat.format(analysis.stats.distinctProducts)}</strong><span>Produtos/EANs</span></article><article><strong>{numberFormat.format(analysis.stats.totalQuantity)}</strong><span>Itens vendidos</span></article><article><strong>{currencyFormat.format(analysis.stats.totalRevenue)}</strong><span>Faturamento</span></article>{analysis.stats.totalCost !== null && <article><strong>{currencyFormat.format(analysis.stats.totalCost)}</strong><span>Custo total</span></article>}{analysis.stats.totalProfit !== null && <article><strong>{currencyFormat.format(analysis.stats.totalProfit)}</strong><span>Lucro total</span></article>}</div></section>

    <section className="market-preview-section"><span className="panel-kicker">LOJAS</span><div className="market-preview-stores">{analysis.stores.map((store) => <article key={`${store.externalCode}-${store.externalName}`}><span className={`market-validation-icon ${store.status}`}>{store.status === 'resolved' ? <CheckCircle2 /> : <AlertTriangle />}</span><div><strong>{store.externalCode || 'Sem código'} — {store.externalName || store.storeName || 'Nome não informado'}</strong><span>{numberFormat.format(store.rowCount)} linhas · {store.status === 'resolved' ? 'Reconhecida' : store.status === 'not_allowed' ? 'Sem acesso' : 'Não localizada'}</span></div></article>)}</div></section>

    <section className="market-preview-section"><span className="panel-kicker">VALIDAÇÃO</span><div className="market-validation-summary"><p><CheckCircle2 /> {analysis.stats.recognizedStores} lojas reconhecidas</p><p><AlertTriangle /> {numberFormat.format(analysis.stats.pendingRows)} linhas com pendência</p><p><XCircle /> {numberFormat.format(analysis.stats.errorRows)} linhas com erro</p></div></section>

    <section className="market-preview-section"><span className="panel-kicker">PENDÊNCIAS</span><div className="market-pending-grid"><article><strong>{numberFormat.format(analysis.stats.invalidBarcodes)}</strong><span>códigos não validados como GTIN</span></article><article><strong>{numberFormat.format(analysis.stats.missingBarcodes)}</strong><span>códigos de produto ausentes</span></article><article><strong>{analysis.stats.unrecognizedStores}</strong><span>lojas não reconhecidas/permitidas</span></article><article><strong>{analysis.stats.errorRows}</strong><span>linhas com erro</span></article></div>{invalidExamples.length > 0 && <ul className="market-pending-examples">{invalidExamples.map((row) => <li key={row.sourceRowNumber}>Linha {row.sourceRowNumber}: código {row.externalEanRaw || 'ausente'} — não validado matematicamente como GTIN; a venda continuará preservada</li>)}</ul>}</section>

    <section className="market-preview-section"><div className="admin-list-heading"><div><span className="panel-kicker">AMOSTRA</span><h2>Primeiras 10 linhas</h2></div></div><div className="market-preview-table-wrap"><table className="market-preview-table"><thead><tr><th>Loja</th><th>EAN</th><th>Descrição</th><th>Quantidade</th><th>Valor total</th><th>Situação</th></tr></thead><tbody>{analysis.rows.slice(0, 10).map((row) => <tr key={row.sourceRowNumber}><td>{row.externalStoreCode}<small>{row.externalStoreName}</small></td><td>{row.externalEanRaw || '—'}</td><td>{row.description || '—'}</td><td>{row.quantity === null ? 'Inválida' : numberFormat.format(row.quantity)}</td><td>{row.totalAmount === null ? 'Inválido' : currencyFormat.format(row.totalAmount)}</td><td><span className={`market-row-status ${row.status}`}>{statusLabel[row.status]}</span></td></tr>)}</tbody></table></div></section>

    <div className="market-import-confirm"><button className="button" onClick={onRequestConfirm} disabled={!canConfirm || confirming}>{confirming ? 'Importando vendas...' : 'Confirmar importação'}</button><p>{hasBlockingStores ? 'Resolva os problemas de loja antes de confirmar.' : analysis.stats.errorRows > 0 ? 'Corrija as linhas estruturalmente inválidas antes de confirmar.' : 'Esta operação registra histórico comercial e não altera o estoque.'}</p></div>
  </div>
}

function ImportConfirmationDialog({ analysis, overlap, processing, onCancel, onConfirm }: { analysis: MarketSalesImportAnalysis; overlap: boolean; processing: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="confirm-dialog-backdrop"><div className="confirm-dialog" role="dialog" aria-modal="true"><div className="confirm-dialog-content"><h2>{overlap ? 'Período sobreposto' : 'Confirmar importação?'}</h2>{overlap ? <p>Já existe uma importação concluída com período sobreposto. Confirme se este arquivo deve realmente ser adicionado.</p> : <><p>Você está prestes a importar:</p><ul className="market-confirm-summary"><li>{numberFormat.format(analysis.stats.totalRows)} linhas comerciais</li><li>{analysis.stats.distinctStores} lojas</li><li>{numberFormat.format(analysis.stats.distinctProducts)} produtos identificados</li><li>Período: {formatDate(analysis.periodStart)} a {formatDate(analysis.periodEnd)}</li></ul><p><strong>Nenhuma movimentação de estoque será criada.</strong></p></>}</div><div className="confirm-dialog-actions"><button className="button button-outline" onClick={onCancel} disabled={processing}>Cancelar</button><button className="button" onClick={onConfirm} disabled={processing}>{processing ? 'Importando...' : overlap ? 'Importar mesmo assim' : 'Confirmar importação'}</button></div></div></div>
}

function ImportSuccess({ analysis, result }: { analysis: MarketSalesImportAnalysis; result: MarketSalesImportConfirmationResult }) {
  return <section className="market-import-success"><CheckCircle2 size={34} /><span className="panel-kicker">IMPORTAÇÃO CONCLUÍDA</span><h2>{result.status === 'completed' ? 'Importação concluída' : 'Importação concluída com pendências'}</h2><p>Período: {formatDate(analysis.periodStart)} a {formatDate(analysis.periodEnd)}</p><div className="market-preview-stats"><article><strong>{numberFormat.format(result.totalRows)}</strong><span>Linhas importadas</span></article><article><strong>{analysis.stats.distinctStores}</strong><span>Lojas</span></article><article><strong>{numberFormat.format(result.productsAssociated)}</strong><span>Produtos associados</span></article><article><strong>{numberFormat.format(result.productsCreated)}</strong><span>Produtos criados</span></article><article><strong>{numberFormat.format(result.pendingRows)}</strong><span>Produtos para revisão</span></article></div><p className="market-stock-note">Esta importação registra o histórico de vendas. Nenhuma movimentação de estoque foi criada.</p></section>
}
