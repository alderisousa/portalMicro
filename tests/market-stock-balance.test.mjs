// Busca local sobre o saldo atual (Estoque). Função pura isolada em
// src/utils/marketStockBalance.ts justamente para poder ser testada sem
// importar a página inteira (React/lucide-react/BarcodeScanner/services).
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
registerHooks({ resolve(s,c,n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s,c) } })
const { findMarketStockBalance, compareStockCount } = await import('../src/utils/marketStockBalance.ts')

const row = (over = {}) => ({
  marketAccountId: 'a', marketStoreId: 's1', storeName: 'Loja 1', stockControlStartedAt: '2026-01-01T00:00:00Z',
  productId: 'p1', productName: 'Refrigerante Cola 2L', ean: '7891234567890', sku: 'SKU1', unit: 'UN',
  quantityOnHand: 12, lastMovementAt: '2026-01-02T00:00:00Z', ...over,
})

test('query vazia devolve todo o saldo (listagem padrão da tela)', () => {
  const balance = [row(), row({ productId: 'p2', productName: 'Água 500ml', ean: null })]
  assert.deepEqual(findMarketStockBalance(balance, ''), balance)
  assert.deepEqual(findMarketStockBalance(balance, '   '), balance)
})

test('filtra por descrição, sem diferenciar maiúsculas/acentos', () => {
  const cola = row()
  const agua = row({ productId: 'p2', productName: 'Água com Gás 500ml', ean: null })
  const balance = [cola, agua]
  assert.deepEqual(findMarketStockBalance(balance, 'agua com gas'), [agua])
  assert.deepEqual(findMarketStockBalance(balance, 'REFRIGERANTE'), [cola])
})

test('filtra por EAN/GTIN exato ou parcial', () => {
  const cola = row()
  const agua = row({ productId: 'p2', productName: 'Água 500ml', ean: '7899999999999' })
  const balance = [cola, agua]
  assert.deepEqual(findMarketStockBalance(balance, '7891234567890'), [cola])
  assert.deepEqual(findMarketStockBalance(balance, '789123'), [cola])
})

test('produto sem EAN não quebra a busca por código (nunca lança)', () => {
  const semEan = row({ productId: 'p3', productName: 'Item sem EAN', ean: null })
  assert.deepEqual(findMarketStockBalance([semEan], '123'), [])
  assert.deepEqual(findMarketStockBalance([semEan], 'item sem ean'), [semEan])
})

test('sem correspondência devolve lista vazia, nunca inventa resultado', () => {
  const balance = [row()]
  assert.deepEqual(findMarketStockBalance(balance, 'produto-inexistente'), [])
})

// Sanidade sobre o código-fonte da página (sem executar React): confirma que
// a tela ainda usa compareStockCount (comparação de saldo continua exigida
// durante a contagem — não alterada por esta etapa) e não tocou no fluxo de
// inventário.
test('tela de Estoque continua usando compareStockCount importado do util, sem duplicar a lógica', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  // Import de ../utils/marketStockBalance cresceu (isReasonMissing, requiresDivergenceReason,
  // 202609080003) — checa por nome, não pela lista/ordem exata dos outros imports.
  const balanceUtilImport = source.match(/import \{[^}]*\} from '\.\.\/utils\/marketStockBalance'/)?.[0] ?? ''
  assert.ok(balanceUtilImport, "import de '../utils/marketStockBalance' não encontrado")
  assert.match(balanceUtilImport, /\bcompareStockCount\b/)
})

// Fechamento da Sprint — item 3: a listagem de todos os produtos com
// "quantidade atual" deixou de ser o conteúdo principal da tela inicial de
// Estoque (findMarketStockBalance/balanceQuery/filteredBalance saíram do
// componente junto com ela — substituídos por "Últimos inventários", ver
// testes dedicados em market-stock-history.test.mjs). findMarketStockBalance
// continua disponível em utils/marketStockBalance.ts (testada acima), só não
// é mais chamada por este componente.
test('findMarketStockBalance/balanceQuery/filteredBalance (busca da antiga listagem de saldo) saíram do componente — substituídas por "Últimos inventários"', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bfindMarketStockBalance\b/, 'a tela inicial não lista mais produtos por saldo — findMarketStockBalance não é mais usada aqui')
  assert.doesNotMatch(source, /\bbalanceQuery\b/)
  assert.doesNotMatch(source, /\bfilteredBalance\b/)
})

