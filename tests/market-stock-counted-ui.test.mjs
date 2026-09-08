// "Não contado" ≠ zero, motivo obrigatório de divergência: validação de
// código-fonte da tela de contagem (sem framework de DOM), mesmo padrão já
// usado em market-stock-inventory-exit.test.mjs. As regras de dados/backend
// são cobertas por market-stock-counted-reason.test.mjs (PGlite).
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
registerHooks({ resolve(s,c,n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s,c) } })
const { requiresDivergenceReason, isReasonMissing } = await import('../src/utils/marketStockBalance.ts')

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

test('produto recém-incluído (selectProduct) entra "não contado", nunca com quantidade fixa — mesmo caminho para busca/EAN/SKU/scanner', () => {
  const body = src.match(/const selectProduct = \(product: MarketStockProduct, focusQuantity = false\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'selectProduct não encontrada')
  assert.match(body, /\{ productId: product\.id, quantity: 0, isCounted: false, reasonCode: null, reasonNote: null \}/)
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

test('+ em item não contado inicia em 1 e marca contado; − fica desabilitado (decisão documentada)', () => {
  const stepperBlock = src.match(/<div className="market-quantity-stepper">([\s\S]*?)<\/div>/)?.[0] ?? ''
  assert.ok(stepperBlock, 'stepper de quantidade não encontrado')
  assert.match(stepperBlock, /onClick=\{\(\) => updateQuantity\(item\.productId, \(item\.isCounted \? item\.quantity : 0\) \+ 1\)\}/, '+ precisa iniciar em 1 quando ainda não contado (0 + 1)')
  assert.match(stepperBlock, /disabled=\{!item\.isCounted\}/, '− precisa ficar desabilitado quando ainda não contado')
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
  assert.match(itemMapBody, /\{needsReason && <div className="market-stock-reason">/)
  assert.match(itemMapBody, /\{item\.reasonCode === 'OTHER' && <label>Observação/)
  assert.match(itemMapBody, /updateReasonCode\(item\.productId, \(event\.target\.value \|\| null\) as MarketInventoryReasonCode \| null\)/)
})

test('regra 3/4 bloqueiam "Finalizar inventário" no frontend, com mensagem clara — e também são revalidadas no backend (defesa em profundidade)', () => {
  const finishButtonBlock = src.match(/<button className="button" disabled=\{[^}]*\} onClick=\{\(\) => setConfirming\(true\)\}>Finalizar inventário<\/button>/)?.[0] ?? ''
  assert.ok(finishButtonBlock, 'botão Finalizar inventário não encontrado')
  assert.match(finishButtonBlock, /uncountedItems\.length > 0/)
  assert.match(finishButtonBlock, /itemsNeedingReason\.length > 0/)
  assert.match(src, /Ainda existem produtos sem contagem informada\./)
  assert.match(src, /Existem divergências de saldo sem motivo informado\./)
  // Defesa em profundidade: catch de finalizeDraft mapeia os códigos da RPC.
  const finalizeDraftBody = src.match(/const finalizeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(finalizeDraftBody, /INVENTORY_UNCOUNTED_ITEMS/)
  assert.match(finalizeDraftBody, /INVENTORY_REASON_REQUIRED/)
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

test('autosave/persistDraft continuam enviando o array completo de items (is_counted/reasonCode/reasonNote propagam via o mesmo payload, sem lógica nova de serialização)', () => {
  const persistDraftBody = src.match(/const persistDraft = useCallback\(async \(\): Promise<boolean> => \{([\s\S]*?)\n {2}\}, \[saveState\]\)/)?.[0] ?? ''
  assert.match(persistDraftBody, /saveMarketInventoryDraft\(\s*\n\s*currentDraft\.marketStoreId, currentDraft\.id, currentDraft\.version,\s*\n\s*new Date\(startedAtRef\.current\)\.toISOString\(\), itemsRef\.current,\s*\n\s*\)/)
})

test('inventário/finalização de Compras e Transferências não foram tocados (arquivos fora do escopo desta tarefa)', () => {
  const purchasesSrc = readFileSync(new URL('../src/pages/MarketPurchases.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(purchasesSrc, /isCounted|reasonCode|reasonNote/)
})
