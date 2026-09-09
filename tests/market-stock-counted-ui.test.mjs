// "Não contado" ≠ zero, motivo obrigatório de divergência: validação de
// código-fonte da tela de contagem (sem framework de DOM), mesmo padrão já
// usado em market-stock-inventory-exit.test.mjs. As regras de dados/backend
// são cobertas por market-stock-counted-reason.test.mjs (PGlite).
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
registerHooks({ resolve(s,c,n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s,c) } })
const { requiresDivergenceReason, isReasonMissing, isReasonCodeAllowedForDifference, reasonNeedsReset } = await import('../src/utils/marketStockBalance.ts')

const src = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')

test('requiresDivergenceReason: só exige motivo com saldo conhecido, item contado e diferença != 0 — nunca por inventoryType', () => {
  assert.equal(requiresDivergenceReason({ known: true, currentQuantity: 30, countedQuantity: 30, difference: 0 }, true), false, 'B: sem diferença não exige')
  assert.equal(requiresDivergenceReason({ known: true, currentQuantity: 30, countedQuantity: 27, difference: -3 }, true), true, 'C: falta exige')
  assert.equal(requiresDivergenceReason({ known: true, currentQuantity: 30, countedQuantity: 33, difference: 3 }, true), true, 'D: sobra exige')
  assert.equal(requiresDivergenceReason({ known: true, currentQuantity: 30, countedQuantity: 0, difference: -30 }, true), true, 'E: contado zero com saldo conhecido exige')
  assert.equal(requiresDivergenceReason({ known: true, currentQuantity: 0, countedQuantity: 5, difference: 5 }, true), true, 'F: saldo conhecido zero exige')
  assert.equal(requiresDivergenceReason({ known: false, currentQuantity: 0, countedQuantity: 10, difference: 10 }, true), false, 'G: saldo não registrado não exige')
  assert.equal(requiresDivergenceReason({ known: true, currentQuantity: 30, countedQuantity: 27, difference: -3 }, false), false, 'A: item não contado nunca exige motivo (bloqueado por outra regra)')
})

test('isReasonMissing: reasonCode sempre obrigatório quando exigido; reasonNote só obrigatório para OTHER', () => {
  assert.equal(isReasonMissing({ reasonCode: null, reasonNote: null }), true)
  assert.equal(isReasonMissing({ reasonCode: 'DAMAGE', reasonNote: null }), false)
  assert.equal(isReasonMissing({ reasonCode: 'OTHER', reasonNote: null }), true, 'H: OTHER sem observação bloqueia')
  assert.equal(isReasonMissing({ reasonCode: 'OTHER', reasonNote: '   ' }), true, 'H: observação só de espaços não conta')
  assert.equal(isReasonMissing({ reasonCode: 'OTHER', reasonNote: 'Achado em outra prateleira' }), false, 'I: OTHER com observação permite')
})

// Matriz aprovada (202609080004): OUT-only (EXPIRED_LOSS, DAMAGE, THEFT_LOSS,
// INTERNAL_USE), IN-only (UNREGISTERED_PURCHASE), BOTH (PREVIOUS_COUNT_ERROR,
// UNREGISTERED_TRANSFER, OTHER). Mesma matriz usada pela regra 5 da RPC —
// único lugar no frontend onde ela existe (reasonSignByCode).
test('isReasonCodeAllowedForDifference: motivo coerente com o sentido da diferença', () => {
  assert.equal(isReasonCodeAllowedForDifference('DAMAGE', 5), false, '+5 + DAMAGE (OUT-only) => inválido')
  assert.equal(isReasonCodeAllowedForDifference('DAMAGE', -5), true, '-5 + DAMAGE (OUT-only) => válido')
  assert.equal(isReasonCodeAllowedForDifference('EXPIRED_LOSS', 5), false)
  assert.equal(isReasonCodeAllowedForDifference('THEFT_LOSS', 5), false)
  assert.equal(isReasonCodeAllowedForDifference('INTERNAL_USE', 5), false)
  assert.equal(isReasonCodeAllowedForDifference('UNREGISTERED_PURCHASE', 5), true, '+5 + UNREGISTERED_PURCHASE (IN-only) => válido')
  assert.equal(isReasonCodeAllowedForDifference('UNREGISTERED_PURCHASE', -5), false, '-5 + UNREGISTERED_PURCHASE (IN-only) => inválido')
  for (const difference of [5, -5]) {
    assert.equal(isReasonCodeAllowedForDifference('PREVIOUS_COUNT_ERROR', difference), true, `PREVIOUS_COUNT_ERROR (${difference}) => válido nos dois sentidos`)
    assert.equal(isReasonCodeAllowedForDifference('UNREGISTERED_TRANSFER', difference), true, `UNREGISTERED_TRANSFER (${difference}) => válido nos dois sentidos`)
    assert.equal(isReasonCodeAllowedForDifference('OTHER', difference), true, `OTHER (${difference}) => válido nos dois sentidos`)
  }
  // Diferença 0 nunca é avaliada por esta função (quem decide se motivo é
  // exigido é requiresDivergenceReason/reasonNeedsReset).
  assert.equal(isReasonCodeAllowedForDifference('DAMAGE', 0), true)
})

