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

test('aviso de custo pelo total: aparece pela mesma condição pura, restrita ao campo net_amount, sem clique nem escrita em net_amount', () => {
  const fields = src('components/PurchaseReviewFields.tsx')
  assert.match(fields, /import \{ reviewValueChanged, shouldSuggestNetAmountFromGross \} from '\.\.\/utils\/purchaseReview'/,
    'a condição de exibição precisa vir da função pura testada em purchase-review.test.mjs, não de lógica duplicada aqui')
  assert.match(fields, /usedGrossAsNetFallback = key === 'net_amount' && shouldSuggestNetAmountFromGross\(values\)/)
  const note = fields.match(/usedGrossAsNetFallback && <small[\s\S]*?<\/small>\}/)?.[0] ?? ''
  assert.ok(note, 'nota informativa não encontrada')
  assert.doesNotMatch(fields, /<button[^>]*market-ocr-review-field-suggestion/, 'o botão clicável antigo não pode mais existir — o fallback agora é automático (banco)')
  assert.doesNotMatch(note, /onClick|onChange\(/, 'a nota é só leitura: nunca chama onChange nem preenche net_amount no rascunho')
  assert.match(note, /Valor líquido não informado no documento/)
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

test('mensagem de sucesso em Compras some sozinha; mensagem de erro não é afetada', () => {
  const page = src('pages/MarketPurchases.tsx')
  const effect = page.match(/useEffect\(\(\) => \{\s*if \(!message \|\| message\.error\) return[\s\S]*?\n {2}\}, \[message\]\)/)?.[0] ?? ''
  assert.ok(effect, 'efeito de auto-limpeza da mensagem de sucesso não encontrado')
  assert.match(effect, /setTimeout\(\(\) => setMessage\(null\), 4000\)/)
  assert.match(effect, /return \(\) => clearTimeout\(timer\)/, 'precisa cancelar o timer anterior a cada nova mensagem, sem acumular timers')
  // A condição de saída antecipada garante que uma mensagem de erro nunca
  // dispara o timer — comportamento de erro fica exatamente como antes.
  assert.match(effect, /if \(!message \|\| message\.error\) return/)
})

test('"Atualizar mercadorias" reaproveita a sincronização já usada em Estoque/Admin da integração, sem endpoint novo', () => {
  const page = src('pages/MarketPurchases.tsx')
  assert.match(page, /import \{ findAccesysIntegrationId, synchronizeMarketProducts \} from '\.\.\/services\/marketIntegration'/,
    'precisa importar do serviço de integração já existente, não duplicar a chamada à edge function')
  const syncBody = page.match(/const syncProducts = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
  assert.ok(syncBody, 'função syncProducts não encontrada')
  assert.match(syncBody, /if \(!productIntegrationId \|\| productSyncing\) return/, 'clique duplicado precisa ser bloqueado enquanto productSyncing for true')
  assert.match(syncBody, /setProductSyncing\(true\)/)
  assert.match(syncBody, /synchronizeMarketProducts\(accountId, productIntegrationId, 'inventory', productSyncRun, setProductSyncRun\)/)
  assert.match(syncBody, /finally \{ setProductSyncing\(false\) \}/)
  // Após concluir, só reconsulta os produtos do card expandido (usados na
  // conciliação) — não mexe em reviewTarget/reconcileTarget/itemsState de
  // outros cards, então nota aberta e conciliação em andamento são preservadas.
  assert.match(syncBody, /if \(expandedId\) await loadItems\(expandedId\)/)
  assert.doesNotMatch(syncBody, /setReviewTarget|setReconcileTarget|setExpandedId/, 'não pode fechar diálogo aberto nem trocar o card expandido')
  // Botão: visível só com integração resolvida e nas mesmas permissões já
  // usadas no resto da tela (canImport), desabilitado durante a sincronização.
  const button = page.match(/\{canImport && productIntegrationId && <button[\s\S]*?<\/button>\}/)?.[0] ?? ''
  assert.match(button, /disabled=\{productSyncing\}/)
  assert.match(button, /onClick=\{\(\) => void syncProducts\(\)\}/)
  assert.match(button, /Atualizar mercadorias/)
})

test('conciliar item repassa itemsAutoResolved da RPC ao invés de descartar o resultado', () => {
  const dialog = src('components/PurchaseItemReconciliationDialog.tsx')
  assert.match(dialog, /onConfirmed: \(itemsAutoResolved: number\) => void/)
  const confirmBody = dialog.match(/const confirm = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
  assert.match(confirmBody, /const result = await confirmPurchaseItemReconciliation\(/)
  assert.match(confirmBody, /onConfirmed\(result\.itemsAutoResolved\)/)
})

test('reconhecimento automático de outros itens mostra feedback discreto; sem itens extras, nenhuma mensagem nova', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const handleReconciled = async \(itemsAutoResolved: number\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'handleReconciled não encontrada ou não recebe itemsAutoResolved')
  assert.match(body, /if \(itemsAutoResolved > 0\) setMessage\(/, 'só mostra mensagem quando algo foi de fato reconhecido automaticamente')
  assert.match(body, /reconhecid[oa]s?/i)
  assert.match(body, /automaticamente/i)
  const page2 = src('pages/MarketPurchases.tsx')
  assert.match(page2, /\{reconcileTarget && <PurchaseItemReconciliationDialog[\s\S]*?onConfirmed=\{handleReconciled\}/)
})

// Avanço automático entre itens na conferência da nota: ao concluir um item,
// abre sozinho o próximo pendente, sem o operador voltar ao topo da lista.
// loadItems agora devolve os itens recém-carregados (em vez de só atualizar
// itemsState) exatamente para que estes handlers decidam o próximo passo sem
// depender de estado React que ainda não recommitou.
test('loadItems devolve os itens recém-carregados, para o avanço automático decidir sem depender de closure de estado obsoleto', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const loadItems = useCallback\(async \(purchaseId: string\)[\s\S]*?\n {2}\}, \[accountId\]\)/)?.[0] ?? ''
  assert.ok(body, 'loadItems não encontrada')
  assert.match(body, /Promise<MarketPurchaseItem\[\] \| undefined>/)
  assert.match(body, /return items/)
})

test('item 1/2: próximo pendente com de/para válido abre a conferência; sem de/para abre o vínculo', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const openNextPendingItem = \(purchaseId: string, items: MarketPurchaseItem\[\]\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'openNextPendingItem não encontrada')
  // "Pendente" = ainda pode ser conferido e ainda não foi conferido — nunca
  // usa reconciliationStatus para decidir isso (isso decidiria só a etapa
  // de vínculo, não a elegibilidade para o avanço).
  assert.match(body, /items\.find\(\(item\) => canReviewPurchaseItem\(item\) && !isHumanReviewed\(item\)\)/)
  assert.match(body, /if \(next\.marketProductId\) setReviewTarget\(\{ purchaseId, item: next \}\)/)
  assert.match(body, /else setReconcileTarget\(\{ purchaseId, item: next \}\)/)
})

test('item 3: salvar o vínculo abre automaticamente a conferência do mesmo item, nunca confere sozinho', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const handleReconciled = async \(itemsAutoResolved: number\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'handleReconciled não encontrada')
  assert.match(body, /const justConfirmed = items\?\.find\(\(current\) => current\.id === item\.id\)/,
    'precisa reabrir o MESMO item que acabou de ser conciliado, não outro')
  assert.match(body, /if \(justConfirmed\) setReviewTarget\(\{ purchaseId, item: justConfirmed \}\)/)
  // Nada nesta função confirma a conferência sozinha — só reabre a tela;
  // savePurchaseItemReview/RPC de conferência não podem ser chamados aqui.
  assert.doesNotMatch(body, /savePurchaseItemReview|market_save_purchase_item_review/)
})

test('item 4: concluir a conferência avança para o próximo pendente da nota', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const handleReviewSaved = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'handleReviewSaved não encontrada')
  assert.match(body, /const items = await loadItems\(purchaseId\)/)
  assert.match(body, /if \(items\) openNextPendingItem\(purchaseId, items\)/)
  // Só dispara depois que a conferência realmente terminou: PurchaseItemReviewDialog
  // só chama onSaved no caminho de sucesso do confirm (ver save() do diálogo).
  const dialogSaveBody = src('components/PurchaseItemReviewDialog.tsx').match(/const save = async \(confirm: boolean\) => \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
  const tryBlock = dialogSaveBody.match(/try \{([\s\S]*?)\}\s*catch/)?.[1] ?? ''
  assert.match(tryBlock, /onSaved\(\)/)
})