// Fechamento da Sprint — item 2: aviso sobre quando o saldo é atualizado,
// integrado ao layout existente da tela inicial (mesma classe de parágrafo
// mudo já usada para "Marco inicial:", sem componente/destaque novo).
test('tela inicial de Estoque explica que o saldo só é atualizado após a finalização do inventário', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  assert.match(source, /As contagens são salvas durante o inventário, mas o saldo do estoque só é atualizado após a finalização\./)
  const balanceHeader = source.match(/<section className="market-stock-balance">\s*\n\s*<div>([\s\S]*?)<\/div>/)?.[0] ?? ''
  assert.match(balanceHeader, /As contagens são salvas durante o inventário/, 'precisa estar no cabeçalho da tela inicial de Estoque, não em um bloco separado')
})

test('"Últimos inventários": estado vazio distingue "carregando" de "nenhum inventário ainda", nenhum tratado como erro', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  assert.match(source, /Carregando histórico\.\.\./)
  assert.match(source, /Nenhum inventário concluído neste local ainda\./)
  const section = source.match(/<section className="market-stock-balance">[\s\S]*?\n {4}<\/section>\}/)?.[0] ?? ''
  assert.ok(section, 'seção market-stock-balance não encontrada')
  assert.doesNotMatch(section, /is-error/, 'estado vazio não pode ser tratado como erro')
})

test('histórico é recarregado ao trocar de local (via applyStoreData), e resetado junto com o detalhe aberto', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  const applyStoreDataBody = source.match(/const applyStoreData = async \(nextStoreId: string, nextContext: MarketStockContext\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(applyStoreDataBody, /listMarketInventorySessions\(accountId, nextStoreId\)/)
  assert.match(applyStoreDataBody, /setHistorySessions\(nextHistory\); setHistoryOpenSessionId\(''\); setHistoryDetail\(null\)/)
})

test('inventário (rascunho/finalização) não foi tocado por esta mudança', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  // persistDraft (array completo) foi substituído por commitDirtyItems/commitItem
  // na 202609080005 (persistência por item, multiusuário) — mudança sancionada,
  // posterior à busca de saldo que este teste originalmente protegia.
  assert.match(source, /const commitDirtyItems = useCallback/)
  assert.match(source, /const finalizeDraft = async/)
  assert.match(source, /const startDraft = async/)
  assert.match(source, /const resumeDraft = async/)
})

// Saldo anterior/atual nos itens da tela de contagem: compareStockCount é a
// ÚNICA fonte usada, independentemente de o item ter vindo do draft, da
// busca por nome, EAN/GTIN, código externo/SKU ou do scanner (todos passam
// pelo mesmo balanceByProduct, derivado de market_get_stock_balance).
test('compareStockCount: produto com saldo conhecido (mesmo zero) devolve known:true e a diferença correta', () => {
  const balanceByProduct = new Map([['p1', 0], ['p2', 45]])
  assert.deepEqual(compareStockCount(balanceByProduct, 'p1', 13), { known: true, currentQuantity: 0, countedQuantity: 13, difference: 13 })
  assert.deepEqual(compareStockCount(balanceByProduct, 'p2', 40), { known: true, currentQuantity: 45, countedQuantity: 40, difference: -5 })
  assert.deepEqual(compareStockCount(balanceByProduct, 'p2', 45), { known: true, currentQuantity: 45, countedQuantity: 45, difference: 0 })
})

test('compareStockCount: produto sem nenhum registro de saldo devolve known:false, nunca inventa "saldo 0"', () => {
  const balanceByProduct = new Map([['p1', 0]])
  const result = compareStockCount(balanceByProduct, 'produto-nunca-movimentado', 13)
  assert.equal(result.known, false)
})

