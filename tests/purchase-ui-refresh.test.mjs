// Sem framework de DOM/UI: valida por código-fonte as correções de estado
// obsoleto (stock_unit "sumindo" na UI mesmo já correto no banco) e de
// limpeza da carga do PDF. Complementa os testes de banco (que já provam
// que o backend resolve stock_unit corretamente) cobrindo o lado do frontend
// que de fato causava o sintoma relatado no smoke test.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const src = (path) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

test('SELECT de itens de compra continua trazendo os campos de conversão', () => {
  const service = src('services/marketPurchases.ts')
  const columns = service.match(/const purchaseItemColumns = `([^`]*)`/)?.[1] ?? ''
  for (const column of ['stock_unit', 'conversion_factor', 'stock_quantity', 'stock_unit_cost']) {
    assert.ok(columns.includes(column), `purchaseItemColumns deve incluir ${column}`)
  }
  assert.match(service, /export async function getMarketPurchaseItem/)
})

test('diálogo de conferência busca a versão atual do item ao abrir, não confia no snapshot recebido por prop', () => {
  const dialog = src('components/PurchaseItemReviewDialog.tsx')
  assert.match(dialog, /getMarketPurchaseItem\(accountId,\s*item\.id\)/)
  // Estado inicial precisa ser null (carregando) até a busca resolver — se
  // partisse de `item` diretamente, reintroduziria o bug do snapshot obsoleto.
  assert.match(dialog, /useState<MarketPurchaseItem \| null>\(null\)/)
  assert.match(dialog, /Carregando dados atuais do item/)
})

test('expandir um card de compra sempre recarrega os itens (não só na primeira vez)', () => {
  const page = src('pages/MarketPurchases.tsx')
  const toggleBody = page.match(/const toggle = \(purchaseId: string\) => \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  assert.ok(toggleBody, 'função toggle não encontrada')
  assert.doesNotMatch(toggleBody, /if \(!itemsState\[purchaseId\]\)/, 'toggle não pode mais só recarregar na primeira expansão')
  assert.match(toggleBody, /void loadItems\(purchaseId\)/)
})

test('limpeza de cache pós-importação roda antes do reload assíncrono, evitando apagar dados recém-carregados', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const finishSuccessfulImport = async[\s\S]*?\n  \}/)?.[0] ?? ''
  const deleteIndex = body.indexOf('delete next[purchaseId]')
  const awaitLoadIndex = body.indexOf('await load()')
  assert.ok(deleteIndex > -1 && awaitLoadIndex > -1, 'trechos esperados não encontrados em finishSuccessfulImport')
  assert.ok(deleteIndex < awaitLoadIndex, 'invalidação do cache deve ocorrer antes do await load() para não perder uma carga concorrente mais recente')
})

test('sucesso ao salvar o PDF remove só a carga daquela página (arquivo/preview/interpretação/diagnóstico); erro não remove nada', () => {
  const capture = src('components/PurchasePdfCapture.tsx')
  assert.match(capture, /onImported=\{\(id\) => \{ removePage\(page\.id\); onImported\(id\) \}\}/)
  // save()/onImported vivem em PurchaseStagingReview, reaproveitado por
  // PurchasePdfReview e por PurchaseAiTextCapture (Texto IA).
  const review = src('components/PurchaseStagingReview.tsx')
  const saveBody = review.match(/const save = async \(\) => \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  const tryBlock = saveBody.match(/try \{([\s\S]*?)\}\s*catch/)?.[1] ?? ''
  const catchBlock = saveBody.match(/catch \(cause\) \{([\s\S]*?)\}/)?.[1] ?? ''
  assert.match(tryBlock, /onImported\(id\)/, 'onImported só deve ser chamado no caminho de sucesso')
  assert.doesNotMatch(catchBlock, /onImported/, 'onImported não pode ser chamado no caminho de erro')
})

test('checkbox "usar esta correspondência nas próximas notas" abre marcado por padrão', () => {
  const dialog = src('components/PurchaseItemReconciliationDialog.tsx')
  assert.match(dialog, /const \[saveMapping, setSaveMapping\] = useState\(true\)/,
    'saveMapping deve iniciar true — operador desmarca quando não quiser reaproveitar')
  // O diálogo é montado/desmontado por `{reconcileTarget && <...>}` em
  // MarketPurchases.tsx (sem key fixa), então cada nova conciliação já é uma
  // instância nova do componente: o useState(true) acima garante reset
  // automático a cada abertura, sem precisar de efeito adicional.
  const page = src('pages/MarketPurchases.tsx')
  assert.match(page, /\{reconcileTarget && <PurchaseItemReconciliationDialog/)
})
