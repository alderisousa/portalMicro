// "Fechar inventário": sair da contagem sem finalizar, sem apagar o
// rascunho. Sem framework de DOM: valida por código-fonte, no mesmo padrão
// já usado para as demais telas de Market (purchase-ui-refresh.test.mjs).
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const src = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')

test('closeInventory existe, confirma cada item pendente antes de sair e nunca finaliza/cancela/sai do módulo', () => {
  const body = src.match(/const closeInventory = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'closeInventory não encontrada')
  // 202609080005: persistDraft (array completo) foi substituído por
  // commitDirtyItems (flush por item). Ajuste 2 (mesma etapa): conflito
  // pendente já conhecido nem tenta reenviar — sai direto para
  // 'close-conflict' sem chamar commitDirtyItems de novo (sem loop).
  assert.match(body, /if \(Object\.keys\(itemConflictsRef\.current\)\.length > 0\) \{ setExitBlocked\('close-conflict'\); focusConflictedItem\(\); return \}/, 'conflito já conhecido não deve gerar nova tentativa de rede')
  assert.match(body, /const flush = await commitDirtyItems\(\)/)
  assert.match(body, /if \(!flush\.ok\) \{ setExitBlocked\(flush\.hasConflict \? 'close-conflict' : 'close'\); if \(flush\.hasConflict\) focusConflictedItem\(\); return \}/)
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

test('aviso de falha genérica ("não foi possível salvar") retoma a ação certa (fechar vs sair do módulo) em "Tentar novamente"', () => {
  const warning = src.match(/\{\(exitBlocked === 'back' \|\| exitBlocked === 'close'\) && <div className="market-draft-warning"[\s\S]*?<\/div>\}/)?.[0] ?? ''
  assert.ok(warning, 'aviso exitBlocked (falha genérica) não encontrado')
  assert.match(warning, /const pending = exitBlocked; setExitBlocked\(false\); void \(pending === 'close' \? closeInventory\(\) : leaveStock\(\)\)/)
})

// Ajuste 2 (mesma etapa): conflito de item pendente é um aviso DISTINTO do
// de falha genérica — nunca oferece "Tentar novamente" (reenviaria a mesma
// disputa em loop), só aponta para o item destacado.
test('aviso de conflito pendente mostra mensagem específica e nunca reenvia sozinho (sem "Tentar novamente")', () => {
  const warning = src.match(/\{\(exitBlocked === 'back-conflict' \|\| exitBlocked === 'close-conflict'\) && <div className="market-draft-warning"[\s\S]*?<\/div>\}/)?.[0] ?? ''
  assert.ok(warning, 'aviso exitBlocked de conflito não encontrado')
  assert.match(warning, /Existe uma contagem em conflito\. Resolva o item destacado antes de sair do inventário\./)
  assert.match(warning, /focusConflictedItem\(\)/)
  assert.doesNotMatch(warning, /closeInventory\(\)|leaveStock\(\)/, 'não pode reenviar automaticamente o conflito — resolução é sempre manual')
})

test('leaveStock (voltar para Gestão do Mercado) continua marcando exitBlocked com o motivo certo — genérico ou conflito, sem mudar o destino final (onBack)', () => {
  const body = src.match(/const leaveStock = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /setExitBlocked\('back-conflict'\)/, 'conflito já conhecido: sai direto, sem tentar de novo')
  assert.match(body, /setExitBlocked\(flush\.hasConflict \? 'back-conflict' : 'back'\)/, 'conflito novo detectado durante o flush também vira back-conflict')
  assert.match(body, /onBack\(\)/)
})

test('"Finalizar inventário" continua com as mesmas 3 condições originais de disabled, agora sincronizando antes de confirmar', () => {
  const finishBar = src.match(/<div className="market-inventory-finish">[\s\S]*?<\/div>(?=\s*:\s*<div className="market-inventory-confirm">)/)?.[0] ?? ''
  // 202609080003/005 acrescentaram itemsNeedingReason/unresolvedConflictCount
  // ao mesmo disabled (cobertos por market-stock-counted-ui.test.mjs) — aqui só
  // confirma que as 3 condições originais não foram removidas/alteradas, e que
  // o onClick passou a sincronizar (syncDraftItems) antes de setConfirming(true).
  assert.match(finishBar, /<button className="button" disabled=\{!countedItems\.length \|\| !startedAt \|\| saveState === 'conflict'[^}]*\} onClick=\{\(\) => \{ void syncDraftItems\(\); setConfirming\(true\) \}\}>Finalizar inventário<\/button>/)
})

test('reabrir o rascunho depois de fechar sempre resincroniza items a partir do draft salvo (resumeDraft), sem depender de estado local antigo', () => {
  const body = src.match(/const resumeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  // 202609080004 (saneamento de motivo incoerente) insere um .map() entre a
  // leitura do draft e o setItems, mas a fonte continua sendo estritamente
  // draft.items — nunca items/itemsRef.current (estado local antigo).
  assert.match(body, /const nextItems = draft\.items\.map\(\(item\) => \{/)
  assert.doesNotMatch(body, /(?<!draft\.)items\.map\(/, 'não pode reaproveitar o estado local antigo (items) como fonte — só draft.items')
  assert.match(body, /itemsRef\.current = nextItems; setItems\(nextItems\)/)
})

// Último ajuste visual antes do fechamento: inventário finalizado por outro
// usuário mostrava a mesma mensagem duas vezes (alerta superior + mensagem
// dentro da área da conferência). saveState só chega a 'finalized-elsewhere'
// durante counting (performItemCommit/removeCountedProduct/resolveConflictUseMine/
// updateStartedAt/finalizeDraft), então o alerta superior era sempre
// redundante com a mensagem de market-inventory-empty — nunca cobria um
// caso a mais.
test('inventário finalizado por outro usuário: só a mensagem dentro da área da conferência aparece, alerta superior duplicado foi removido', () => {
  assert.doesNotMatch(src, /\{saveState === 'finalized-elsewhere' && <div className="market-draft-warning"/, 'alerta superior duplicado não pode mais existir')
  const conferenceMessage = src.match(/\{saveState === 'finalized-elsewhere' \? <div className="market-inventory-empty">([\s\S]*?)<\/div> : <>/)?.[0] ?? ''
  assert.ok(conferenceMessage, 'mensagem dentro da área da conferência não encontrada')
  assert.match(conferenceMessage, /Este inventário já foi finalizado por outro usuário\. Atualize para ver o estado atual\./)
  assert.match(conferenceMessage, /<button className="button button-small" onClick=\{\(\) => void load\(storeId\)\}>Atualizar<\/button>/)
  // Só um <p> renderizado com esta mensagem em toda a tela (a ocorrência em
  // finalizeDraft, linha ~747, é a mensagem de ERRO de uma tentativa de
  // finalizar que perdeu a corrida — cenário distinto, fora deste ajuste,
  // exibida em admin-message, não em market-draft-warning/market-inventory-empty).
  assert.equal((src.match(/<p>Este inventário já foi finalizado por outro usuário/g) ?? []).length, 1)
})