test('reasonNeedsReset: limpa motivo quando diferença zera, quando fica incoerente com o novo sinal, e preserva quando continua coerente', () => {
  const known = (difference) => ({ known: true, currentQuantity: 30, countedQuantity: 30 + difference, difference })
  // Diferença 0: motivo salvo sempre é limpo, mesmo que fosse coerente antes.
  assert.equal(reasonNeedsReset('PREVIOUS_COUNT_ERROR', known(0), true), true, 'diferença 0 => motivo limpo, mesmo sendo BOTH')
  assert.equal(reasonNeedsReset('DAMAGE', known(0), true), true, 'diferença 0 => motivo limpo')
  assert.equal(reasonNeedsReset(null, known(0), true), false, 'sem motivo salvo, nada a limpar')
  // Flip de sinal com motivo incompatível para o novo sentido.
  assert.equal(reasonNeedsReset('DAMAGE', known(5), true), true, 'flip - para + com DAMAGE (OUT-only) => limpo')
  assert.equal(reasonNeedsReset('UNREGISTERED_PURCHASE', known(-5), true), true, 'flip + para - com UNREGISTERED_PURCHASE (IN-only) => limpo')
  // Flip de sinal mantendo um motivo BOTH — preserva.
  assert.equal(reasonNeedsReset('PREVIOUS_COUNT_ERROR', known(5), true), false, 'flip com motivo BOTH => preservado')
  assert.equal(reasonNeedsReset('PREVIOUS_COUNT_ERROR', known(-5), true), false, 'flip com motivo BOTH => preservado')
  // Compatível com o sinal atual — preserva (nem diferença 0, nem incoerente).
  assert.equal(reasonNeedsReset('DAMAGE', known(-5), true), false, 'motivo coerente com o sinal atual => preservado')
  assert.equal(reasonNeedsReset('UNREGISTERED_PURCHASE', known(5), true), false, 'motivo coerente com o sinal atual => preservado')
  // Sem contagem ou saldo desconhecido: nunca faz sentido manter motivo.
  assert.equal(reasonNeedsReset('DAMAGE', known(-5), false), true, 'item não contado => motivo limpo')
  assert.equal(reasonNeedsReset('DAMAGE', { known: false, currentQuantity: 0, countedQuantity: 5, difference: 5 }, true), true, 'saldo desconhecido => motivo limpo')
})