test('produto sem saldo conhecido é exibido como "Saldo não registrado", não como "Saldo 0"', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  const itemBody = source.match(/const comparison = compareStockCount\(balanceByProduct, item\.productId, item\.quantity\)([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.ok(itemBody, 'bloco de renderização do item contado não encontrado')
  // 202609080003 introduziu balanceLabel/countedLabel/differenceLabel (item
  // não contado passa a exibir "—"), mas o texto explícito para saldo
  // desconhecido continua vindo do mesmo ternário — nunca "Saldo 0" fabricado.
  assert.match(itemBody, /const balanceLabel = comparison\.known \? number\.format\(comparison\.currentQuantity\) : 'não registrado'/, 'com saldo conhecido, mostra o valor formatado; sem saldo conhecido, mostra o texto explícito')
  assert.match(itemBody, /Saldo \{balanceLabel\}/, 'a comparação exibida usa balanceLabel, que já resolve known/unknown')
  // Nenhum outro cálculo de saldo/diferença dentro do item — uma só fonte.
  assert.doesNotMatch(itemBody, /balanceByProduct\.get\(item\.productId\) \?\? 0/, 'não pode reintroduzir o fallback silencioso antigo')
})

test('a comparação de saldo é calculada uma única vez por item e reaproveitada — mesmo tratamento independente da origem do produto (draft/busca/EAN/SKU/scanner)', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  // 202609XXXXX (bloco "Inventário multiusuário", ordenação por recência):
  // a renderização passou a iterar sobre orderedItems (items ordenado por
  // itemOrder via sortItemsByRecency, só para exibição) em vez de items
  // diretamente — mesma lista, mesma função de comparação por item.
  const itemsMapBody = source.match(/\{orderedItems\.length \? orderedItems\.map\(\(item\) => \{([\s\S]*?)\}\) : /)?.[0] ?? ''
  assert.ok(itemsMapBody, 'orderedItems.map não encontrado')
  // orderedItems.map itera sobre a lista (não uma lista separada por origem) —
  // todo item selecionado por selectProduct (busca, EAN/SKU exato, scanner) ou
  // já presente em draft.items cai na MESMA função de comparação abaixo.
  const compareCalls = itemsMapBody.match(/compareStockCount\(/g) ?? []
  assert.equal(compareCalls.length, 1, 'compareStockCount deve ser chamada uma única vez por item, sem caminho alternativo para itens novos')
})

// Caso real Galpão Market: GALAK (EAN 7891000368626), saldo conhecido 64,
// sessão 'initial' (loja nunca teve inventário inicial finalizado, mesmo já
// tendo recebido por Compras). Antes da correção, isCycleInventory sozinho
// escondia a comparação inteira mesmo com saldo conhecido.
test('caso real Galpão/GALAK: sessão initial + saldo conhecido mostra Saldo/Contagem/Diferença (antes ficava oculto)', () => {
  const balanceByProduct = new Map([['galak-id', 64]])
  const comparison = compareStockCount(balanceByProduct, 'galak-id', 1)
  assert.deepEqual(comparison, { known: true, currentQuantity: 64, countedQuantity: 1, difference: -63 })
  const isCycleInventory = false // draft.inventoryType === 'initial'
  assert.equal((isCycleInventory || comparison.known), true, 'gate deve liberar a exibição mesmo em sessão initial quando o produto tem saldo conhecido')
})

test('condição do bloco de comparação: (isCycleInventory || comparison.known), só neste bloco — outros usos de isCycleInventory intactos', () => {
  const source = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
  const itemBody = source.match(/const comparison = compareStockCount\(balanceByProduct, item\.productId, item\.quantity\)([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.ok(itemBody, 'bloco de renderização do item contado não encontrado')
  // 202609080003 trocou o ternário inline por balanceLabel/countedLabel/differenceLabel
  // pré-calculados, mas o gate em si (isCycleInventory || comparison.known) é o mesmo.
  assert.match(itemBody, /\{\(isCycleInventory \|\| comparison\.known\) && <span className="market-stock-comparison">/, 'gate corrigido não encontrado')
  assert.doesNotMatch(itemBody, /\{isCycleInventory && <span className="market-stock-comparison">/, 'condição antiga (só isCycleInventory) não pode mais existir neste bloco')
  // Os outros 3 usos de isCycleInventory no mesmo item (classe is-zero, nota
  // de zero, botão "Remover da contagem") continuam exatamente como antes —
  // a correção é estritamente local ao bloco de Saldo/Contagem/Diferença.
  assert.match(itemBody, /item\.quantity === 0 && !isCycleInventory \? 'is-zero '/)
  // Contado como zero agora é sempre persistido, também em 'initial'
  // (revisão desta mesma etapa) — a copy deixou de dizer "não será
  // persistida", já que passou a ser exatamente o contrário.
  assert.match(itemBody, /\{isCycleInventory \? 'Contado = 0\. Este produto será reconciliado com saldo zero\.' : 'Contado = 0\. Este produto fica registrado, mas não gera movimento de estoque\.'\}/)
  // 202609080005 acrescentou "&& !conflict" (não permite remover enquanto um
  // conflito de outro usuário está pendente) — isCycleInventory continua
  // sendo a condição principal, só ganhou um segundo termo.
  assert.match(itemBody, /\{isCycleInventory && !conflict && <button className="market-remove-counted"/)
})

// Os 4 cenários pedidos: initial/cycle × known/unknown.
test('4 cenários initial/cycle × known/unknown: gate produz exatamente o comportamento esperado', () => {
  const gate = (isCycleInventory, known) => isCycleInventory || known
  assert.equal(gate(true, true), true)   // cycle + conhecido -> mostra Saldo/Contagem/Diferença (comportamento atual mantido)
  assert.equal(gate(true, false), true)  // cycle + desconhecido -> mostra "Saldo não registrado" (comportamento atual mantido)
  assert.equal(gate(false, true), true)  // initial + conhecido -> AGORA mostra Saldo/Contagem/Diferença (correção)
  assert.equal(gate(false, false), false) // initial + desconhecido -> continua sem exibir nada (sem ruído em inventário inicial legítimo)
})
