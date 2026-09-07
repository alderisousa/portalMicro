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

test('rótulo de custo distingue "conversão pendente" de "custo não informado" (caso real Norac)', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const formatStockUnitCost = \(item: MarketPurchaseItem\) => \{([\s\S]*?)\n\}/)?.[0] ?? ''
  assert.match(body, /conversionFactor === null[\s\S]*?Aguardando conversão/, 'conversion_factor null continua "Aguardando conversão"')
  assert.match(body, /stockUnitCost === null[\s\S]*?Custo não informado/, 'conversão resolvida + custo ausente vira "Custo não informado", não "Aguardando conversão"')
})

test('prontidão para receber exige stock_unit_cost resolvido (não só a conversão)', () => {
  const util = src('utils/purchaseReview.ts')
  const body = util.match(/export function isPurchaseItemReadyToReceive\([\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(body, /item\.stockUnitCost !== null/, 'sem custo unitário resolvido, o item não pode ser considerado pronto para receber')
})

test('"Usar total da linha": ação só some/aparece pela mesma condição pura, restrita ao campo net_amount', () => {
  const fields = src('components/PurchaseReviewFields.tsx')
  assert.match(fields, /import \{ reviewValueChanged, shouldSuggestNetAmountFromGross \} from '\.\.\/utils\/purchaseReview'/,
    'a condição de exibição precisa vir da função pura testada em purchase-review.test.mjs, não de lógica duplicada aqui')
  assert.match(fields, /showUseGrossAsNet = key === 'net_amount' && shouldSuggestNetAmountFromGross\(values\)/)
})

test('"Usar total da linha": clique só atualiza o rascunho local (onChange) — nunca salva, confere ou recebe', () => {
  const fields = src('components/PurchaseReviewFields.tsx')
  const button = fields.match(/showUseGrossAsNet && <button[\s\S]*?<\/button>\}/)?.[0] ?? ''
  assert.ok(button, 'botão de sugestão não encontrado')
  const onClickBody = button.match(/onClick=\{\(\) => \{([\s\S]*?)\}\}/)?.[1] ?? ''
  assert.match(onClickBody, /onChange\(\{ \.\.\.values, net_amount: values\.gross_amount \}\)/, 'só preenche net_amount a partir do valor atual de gross_amount, sem alterar mais nada')
  assert.doesNotMatch(onClickBody, /save|confirm|receive|rpc|Purchase(ItemReview|StagingReview)/i,
    'o clique não pode chamar nada de salvar/conferir/receber — só atualiza o estado local do formulário')
})

test('checkbox "lembrar esta conversão" abre marcado por padrão, sem persistir nada sozinho', () => {
  const dialog = src('components/PurchaseItemReviewDialog.tsx')
  assert.match(dialog, /const \[saveForReuse, setSaveForReuse\] = useState\(true\)/,
    'saveForReuse deve iniciar true — operador desmarca quando não quiser reaproveitar a conversão')
  // O diálogo é montado com key={reviewTarget.item.id} e desmontado por
  // `{reviewTarget && <...>}` em MarketPurchases.tsx — cada nova abertura
  // (mesmo item ou outro) é uma instância nova, então o useState(true) acima
  // garante reset automático a cada abertura, sem efeito adicional.
  const page = src('pages/MarketPurchases.tsx')
  assert.match(page, /\{reviewTarget && <PurchaseItemReviewDialog key=\{reviewTarget\.item\.id\}/)
  // saveForReuse só é lido dentro de save() (passado ao RPC de conversão
  // quando o operador aciona um botão) — nunca em um useEffect ou callback
  // de onChange que o gravaria sozinho ao marcar a caixa.
  assert.doesNotMatch(dialog, /useEffect\([^)]*saveForReuse/s, 'saveForReuse não pode disparar nenhum efeito sozinho')
  const setterBody = dialog.match(/onChangeSaveForReuse=\{([^}]*)\}/)?.[1] ?? ''
  assert.match(setterBody, /^setSaveForReuse$/, 'marcar/desmarcar só deve atualizar o estado local, sem chamar nenhuma função de salvar')
})

test('caixa de conversão é controlada (operador pode desmarcar livremente)', () => {
  const fields = src('components/PurchaseUnitConversionFields.tsx')
  assert.match(fields, /checked=\{saveForReuse\}\s*\n\s*onChange=\{\(event\) => onChangeSaveForReuse\(event\.target\.checked\)\}/)
})

test('"Salvar correções e conferir" salva e, na mesma ação, confirma a conferência humana', () => {
  const dialog = src('components/PurchaseItemReviewDialog.tsx')
  const toolbar = dialog.match(/<div className="market-purchase-items-toolbar">([\s\S]*?)<\/div>/)?.[1] ?? ''
  assert.match(toolbar, /Salvar correções e conferir/)
  assert.doesNotMatch(toolbar, />Salvar correções</, 'o texto antigo sem "e conferir" não pode mais aparecer sozinho')
  const buttons = toolbar.split(/(?=<button)/).filter((chunk) => chunk.startsWith('<button'))
  const primaryButton = buttons.find((chunk) => chunk.includes('>Salvar correções e conferir<')) ?? ''
  assert.match(primaryButton, /onClick=\{\(\) => void save\(true\)\}/, 'o botão precisa chamar save(true) — a mesma passagem que grava correção, conversão e confirma')
  // "Conferi este item" continua disponível e independente, para quando o
  // operador não precisa corrigir nada.
  const secondaryButton = buttons.find((chunk) => chunk.includes('>Conferi este item<')) ?? ''
  assert.match(secondaryButton, /onClick=\{\(\) => void save\(true\)\}/)
  assert.match(secondaryButton, /disabled=\{busy \|\| !canConfirm\}/)
})

test('save(): se a etapa de conferência falhar após a correção ter sido salva, o erro não é mascarado e o modal não fecha como sucesso', () => {
  const dialog = src('components/PurchaseItemReviewDialog.tsx')
  const saveBody = dialog.match(/const save = async \(confirm: boolean\) => \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
  assert.ok(saveBody, 'função save não encontrada')
  const tryBlock = saveBody.match(/try \{([\s\S]*?)\}\s*catch/)?.[1] ?? ''
  const catchBlock = saveBody.match(/catch \(cause\) \{([\s\S]*?)\}/)?.[1] ?? ''
  // onSaved() (que fecha o modal) só pode ser alcançado se as chamadas
  // anteriores (salvar correção, salvar conversão, confirmar) não lançarem.
  assert.match(tryBlock, /onSaved\(\)/)
  assert.doesNotMatch(catchBlock, /onSaved/, 'uma falha não pode fechar o modal como sucesso')
  // O refetch acontece antes da tentativa de confirmação — garante que o
  // estado exibido reflita a correção já salva mesmo que a confirmação falhe.
  const confirmCallIndex = tryBlock.indexOf('if (confirm)')
  const lastRefetchIndex = tryBlock.lastIndexOf('refetchCurrent()')
  assert.ok(confirmCallIndex > -1 && lastRefetchIndex > -1 && lastRefetchIndex < confirmCallIndex,
    'o estado precisa ser recarregado (refetchCurrent) antes da tentativa de confirmar, para nunca exibir dado desatualizado se a confirmação falhar')
})