test('item 5: item já resolvido pelo reprocessamento pula a etapa de vínculo e vai direto para a conferência', () => {
  // Mesma asserção de origem que prova o item 1/2: a decisão é feita só por
  // marketProductId (presente quando o reprocessamento em cascata já
  // resolveu o produto), nunca reabrindo PurchaseItemReconciliationDialog
  // para um item que já tem produto vinculado.
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const openNextPendingItem = \(purchaseId: string, items: MarketPurchaseItem\[\]\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /if \(next\.marketProductId\) setReviewTarget/, 'item com produto já resolvido (auto ou por reprocessamento) não deve reabrir o vínculo')
})

test('item 6: cancelar em qualquer diálogo interrompe o avanço, sem chamar loadItems/openNextPendingItem', () => {
  const page = src('pages/MarketPurchases.tsx')
  const reconcileCancel = page.match(/\{reconcileTarget && <PurchaseItemReconciliationDialog[\s\S]*?onCancel=\{([^}]*)\}/)?.[1] ?? ''
  const reviewCancel = page.match(/\{reviewTarget && <PurchaseItemReviewDialog[\s\S]*?onCancel=\{([^}]*)\}/)?.[1] ?? ''
  assert.match(reconcileCancel.trim(), /^\(\) => setReconcileTarget\(null\)$/)
  assert.match(reviewCancel.trim(), /^\(\) => setReviewTarget\(null\)$/)
})

test('item 7: sem próximo pendente, openNextPendingItem não abre diálogo nenhum', () => {
  const page = src('pages/MarketPurchases.tsx')
  const body = page.match(/const openNextPendingItem = \(purchaseId: string, items: MarketPurchaseItem\[\]\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /if \(!next\) return/, 'precisa retornar cedo, sem setReviewTarget/setReconcileTarget, quando não há mais item pendente')
})

test('botão manual "Reprocessar pendentes" continua disponível como fallback, sem depender do novo fluxo automático', () => {
  const page = src('pages/MarketPurchases.tsx')
  assert.match(page, /Reprocessar pendentes/)
  assert.match(page, /onClick=\{\(\) => void handleReprocess\(purchase\.id\)\}/)
  const handleReprocessBody = page.match(/const handleReprocess = async \(purchaseId: string\) => \{([\s\S]*?)\n {2}\}/)?.[1] ?? ''
  assert.match(handleReprocessBody, /reprocessPurchasePendingItems\(accountId, purchaseId\)/, 'continua chamando a mesma função de serviço/RPC de sempre')
})
