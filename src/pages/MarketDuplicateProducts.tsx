import { ArrowLeft, Download, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { listDuplicateMarketProducts } from '../services/marketProducts'
import type { MarketDuplicateGroup } from '../types/marketProducts'
import './MarketDuplicateProducts.css'

export function MarketDuplicateProducts({ accountId, onBack }: { accountId: string; onBack: () => void }) {
  const [groups, setGroups] = useState<MarketDuplicateGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState(false)

  async function downloadSpreadsheet() {
    setExporting(true)
    setExportError(false)
    try {
      const { createDuplicateProductsSpreadsheet } = await import('../utils/marketDuplicateProductsExport')
      const { buffer, filename } = await createDuplicateProductsSpreadsheet(groups)
      const blob = new Blob([new Uint8Array(buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch {
      setExportError(true)
    } finally {
      setExporting(false)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    setGroups([])
    void listDuplicateMarketProducts(accountId, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setGroups(result)
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [accountId, revision])

  return <div className="market-duplicates">
    <button className="button button-small button-outline" onClick={onBack}><ArrowLeft size={16} /> Voltar ao Market</button>
    <header className="market-import-header">
      <p className="eyebrow">Produtos</p>
      <h1>Duplicados no cadastro</h1>
      <p>Esta verificação identifica produtos ativos com a mesma descrição e EANs diferentes. Isso pode dificultar a identificação correta da mercadoria na entrada de compras e no vínculo dos produtos.</p>
      <p>Revise a descrição no sistema de origem. Esta tela é somente de consulta.</p>
    </header>
    <div className="market-duplicate-actions">
      <button className="button button-small button-outline" disabled={loading || exporting} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={16} /> Atualizar análise</button>
      <button className="button button-small button-outline" disabled={loading || error || exporting || groups.length === 0} onClick={() => void downloadSpreadsheet()}><Download size={16} /> {exporting ? 'Gerando planilha...' : 'Baixar planilha'}</button>
    </div>
    {exportError && <div className="admin-message" role="alert">Não foi possível gerar a planilha. Tente baixar novamente.</div>}
    {loading ? <div className="admin-message" role="status">Verificando produtos do Market...</div>
      : error ? <div className="admin-message" role="alert">Não foi possível consultar os produtos. Tente atualizar a consulta.</div>
        : groups.length === 0 ? <div className="admin-message" role="status">Nenhuma descrição duplicada com EANs diferentes foi encontrada entre os produtos ativos deste Market.</div>
          : <section aria-label="Resultados da verificação" className="market-duplicate-results">
            <p role="status">{groups.length} {groups.length === 1 ? 'descrição encontrada' : 'descrições encontradas'}.</p>
            {groups.map((group) => <article className="market-duplicate-group" key={group.description}>
              <h2>{group.description}</h2>
              <ul>{group.products.map((product) => <li key={product.id}>
                <dl className="market-duplicate-row">
                  <div><dt>Descrição</dt><dd>{product.description}</dd></div>
                  <div><dt>EAN</dt><dd>{product.ean}</dd></div>
                </dl>
              </li>)}</ul>
            </article>)}
          </section>}
  </div>
}