test('produto recém-incluído (selectProduct) entra "não contado", nunca com quantidade fixa — mesmo caminho para busca/EAN/SKU/scanner', () => {
  const body = src.match(/const selectProduct = \(product: MarketStockProduct, focusQuantity = false\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'selectProduct não encontrada')
  assert.match(body, /\{ productId: product\.id, quantity: 0, isCounted: false, reasonCode: null, reasonNote: null, version: null \}/)
  assert.doesNotMatch(body, /quantity: 1\b/, 'não pode mais entrar com quantidade fixa 1')
  // Único ponto de entrada: busca (changeSearch), EAN/SKU exato e scanner
  // (handleScannedCode) chamam todos selectProduct — nenhum caminho paralelo.
  assert.match(src, /const changeSearch = .*=> \{\s*\n\s*const exactProduct = findExactMarketStockProduct\(products \?\? \[\], value\)\s*\n\s*if \(exactProduct\) \{ selectProduct\(exactProduct, true\)/)
  assert.match(src, /const handleScannedCode = .*=> \{[\s\S]*?if \(exactProduct\) \{ selectProduct\(exactProduct, true\); return \}/)
  assert.match(src, /searchResults\.map\(\(product\) => <button key=\{product\.id\} type="button" onClick=\{\(\) => selectProduct\(product\)\}/)
})

test('digitar qualquer número, inclusive zero, marca isCounted=true; apagar o campo volta para não contado', () => {
  const updateQuantityBody = src.match(/const updateQuantity = \(productId: string, quantity: number\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(updateQuantityBody, /isCounted: true/)
  const clearQuantityBody = src.match(/const clearQuantity = \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(clearQuantityBody, /quantity: 0, isCounted: false/)
  const inputBlock = src.match(/<input aria-label=\{`Quantidade contada de \$\{product\.name\}`\}[\s\S]*?\/>/)?.[0] ?? ''
  assert.ok(inputBlock, 'input de quantidade não encontrado')
  assert.match(inputBlock, /value=\{item\.isCounted \? item\.quantity : ''\}/, 'campo precisa ficar vazio quando não contado')
  assert.match(inputBlock, /placeholder="—"/)
  assert.match(inputBlock, /if \(raw\.trim\(\) === ''\) clearQuantity\(item\.productId\)/)
})

test('updateQuantity reavalia o motivo contra a NOVA quantidade e limpa via reasonNeedsReset (nunca deixa motivo incoerente "em espera")', () => {
  const updateQuantityBody = src.match(/const updateQuantity = \(productId: string, quantity: number\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(updateQuantityBody, /const comparison = compareStockCount\(balanceByProduct, productId, safeQuantity\)/)
  assert.match(updateQuantityBody, /const resetReason = reasonNeedsReset\(item\.reasonCode, comparison, true\)/)
  assert.match(updateQuantityBody, /reasonCode: resetReason \? null : item\.reasonCode, reasonNote: resetReason \? null : item\.reasonNote/)
})

test('clearQuantity (campo apagado) sempre limpa reasonCode/reasonNote junto — sem contagem não há divergência a justificar', () => {
  const clearQuantityBody = src.match(/const clearQuantity = \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(clearQuantityBody, /quantity: 0, isCounted: false, reasonCode: null, reasonNote: null/)
})

test('resumeDraft saneia o rascunho retomado com reasonNeedsReset e persiste a correção item a item (202609080005)', () => {
  const resumeDraftBody = src.match(/const resumeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(resumeDraftBody, /const comparison = compareStockCount\(balanceByProduct, item\.productId, item\.quantity\)/)
  assert.match(resumeDraftBody, /if \(!reasonNeedsReset\(item\.reasonCode, comparison, item\.isCounted\)\) return item/)
  assert.match(resumeDraftBody, /return \{ \.\.\.item, reasonCode: null, reasonNote: null \}/)
  // A limpeza precisa ser persistida — não fica só local: cada produto
  // saneado é marcado dirty e commitado individualmente (sem autosave global,
  // que não existe mais depois da persistência por item).
  assert.match(resumeDraftBody, /sanitizedProductIds\.forEach\(markItemDirty\)/)
  assert.match(resumeDraftBody, /void Promise\.all\(sanitizedProductIds\.map\(\(id\) => commitItem\(id\)\)\)/)
})

test('+ em item não contado inicia em 1 e marca contado; − fica desabilitado (decisão documentada)', () => {
  const stepperBlock = src.match(/<div className="market-quantity-stepper">([\s\S]*?)<\/div>/)?.[0] ?? ''
  assert.ok(stepperBlock, 'stepper de quantidade não encontrado')
  assert.match(stepperBlock, /onClick=\{\(\) => updateQuantity\(item\.productId, \(item\.isCounted \? item\.quantity : 0\) \+ 1\)\}/, '+ precisa iniciar em 1 quando ainda não contado (0 + 1)')
  // 202609080005 acrescentou "|| Boolean(conflict)" (desabilita durante um
  // conflito de outro usuário pendente de resolução) — !item.isCounted
  // continua sendo a condição original.
  assert.match(stepperBlock, /disabled=\{!item\.isCounted \|\| Boolean\(conflict\)\}/, '− precisa ficar desabilitado quando ainda não contado (ou em conflito)')
})

test('linha de comparação mostra "Contagem —"/"Diferença —" quando não contado, incluindo saldo desconhecido + contado (cenário G)', () => {
  const itemMapBody = src.match(/const comparison = compareStockCount\(balanceByProduct, item\.productId, item\.quantity\)([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.ok(itemMapBody, 'bloco de renderização do item não encontrado')
  assert.match(itemMapBody, /const countedLabel = item\.isCounted \? number\.format\(comparison\.countedQuantity\) : '—'/)
  assert.match(itemMapBody, /const showDifference = item\.isCounted && comparison\.known/)
  assert.match(itemMapBody, /const differenceLabel = showDifference \? [\s\S]*? : '—'/)
  assert.match(itemMapBody, /Saldo \{balanceLabel\} · Contagem \{countedLabel\} · <b className=\{differenceClass\}>Diferença \{differenceLabel\}<\/b>/)
})

test('seletor de motivo aparece só quando requiresDivergenceReason é verdadeiro; campo de observação só para OTHER', () => {
  const itemMapBody = src.match(/const needsReason = requiresDivergenceReason\(comparison, item\.isCounted\)([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.ok(itemMapBody, 'bloco needsReason não encontrado')
  // 202609080005 acrescentou "&& !conflict" (esconde o seletor enquanto um
  // conflito de outro usuário está pendente de resolução).
  assert.match(itemMapBody, /\{needsReason && !conflict && <div className="market-stock-reason">/)
  assert.match(itemMapBody, /\{item\.reasonCode === 'OTHER' && <label>Observação/)
  assert.match(itemMapBody, /updateReasonCode\(item\.productId, \(event\.target\.value \|\| null\) as MarketInventoryReasonCode \| null\)/)
})

test('opções do seletor de motivo são filtradas pelo sentido da diferença (isReasonCodeAllowedForDifference) — nunca as 8 sem filtro', () => {
  const itemMapBody = src.match(/const needsReason = requiresDivergenceReason\(comparison, item\.isCounted\)([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.ok(itemMapBody, 'bloco needsReason não encontrado')
  assert.match(itemMapBody, /\{reasonCodes\.filter\(\(code\) => isReasonCodeAllowedForDifference\(code, comparison\.difference\)\)\.map\(\(code\) => <option/)
})

test('regra 3/4/5 e conflitos pendentes bloqueiam "Finalizar inventário" no frontend, com mensagem clara — e também são revalidadas no backend (defesa em profundidade)', () => {
  // 202609080005: onClick passou a sincronizar antes de confirmar (syncDraftItems).
  const finishButtonBlock = src.match(/<button className="button" disabled=\{[^}]*\} onClick=\{\(\) => \{ void syncDraftItems\(\); setConfirming\(true\) \}\}>Finalizar inventário<\/button>/)?.[0] ?? ''
  assert.ok(finishButtonBlock, 'botão Finalizar inventário não encontrado')
  assert.match(finishButtonBlock, /uncountedItems\.length > 0/)
  assert.match(finishButtonBlock, /itemsNeedingReason\.length > 0/)
  assert.match(finishButtonBlock, /unresolvedConflictCount > 0/, '202609080005: conflito de item pendente também bloqueia a finalização')
  assert.match(src, /Ainda existem produtos sem contagem informada\./)
  assert.match(src, /Existem divergências de saldo sem motivo informado\./)
  assert.match(src, /Existem divergências de contagem com outro usuário ainda não resolvidas\./)
  // Defesa em profundidade: catch de finalizeDraft mapeia os códigos da RPC.
  const finalizeDraftBody = src.match(/const finalizeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(finalizeDraftBody, /INVENTORY_UNCOUNTED_ITEMS/)
  assert.match(finalizeDraftBody, /INVENTORY_REASON_REQUIRED/)
})

test('INVENTORY_REASON_SIGN_MISMATCH (202609080004) é mapeado para mensagem amigável no catch de finalizeDraft — defesa em profundidade contra payload manipulado/frontend antigo', () => {
  const finalizeDraftBody = src.match(/const finalizeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(finalizeDraftBody, /INVENTORY_REASON_SIGN_MISMATCH/)
  assert.match(finalizeDraftBody, /Existem motivos de divergência incompatíveis com o sentido do ajuste/)
})

test('uncountedItems/itemsNeedingReason nunca contam item de outra origem — mesma fonte (balanceByProduct) usada por compareStockCount', () => {
  const body = src.match(/const uncountedItems = items\.filter\(\(item\) => !item\.isCounted\)/)?.[0] ?? ''
  assert.ok(body)
  const reasonBody = src.match(/const itemsNeedingReason = items\.filter\(\(item\) =>\s*\n\s*item\.isCounted && requiresDivergenceReason\(compareStockCount\(balanceByProduct, item\.productId, item\.quantity\), item\.isCounted\) && isReasonMissing\(item\)\)/)?.[0] ?? ''
  assert.ok(reasonBody, 'itemsNeedingReason não usa a mesma fonte/critério esperado')
})

test('countedItems exclui item não contado em qualquer tipo de sessão (initial ou cycle)', () => {
  assert.match(src, /const countedItems = \(isCycleInventory \? items : positiveItems\)\.filter\(\(item\) => item\.isCounted\)/)
})

test('compareStockCount não foi alterado por esta tarefa', () => {
  const utilSrc = readFileSync(new URL('../src/utils/marketStockBalance.ts', import.meta.url), 'utf8')
  assert.match(utilSrc, /export function compareStockCount\(balanceByProduct: Map<string, number>, productId: string, countedQuantity: number\): StockCountComparison \{\s*\n\s*const known = balanceByProduct\.has\(productId\)\s*\n\s*const currentQuantity = balanceByProduct\.get\(productId\) \?\? 0\s*\n\s*return \{ known, currentQuantity, countedQuantity, difference: countedQuantity - currentQuantity \}\s*\n\}/)
})

test('gate de saldo (isCycleInventory || comparison.known) não foi alterado por esta tarefa', () => {
  assert.match(src, /\{\(isCycleInventory \|\| comparison\.known\) && <span className="market-stock-comparison">/)
})

// 202609080005: substitui o teste anterior (que verificava o array completo
// via persistDraft) — essa era exatamente a substituição total que o
// inventário multiusuário eliminou de propósito. Agora cada item é
// persistido individualmente (saveMarketInventoryItem), e
// saveMarketInventoryDraft só é chamada com array vazio (escopo de sessão).
test('itens são persistidos individualmente (saveMarketInventoryItem), nunca mais como array completo', () => {
  assert.doesNotMatch(src, /saveMarketInventoryDraft\([^)]*itemsRef\.current/, 'não pode voltar a enviar o array completo de itens')
  // A lógica de envio em si é performItemCommit — commitItem (nome mantido
  // para quem chama) virou um wrapper que serializa por productId antes de
  // delegar a ela (correção do "conflito artificial contra si mesmo").
  const commitItemBody = src.match(/const performItemCommit = useCallback\(async \(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> => \{([\s\S]*?)\n {2}\}, \[syncDraftItems\]\)/)?.[0] ?? ''
  assert.ok(commitItemBody, 'performItemCommit não encontrada')
  assert.match(commitItemBody, /saveMarketInventoryItem\(\s*\n\s*draftRef\.current\.id, productId, localItem\.quantity, localItem\.isCounted,\s*\n\s*localItem\.reasonCode, localItem\.reasonNote, expectedVersion,\s*\n\s*\)/)
  const startDraftBody = src.match(/const startDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(startDraftBody, /saveMarketInventoryDraft\(selectedStore\.id, null, null, new Date\(nextStartedAt\)\.toISOString\(\), \[\]\)/, 'criação de sessão continua sem itens')
})

test('inventário/finalização de Compras e Transferências não foram tocados (arquivos fora do escopo desta tarefa)', () => {
  const purchasesSrc = readFileSync(new URL('../src/pages/MarketPurchases.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(purchasesSrc, /isCounted|reasonCode|reasonNote/)
})

// Fechamento da Sprint — item 1: "Novo inventário" quando já existe draft
// (outra tela/dispositivo criou o rascunho enquanto esta ainda não sabia).
// A proteção backend (unique_violation -> INVENTORY_DRAFT_CONFLICT) não é
// alterada — só o que a UI faz quando ela dispara.
test('startDraft: conflito de rascunho já ativo (INVENTORY_DRAFT_CONFLICT) carrega e entra automaticamente no draft existente, sem pedir reload nem exigir outro clique', () => {
  assert.match(src, /const isDraftAlreadyActive = \(cause: unknown\) => typeof cause === 'object' && cause && 'message' in cause\s*\n\s*&& String\(cause\.message\)\.includes\('INVENTORY_DRAFT_CONFLICT'\)/)
  const startDraftBody = src.match(/const startDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(startDraftBody, /if \(isDraftAlreadyActive\(cause\)\) \{/)
  assert.match(startDraftBody, /const existing = await getMarketInventoryDraft\(accountId, selectedStore\.id\)/)
  assert.match(startDraftBody, /setCurrentDraft\(existing\); itemsRef\.current = nextItems; setItems\(nextItems\)/)
  assert.match(startDraftBody, /setSaveState\('saved'\); setCounting\(true\)/, 'precisa entrar na contagem automaticamente, sem exigir outro clique')
  // Nunca mais pede para recarregar manualmente — mensagem antiga removida.
  assert.doesNotMatch(src, /Já existe um inventário em andamento neste local\. Recarregue para continuar\./)
})

test('startDraft limpa mensagens antigas de sucesso/erro ao começar, para não deixar aviso de um estado que já não é mais o atual', () => {
  const startDraftBody = src.match(/const startDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(startDraftBody, /setSaving\(true\); setError\(''\); setSuccess\(''\)/)
})

test('startDraft (fallback real, sem draft ativo) continua mostrando erro genérico — a proteção contra dois rascunhos ativos não foi enfraquecida', () => {
  const startDraftBody = src.match(/const startDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(startDraftBody, /setError\('Não foi possível iniciar o inventário\.'\)/)
})
