// "Fechar inventário": sair da contagem sem finalizar, sem apagar o
// rascunho. Sem framework de DOM: valida por código-fonte, no mesmo padrão
// já usado para as demais telas de Market (purchase-ui-refresh.test.mjs).
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const src = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')

test('closeInventory existe, persiste o rascunho quando há alteração pendente e nunca finaliza/cancela/sai do módulo', () => {
  const body = src.match(/const closeInventory = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'closeInventory não encontrada')
  assert.match(body, /if \(dirtyRef\.current\)/, 'só tenta salvar quando há alteração local pendente — autosave já cuidou do resto')
  assert.match(body, /if \(!await persistDraft\(\)\) \{ setExitBlocked\('close'\); return \}/, 'reaproveita o mesmo persistDraft do autosave/leaveStock, sem lógica de salvar duplicada')
  assert.match(body, /setCounting\(false\); setConfirming\(false\)/, 'só sai da contagem — não muda o draft nem o rascunho salvo')
  assert.doesNotMatch(body, /finalizeMarketInventoryDraft|finalizeDraft\(/, 'não pode finalizar')
  assert.doesNotMatch(body, /cancelMarketInventoryDraft|cancelDraft\(/, 'não pode cancelar/apagar o rascunho')
  assert.doesNotMatch(body, /onBack\(\)/, 'não sai do módulo de Estoque — só sai da tela de contagem, permanece no local selecionado')
  assert.doesNotMatch(body, /setCurrentDraft\(null\)|setItems\(\[\]\)|itemsRef\.current = \[\]/, 'não pode apagar o draft nem os itens contados localmente')
})

test('botão "Fechar inventário" fica ao lado de "Finalizar inventário", chama closeInventory, e não confirma nada sozinho', () => {
  const finishBar = src.match(/<div className="market-inventory-finish">[\s\S]*?<\/div>(?=\s*:\s*<div className="market-inventory-confirm">)/)?.[0] ?? ''
  assert.ok(finishBar, 'barra market-inventory-finish não encontrada')
  assert.match(finishBar, />Fechar inventário</)
  assert.match(finishBar, />Finalizar inventário</)
  const closeButton = finishBar.match(/<button[^>]*onClick=\{\(\) => void closeInventory\(\)\}[^>]*>Fechar inventário<\/button>/)?.[0] ?? ''
  assert.ok(closeButton, 'botão Fechar inventário não chama closeInventory diretamente')
  assert.doesNotMatch(closeButton, /setConfirming\(true\)/, 'Fechar inventário não pode abrir a tela de confirmação de finalização')
})

test('aviso de "não foi possível salvar" retoma a ação certa (fechar vs sair do módulo) em "Tentar novamente"', () => {
  const warning = src.match(/\{exitBlocked && <div className="market-draft-warning"[\s\S]*?<\/div>\}/)?.[0] ?? ''
  assert.ok(warning, 'aviso exitBlocked não encontrado')
  assert.match(warning, /const pending = exitBlocked; setExitBlocked\(false\); void \(pending === 'close' \? closeInventory\(\) : leaveStock\(\)\)/)
})

test('leaveStock (voltar para Gestão do Mercado) continua marcando exitBlocked com o motivo certo, sem mudar de comportamento', () => {
  const body = src.match(/const leaveStock = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /setExitBlocked\('back'\)/)
  assert.match(body, /onBack\(\)/)
})

test('"Finalizar inventário" continua chamando setConfirming(true), sem nenhuma mudança de comportamento', () => {
  const finishBar = src.match(/<div className="market-inventory-finish">[\s\S]*?<\/div>(?=\s*:\s*<div className="market-inventory-confirm">)/)?.[0] ?? ''
  // 202609080003 acrescentou uncountedItems.length > 0 || itemsNeedingReason.length > 0
  // ao mesmo disabled (coberto por market-stock-counted-ui.test.mjs) — aqui só
  // confirma que as 3 condições originais e o onClick não foram removidos/alterados.
  assert.match(finishBar, /<button className="button" disabled=\{!countedItems\.length \|\| !startedAt \|\| saveState === 'conflict'[^}]*\} onClick=\{\(\) => setConfirming\(true\)\}>Finalizar inventário<\/button>/)
})

test('reabrir o rascunho depois de fechar sempre resincroniza items a partir do draft salvo (resumeDraft), sem depender de estado local antigo', () => {
  const body = src.match(/const resumeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /setItems\(draft\.items\); itemsRef\.current = draft\.items/)
})
