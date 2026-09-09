// Resolução MANUAL de conflito por item (202609080005) — validação de
// código-fonte da tela de contagem, sem framework de DOM, mesmo padrão já
// usado em market-stock-counted-ui.test.mjs/market-stock-inventory-exit.test.mjs.
// As regras de dados/backend (version por item, insert/update/delete
// atômicos) são cobertas por market-stock-item-concurrency.test.mjs (PGlite).
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
registerHooks({ resolve(s, c, n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s, c) } })
const {
  mergeDraftItems, applyItemSaveResponse, runSerializedByKey,
  sortItemsByRecency, seedItemOrder, detectServerUpdatedProductIds,
} = await import('../src/utils/marketStockBalance.ts')

const src = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')

const item = (productId, over = {}) => ({ productId, quantity: 1, isCounted: true, reasonCode: null, reasonNote: null, version: 1, ...over })

// Promise controlável manualmente — permite montar exatamente a corrida
// "task1 ainda em voo quando task2 é solicitada" sem depender de timers.
const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('mergeDraftItems: item local ainda não salvo (dirty) nunca é sobrescrito pelo servidor', () => {
  const local = [item('p1', { quantity: 99 })]
  const server = [item('p1', { quantity: 5, version: 4 })]
  const merged = mergeDraftItems(local, server, new Set(['p1']))
  assert.deepEqual(merged, [item('p1', { quantity: 99 })], 'dirty local prevalece sobre o servidor')
})

test('mergeDraftItems: item não-dirty é atualizado para o valor do servidor (produto salvo por outro usuário)', () => {
  const local = [item('p1', { quantity: 1, version: 1 })]
  const server = [item('p1', { quantity: 7, version: 2 }), item('p2', { quantity: 3, version: 1 })]
  const merged = mergeDraftItems(local, server, new Set())
  assert.deepEqual(merged, [item('p1', { quantity: 7, version: 2 }), item('p2', { quantity: 3, version: 1 })])
})

test('mergeDraftItems: item local ainda não persistido (nunca esteve no servidor) sempre sobrevive ao merge', () => {
  const local = [item('novo', { version: null, isCounted: false, quantity: 0 })]
  const server = [item('p1')]
  const merged = mergeDraftItems(local, server, new Set())
  assert.ok(merged.some((i) => i.productId === 'novo'), 'item local-only nunca é descartado pela sincronização')
  assert.ok(merged.some((i) => i.productId === 'p1'))
})

// ===================================================================
// REGRESSÃO — bloqueio da auditoria final: lost update quando o próprio
// operador edita o MESMO item de novo enquanto um save anterior daquele
// item ainda está em voo. applyItemSaveResponse é o núcleo da correção
// (usado por commitItem em MarketStockDashboard.tsx) — testado aqui
// diretamente, com o cenário exato descrito no bug, não apenas por
// regex sobre o código-fonte.
// ===================================================================

test('corrida completa (quantity): X=10/version=1 enviado -> editado para 12 em voo -> resposta antiga (quantity=10,version=2) preserva 12 e NÃO limpa dirty -> próximo commit com quantity=12/version=2 finalmente limpa dirty', () => {
  // 1) estado inicial X version=1; 2) usuário altera para 10; 3) commit #1
  // começa — o que foi ENVIADO foi quantity=10 (não usado diretamente por
  // applyItemSaveResponse, que só olha o item ATUAL e a version devolvida).
  // 4) antes da resposta, usuário altera para 12 — é isso que já está em
  // itemsRef.current quando a resposta chega:
  const currentAfterSecondEdit = item('X', { quantity: 12, version: 1 })

  // 5) commit #1 retorna sucesso com version=2 (só reflete que quantity=10
  // foi persistido no servidor) e supersededBySelf=true (a revisão local
  // mudou entre o envio e a resposta — é o operador editando de novo, não
  // conflito com outro usuário).
  const afterStaleResponse = applyItemSaveResponse(currentAfterSecondEdit, 2, true)

  // 6) confirmar: local continua mostrando 12; version/base vira 2; dirty
  // NÃO é limpo (clearDirty=false, quem chama decide manter o item dirty).
  assert.equal(afterStaleResponse.item.quantity, 12, 'a edição mais nova (12) nunca pode ser substituída pelo que a resposta antiga enviou (10)')
  assert.equal(afterStaleResponse.item.version, 2, 'a version devolvida pelo servidor é válida e precisa virar a nova base local')
  assert.equal(afterStaleResponse.clearDirty, false, 'resposta superada nunca limpa o dirty — o item continua pendente para o próximo commit')

  // 7) próximo commit envia quantity=12 usando version=2 (a base que a
  // correção deixou pronta) — 8) servidor aceita e devolve version=3;
  // supersededBySelf=false porque nada mudou depois deste segundo envio.
  const afterSecondCommit = applyItemSaveResponse(afterStaleResponse.item, 3, false)

  // 9) dirty finalmente limpo; 10) estado final servidor/local = 12.
  assert.equal(afterSecondCommit.item.quantity, 12)
  assert.equal(afterSecondCommit.item.version, 3)
  assert.equal(afterSecondCommit.clearDirty, true, 'quando nada mudou desde o envio, a resposta limpa o dirty normalmente')
})

test('corrida completa (reasonCode/reasonNote): edição de motivo em voo também é preservada, não só quantity', () => {
  // Mesma corrida, mas a edição concorrente troca o motivo da divergência
  // (reasonCode/reasonNote), não a quantidade — a proteção não pode ficar
  // limitada a um campo específico.
  const sentWithDamage = item('Y', { quantity: 5, reasonCode: 'DAMAGE', reasonNote: null, version: 3 })
  // Enquanto o save de "DAMAGE" estava em voo, o operador trocou para OTHER
  // com observação (ex.: percebeu que o motivo certo era outro):
  const editedDuringFlight = { ...sentWithDamage, reasonCode: 'OTHER', reasonNote: 'Achado em outra prateleira' }

  const afterStaleResponse = applyItemSaveResponse(editedDuringFlight, 4, true)
  assert.equal(afterStaleResponse.item.reasonCode, 'OTHER', 'motivo editado durante o request em voo não pode ser revertido para o que foi enviado (DAMAGE)')
  assert.equal(afterStaleResponse.item.reasonNote, 'Achado em outra prateleira')
  assert.equal(afterStaleResponse.item.version, 4)
  assert.equal(afterStaleResponse.clearDirty, false)

  // Próximo commit, agora sem nenhuma edição concorrente: aplica normalmente.
  const afterNextCommit = applyItemSaveResponse(afterStaleResponse.item, 5, false)
  assert.equal(afterNextCommit.item.reasonCode, 'OTHER')
  assert.equal(afterNextCommit.clearDirty, true)
})

test('sem corrida (supersededBySelf=false): comportamento de sucesso comum não muda — limpa dirty e aplica a version nova', () => {
  const current = item('Z', { quantity: 8, version: 6 })
  const applied = applyItemSaveResponse(current, 7, false)
  assert.deepEqual(applied, { item: { ...current, version: 7 }, clearDirty: true })
})

test('isCounted editado em voo (ex.: campo apagado -> volta a "não contado") também é preservado', () => {
  const sentCounted = item('W', { quantity: 10, isCounted: true, version: 2 })
  const editedDuringFlight = { ...sentCounted, quantity: 0, isCounted: false }
  const afterStaleResponse = applyItemSaveResponse(editedDuringFlight, 3, true)
  assert.equal(afterStaleResponse.item.isCounted, false)
  assert.equal(afterStaleResponse.item.quantity, 0)
  assert.equal(afterStaleResponse.clearDirty, false)
})

// ===================================================================
// REGRESSÃO — último risco técnico da correção anterior: duas chamadas
// commitItem para o MESMO productId podiam ficar em voo ao mesmo tempo,
// cada uma com a mesma version, e a segunda recebia um "conflito" que na
// verdade era o operador/navegador disputando consigo mesmo. runSerializedByKey
// é o mecanismo de serialização por chave (usado por commitItem com
// key=productId) — testado aqui diretamente, com promises controláveis,
// não apenas por regex sobre o código-fonte.
// ===================================================================

test('1) duas chamadas rápidas para a MESMA chave nunca rodam a task simultaneamente — a segunda só começa depois que a primeira termina', async () => {
  const inFlight = {}
  const order = []
  const first = deferred()
  const p1 = runSerializedByKey(inFlight, 'X', () => {
    order.push('task1-start')
    return first.promise.then(() => { order.push('task1-end'); return 'r1' })
  })
  const p2 = runSerializedByKey(inFlight, 'X', () => {
    order.push('task2-start')
    return Promise.resolve('r2')
  })
  await Promise.resolve() // deixa as microtasks já agendadas rodarem
  assert.deepEqual(order, ['task1-start'], 'a segunda chamada não pode nem começar enquanto a primeira ainda está em voo — nunca dois requests simultâneos com a mesma version')
  first.resolve()
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1, 'r1'); assert.equal(r2, 'r2')
  assert.deepEqual(order, ['task1-start', 'task1-end', 'task2-start'], 'task2 só inicia depois que task1 termina — nunca em paralelo')
})

test('6) chaves diferentes nunca se bloqueiam entre si — Y roda e termina mesmo com X ainda em voo (produtos diferentes continuam independentes)', async () => {
  const inFlight = {}
  const order = []
  const xDone = deferred()
  const px = runSerializedByKey(inFlight, 'X', () => {
    order.push('x-start')
    return xDone.promise.then(() => { order.push('x-end'); return 'x' })
  })
  const py = runSerializedByKey(inFlight, 'Y', () => {
    order.push('y-start')
    return Promise.resolve('y')
  })
  assert.equal(await py, 'y', 'Y não precisa esperar X para resolver')
  assert.ok(order.includes('y-start') && !order.includes('x-end'), 'Y roda e termina completamente antes de X terminar — save de X não bloqueia save de Y')
  xDone.resolve()
  assert.equal(await px, 'x')
})

test('7) uma segunda chamada composta com Promise.all (equivalente a commitDirtyItems) aguarda corretamente a fila da mesma chave, sem descartar a chamada mais nova', async () => {
  const inFlight = {}
  let callCount = 0
  const slow = deferred()
  const task = () => {
    callCount += 1
    return callCount === 1 ? slow.promise.then(() => 'first') : Promise.resolve('second')
  }
  // Simula commitDirtyItems tentando de novo um item que já está sendo
  // salvo por outro gatilho — nunca considera "em voo" equivalente a
  // "salvo": a segunda chamada realmente roda depois, não é descartada.
  const p1 = runSerializedByKey(inFlight, 'X', task)
  const p2 = runSerializedByKey(inFlight, 'X', task)
  slow.resolve()
  assert.deepEqual(await Promise.all([p1, p2]), ['first', 'second'])
  assert.equal(callCount, 2, 'a segunda chamada realmente executa — só espera a primeira terminar, nunca é descartada')
})

test('erro na primeira chamada de uma chave não impede a segunda de rodar (fila continua mesmo se um commit falhar)', async () => {
  const inFlight = {}
  const p1 = runSerializedByKey(inFlight, 'X', () => Promise.reject(new Error('falhou')))
  const p2 = runSerializedByKey(inFlight, 'X', () => Promise.resolve('ok'))
  await assert.rejects(p1, /falhou/)
  assert.equal(await p2, 'ok')
})

test('registro em inFlight é limpo depois que a fila da chave termina (não vaza memória por produto)', async () => {
  const inFlight = {}
  await runSerializedByKey(inFlight, 'X', () => Promise.resolve('ok'))
  assert.equal(inFlight.X, undefined)
})

test('commitItem serializa por productId via runSerializedByKey + inFlightCommitRef, delegando a performItemCommit (não reimplementa a fila inline)', () => {
  assert.match(src, /const inFlightCommitRef = useRef<Record<string, Promise<ItemCommitOutcome>>>\(\{\}\)/)
  assert.match(src, /const commitItem = useCallback\(\(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> =>\s*\n\s*runSerializedByKey\(inFlightCommitRef\.current, productId, \(\) => performItemCommit\(productId, expectedVersionOverride\)\),\s*\n\s*\[performItemCommit\]\)/)
})

test('commitItem: unidade de concorrência é o produto — usa saveMarketInventoryItem, nunca reintroduz o array completo', () => {
  const commitItemBody = src.match(/const performItemCommit = useCallback\(async \(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> => \{([\s\S]*?)\n {2}\}, \[syncDraftItems\]\)/)?.[0] ?? ''
  assert.ok(commitItemBody, 'commitItem não encontrada')
  assert.match(commitItemBody, /const expectedVersion = overriding \? expectedVersionOverride : localItem\.version/)
  assert.match(commitItemBody, /if \(result\.conflict\) \{/)
  assert.match(commitItemBody, /setItemConflicts\(\(prev\) => \(\{ \.\.\.prev, \[productId\]: \{ productId, action: 'save', localItem, serverItem: result\.serverItem \} \}\)\)/)
})

// Correção do bloqueio da auditoria final: commitItem precisa realmente
// delegar a decisão pós-sucesso para applyItemSaveResponse (testada acima
// com o cenário completo da corrida), nunca reimplementar a lógica inline
// de um jeito que possa esquecer o caso supersededBySelf.
test('commitItem usa itemRevisionRef (não o dirty set) para detectar edição concorrente do próprio operador, e delega a applyItemSaveResponse', () => {
  assert.match(src, /const itemRevisionRef = useRef<Record<string, number>>\(\{\}\)/)
  const markItemDirtyBody = src.match(/const markItemDirty = \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(markItemDirtyBody, /itemRevisionRef\.current\[productId\] = \(itemRevisionRef\.current\[productId\] \?\? 0\) \+ 1/, 'toda edição real precisa incrementar a revisão do item')

  const commitItemBody = src.match(/const performItemCommit = useCallback\(async \(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> => \{([\s\S]*?)\n {2}\}, \[syncDraftItems\]\)/)?.[0] ?? ''
  assert.match(commitItemBody, /const revisionAtSend = itemRevisionRef\.current\[productId\] \?\? 0/, 'a revisão precisa ser capturada ANTES do await, no momento do envio')
  assert.match(commitItemBody, /const supersededBySelf = \(itemRevisionRef\.current\[productId\] \?\? 0\) !== revisionAtSend/)
  assert.match(commitItemBody, /const currentItem = itemsRef\.current\.find\(\(item\) => item\.productId === productId\) \?\? localItem/, 'precisa partir do item ATUAL, não do snapshot enviado')
  assert.match(commitItemBody, /const applied = applyItemSaveResponse\(currentItem, result\.item\.version, supersededBySelf\)/)
  assert.match(commitItemBody, /if \(!applied\.clearDirty\) \{/)
  assert.match(commitItemBody, /return 'superseded'/)
  // Quando supersededBySelf, NUNCA pode chamar dirtyItemIdsRef.current.delete
  // nem retornar 'saved' — isso é exatamente o bug original.
  const supersededBranch = commitItemBody.match(/if \(!applied\.clearDirty\) \{([\s\S]*?)\n {6}\}/)?.[0] ?? ''
  assert.ok(supersededBranch, 'ramo de resposta superada não encontrado')
  assert.doesNotMatch(supersededBranch, /dirtyItemIdsRef\.current\.delete/, 'resposta superada nunca pode limpar o dirty')
  assert.doesNotMatch(supersededBranch, /return 'saved'/, 'resposta superada nunca pode ser reportada como salva')
})

test('6/8) "Usar minha contagem" reaplica a edição local com a version atual do servidor como base — nova alteração concorrente é detectada de novo pelo mesmo commitItem, nunca sobrescreve silenciosamente', () => {
  const body = src.match(/const resolveConflictUseMine = async \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'resolveConflictUseMine não encontrada')
  assert.match(body, /const baseVersion = conflict\.serverItem \? conflict\.serverItem\.version : null/, 'usa a version atual do servidor, não a que gerou o conflito original')
  // action 'save': delega inteiramente a commitItem (mesmo caminho de sempre) —
  // se houver outra mudança concorrente antes desta resolução, commitItem
  // detecta de novo e substitui itemConflicts pelo snapshot mais recente,
  // sem lógica de conflito duplicada aqui.
  assert.match(body, /void commitItem\(productId, baseVersion\)/)
  // action 'remove': reaplica a remoção (não uma atualização) com a mesma base.
  assert.match(body, /await removeMarketInventoryItem\(draftRef\.current!\.id, productId, baseVersion\)/)
})

test('7) "Usar contagem salva" adota o item do servidor SÓ para este produto, sem chamada de rede e sem tocar em outros itens', () => {
  const body = src.match(/const resolveConflictUseServer = \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'resolveConflictUseServer não encontrada')
  assert.doesNotMatch(body, /await /, 'não deve fazer nenhuma chamada de rede — o servidor já é a fonte autoritativa')
  assert.match(body, /const next = itemsRef\.current\.map\(\(item\) => item\.productId === productId \? serverItem : item\)/, 'só troca o item deste productId, todos os outros permanecem intocados')
  assert.match(body, /if \(!conflict\.serverItem\) \{/, 'serverItem null (removido por outro usuário) remove o item local também')
})

test('conflito pendente desabilita edição do item (quantidade e motivo) até ser resolvido manualmente', () => {
  const itemMapBody = src.match(/const conflict = itemConflicts\[item\.productId\]([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.ok(itemMapBody, 'bloco de renderização do item não encontrado')
  assert.match(itemMapBody, /disabled=\{!item\.isCounted \|\| Boolean\(conflict\)\}/)
  assert.match(itemMapBody, /disabled=\{Boolean\(conflict\)\}/)
  assert.match(itemMapBody, /\{needsReason && !conflict && <div className="market-stock-reason">/)
})

test('banner de conflito mostra produto, minha contagem e a contagem atualmente salva, com as duas ações pedidas', () => {
  const itemMapBody = src.match(/const conflict = itemConflicts\[item\.productId\]([\s\S]*?)<\/article>/)?.[0] ?? ''
  assert.match(itemMapBody, /\{conflict && <div className="market-item-conflict" role="alert">/)
  assert.match(itemMapBody, /Minha contagem:/)
  assert.match(itemMapBody, /Contagem atualmente salva:/)
  assert.match(itemMapBody, />Usar minha contagem</)
  assert.match(itemMapBody, />Usar contagem salva</)
  assert.match(itemMapBody, /onClick=\{\(\) => void resolveConflictUseMine\(item\.productId\)\}/)
  assert.match(itemMapBody, /onClick=\{\(\) => resolveConflictUseServer\(item\.productId\)\}/)
})

test('conflito pendente também bloqueia "Finalizar inventário" (unresolvedConflictCount)', () => {
  assert.match(src, /const unresolvedConflictCount = Object\.keys\(itemConflicts\)\.length/)
})

// AJUSTE 2 (saída com conflito não resolvido): itens 6-10 da cobertura pedida.
test('6) conflito pendente bloqueia leaveStock/closeInventory: nem chega a tentar rede, sai direto para a UI de conflito', () => {
  const leaveBody = src.match(/const leaveStock = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  const closeBody = src.match(/const closeInventory = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(leaveBody, /if \(Object\.keys\(itemConflictsRef\.current\)\.length > 0\) \{ setExitBlocked\('back-conflict'\); focusConflictedItem\(\); return \}/)
  assert.match(closeBody, /if \(Object\.keys\(itemConflictsRef\.current\)\.length > 0\) \{ setExitBlocked\('close-conflict'\); focusConflictedItem\(\); return \}/)
})

test('7) conflito pendente bloqueia finalizeDraft com mensagem específica, antes mesmo de tentar salvar', () => {
  const finalizeBody = src.match(/const finalizeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(finalizeBody, /if \(Object\.keys\(itemConflictsRef\.current\)\.length > 0\) \{/)
  assert.match(finalizeBody, /setError\('Existe uma contagem em conflito\. Resolva o item destacado antes de finalizar o inventário\.'\)/)
  assert.match(finalizeBody, /focusConflictedItem\(\)/)
})

test('8) finalizeDraft não prossegue enquanto houver item dirty/save em voo: aguarda commitDirtyItems e só continua se flush.ok — "em voo" nunca é tratado como "salvo"', () => {
  const finalizeBody = src.match(/const finalizeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(finalizeBody, /const flush = await commitDirtyItems\(\)/, 'precisa aguardar o flush completo (que por sua vez aguarda qualquer save já em voo via runSerializedByKey) antes de finalizar')
  assert.match(finalizeBody, /if \(!flush\.ok\) \{/, 'não pode prosseguir para finalizeMarketInventoryDraft se algo ainda não foi persistido (dirty, em voo ou superado)')
  // finalizeMarketInventoryDraft só pode ser chamada DEPOIS do bloco de
  // checagem de flush.ok, nunca antes.
  const flushGuardIndex = finalizeBody.indexOf('if (!flush.ok)')
  const finalizeCallIndex = finalizeBody.indexOf('await finalizeMarketInventoryDraft(')
  assert.ok(flushGuardIndex >= 0 && finalizeCallIndex > flushGuardIndex, 'a checagem de flush.ok precisa vir antes da chamada real de finalização')
})

test('8) mensagem específica de conflito existe (saída) e é distinta da mensagem de finalização', () => {
  assert.match(src, /Existe uma contagem em conflito\. Resolva o item destacado antes de sair do inventário\./)
  assert.match(src, /Existe uma contagem em conflito\. Resolva o item destacado antes de finalizar o inventário\./)
})

test('9) nenhum caminho de bloqueio por conflito (leaveStock/closeInventory/finalizeDraft) descarta dados locais', () => {
  const leaveBody = src.match(/const leaveStock = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  const closeBody = src.match(/const closeInventory = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  const finalizeConflictGuard = src.match(/if \(Object\.keys\(itemConflictsRef\.current\)\.length > 0\) \{\s*\n\s*setError\('Existe uma contagem em conflito\. Resolva o item destacado antes de finalizar o inventário\.'\)\s*\n\s*focusConflictedItem\(\)\s*\n\s*return\s*\n\s*\}/)?.[0] ?? ''
  assert.ok(finalizeConflictGuard, 'guarda de conflito no finalizeDraft não encontrada')
  for (const body of [leaveBody, closeBody, finalizeConflictGuard]) {
    assert.doesNotMatch(body, /setItems\(\[\]\)|itemsRef\.current = \[\]|setCurrentDraft\(null\)/, 'bloqueio por conflito nunca pode apagar itens locais nem o draft')
  }
})

test('10) resolver o conflito (usar minha ou usar salva) sempre remove a entrada de itemConflicts, liberando sair/finalizar de novo', () => {
  const useMineBody = src.match(/const resolveConflictUseMine = async \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  const useServerBody = src.match(/const resolveConflictUseServer = \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  // "Usar contagem salva" limpa itemConflicts diretamente aqui mesmo.
  assert.match(useServerBody, /setItemConflicts\(\(prev\) => \{ const next = \{ \.\.\.prev \}; delete next\[productId\]; return next \}\)/)
  // "Usar minha contagem" (ação 'save') delega a commitItem, que só limpa
  // itemConflicts quando o resultado NÃO é conflito (sucesso) — se dermos
  // outra disputa concorrente, a entrada é substituída (nunca removida sem
  // motivo), mantendo o bloqueio até resolver de verdade.
  assert.match(useMineBody, /void commitItem\(productId, baseVersion\)/)
  const commitItemBody = src.match(/const performItemCommit = useCallback\(async \(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> => \{([\s\S]*?)\n {2}\}, \[syncDraftItems\]\)/)?.[0] ?? ''
  // Correção do lost update (bloqueio da auditoria final) renomeou a
  // variável local para next2, para não colidir com o `next` que já
  // aplica applyItemSaveResponse mais acima no mesmo bloco — mesma limpeza
  // de itemConflicts de sempre, só o nome mudou.
  assert.match(commitItemBody, /setItemConflicts\(\(prev\) => \{ if \(!\(productId in prev\)\) return prev; const next2 = \{ \.\.\.prev \}; delete next2\[productId\]; return next2 \}\)/)
  // "Usar minha contagem" (ação 'remove') também limpa diretamente ao suceder.
  assert.match(useMineBody, /setItemConflicts\(\(prev\) => \{ const next = \{ \.\.\.prev \}; delete next\[productId\]; return next \}\)/)
})

test('commitItem nunca reenvia ao servidor um conflito já conhecido (evita loop) — só quando explicitamente resolvido (override)', () => {
  const commitItemBody = src.match(/const performItemCommit = useCallback\(async \(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> => \{([\s\S]*?)\n {2}\}, \[syncDraftItems\]\)/)?.[0] ?? ''
  assert.match(commitItemBody, /if \(itemConflictsRef\.current\[productId\] && !overriding\) return 'conflict'/)
})

// ===================================================================
// BLOCO "Inventário multiusuário" — conclusão do item (quantidade + motivo)
// só depois de confirmação do backend, lista ordenada por recência, e
// erro/conflito nunca limpam o item nem devolvem o foco ao scanner/pesquisa.
// ===================================================================

test('sortItemsByRecency: mais recente primeiro; item sem valor de ordem (ainda não persistido) sempre fica no topo', () => {
  const order = { a: 10, b: 30, c: 20 }
  const sorted = sortItemsByRecency([item('a'), item('b'), item('c')], order)
  assert.deepEqual(sorted.map((i) => i.productId), ['b', 'c', 'a'], 'maior valor de ordem primeiro')

  const withUnpersisted = sortItemsByRecency([item('a'), item('novo')], { a: 10 })
  assert.deepEqual(withUnpersisted.map((i) => i.productId), ['novo', 'a'], 'item sem entrada em order (novo, ainda local) sempre no topo')

  // Não muta o array original — sortItemsByRecency é usada só para exibição,
  // `items`/itemsRef continuam na ordem usada pela lógica de dirty/merge.
  const original = [item('a'), item('b')]
  sortItemsByRecency(original, { a: 1, b: 2 })
  assert.deepEqual(original.map((i) => i.productId), ['a', 'b'])
})

test('seedItemOrder: usa o índice do array (draft.items já vem ordenado por created_at) como ordem inicial', () => {
  const order = seedItemOrder([{ productId: 'p1' }, { productId: 'p2' }, { productId: 'p3' }])
  assert.deepEqual(order, { p1: 0, p2: 1, p3: 2 })
  assert.deepEqual(sortItemsByRecency([item('p1'), item('p2'), item('p3')], order).map((i) => i.productId), ['p3', 'p2', 'p1'], 'item criado por último (maior índice) aparece primeiro')
})

test('detectServerUpdatedProductIds: só reporta produto com version diferente da última conhecida e que não é edição local pendente (dirty)', () => {
  const previous = [item('p1', { version: 1 }), item('p2', { version: 3 })]
  // p1: outro usuário salvou de novo (version 1 -> 2). p2: sem mudança
  // (mesma version). p3: nunca visto antes (novo item de outro operador).
  const server = [item('p1', { version: 2 }), item('p2', { version: 3 }), item('p3', { version: 1 })]
  assert.deepEqual(detectServerUpdatedProductIds(previous, server, new Set()), ['p1', 'p3'])
})

test('detectServerUpdatedProductIds: produto dirty (edição local pendente deste operador) nunca é reportado, mesmo com version diferente', () => {
  const previous = [item('p1', { version: 1 })]
  const server = [item('p1', { version: 2 })]
  assert.deepEqual(detectServerUpdatedProductIds(previous, server, new Set(['p1'])), [], 'servidor ainda não reflete a edição local em voo — não deve "furar fila" na ordenação por causa disso')
})

test('a lista renderizada usa orderedItems (items ordenado por itemOrder via sortItemsByRecency), nunca items diretamente', () => {
  assert.match(src, /const orderedItems = useMemo\(\(\) => sortItemsByRecency\(items, itemOrder\), \[items, itemOrder\]\)/)
  assert.match(src, /<div className="market-counted-products">\{orderedItems\.length \? orderedItems\.map\(\(item\) => \{/)
})

test('itemOrder é atualizado no sucesso do próprio save (performItemCommit) e ao detectar alteração de outro operador (syncDraftItems)', () => {
  const commitItemBody = src.match(/const performItemCommit = useCallback\(async \(productId: string, expectedVersionOverride\?: number \| null\): Promise<ItemCommitOutcome> => \{([\s\S]*?)\n {2}\}, \[syncDraftItems\]\)/)?.[0] ?? ''
  assert.match(commitItemBody, /setItemOrder\(\(prev\) => \(\{ \.\.\.prev, \[productId\]: Date\.now\(\) \}\)\)/, 'confirmação de sucesso do backend precisa marcar este item como o mais recente')
  // A marcação do próprio save acontece ANTES do dirty ser considerado
  // "resolvido" para o disparo do sync best-effort (void syncDraftItems()).
  const orderBumpIndex = commitItemBody.indexOf('setItemOrder((prev) => ({ ...prev, [productId]: Date.now() }))')
  const syncCallIndex = commitItemBody.indexOf('void syncDraftItems()')
  assert.ok(orderBumpIndex >= 0 && syncCallIndex > orderBumpIndex)

  const syncBody = src.match(/const syncDraftItems = useCallback\(async \(\) => \{([\s\S]*?)\n {2}\}, \[accountId\]\)/)?.[0] ?? ''
  assert.match(syncBody, /const updatedByOthers = detectServerUpdatedProductIds\(previousItems, fresh\.items, dirtyItemIdsRef\.current\)/)
  assert.match(syncBody, /setItemOrder\(\(prev\) => \{ const next = \{ \.\.\.prev \}; updatedByOthers\.forEach\(\(id\) => \{ next\[id\] = now \}\); return next \}\)/)
})

test('itemOrder é semeado a partir de draft.items ao retomar o rascunho (seedItemOrder), e resetado junto com o resto do estado de concorrência por item', () => {
  const resumeDraftBody = src.match(/const resumeDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(resumeDraftBody, /setItemOrder\(seedItemOrder\(draft\.items\)\)/)
  const resetBody = src.match(/const resetItemConcurrencyState = \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(resetBody, /setItemOrder\(\{\}\)/)
})

test('finishItemEditing: só limpa a pesquisa/produto atual e devolve o foco à busca depois de commitItem confirmar sucesso ("saved"/"nothing-to-save") e sem motivo pendente', () => {
  const body = src.match(/const finishItemEditing = async \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'finishItemEditing não encontrada')
  assert.match(body, /const outcome = await commitItem\(productId\)/)
  assert.match(body, /if \(requiresDivergenceReason\(comparison, current\.isCounted\) && isReasonMissing\(current\)\) return/, 'motivo obrigatório ainda pendente nunca conclui o item')
  assert.match(body, /setQuery\(''\); setHighlightedProductId\(''\); searchRef\.current\?\.focus\(\)/)
  // A limpeza/foco só pode acontecer DEPOIS dos guardas de erro/conflito/motivo.
  const guardIndex = body.indexOf("if (outcome === 'conflict' || outcome === 'superseded') return")
  const finishIndex = body.indexOf("setQuery(''); setHighlightedProductId(''); searchRef.current?.focus()")
  assert.ok(guardIndex >= 0 && finishIndex > guardIndex)
})

test('finishItemEditing (regra 5): erro/conflito/superseded nunca limpam o item nem devolvem o foco ao scanner/pesquisa — mantém o operador no item', () => {
  const body = src.match(/const finishItemEditing = async \(productId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /if \(outcome === 'error'\) \{ quantityRefs\.current\[productId\]\?\.focus\(\); return \}/, 'erro devolve o foco ao próprio campo, nunca ao scanner/pesquisa')
  assert.match(body, /if \(outcome === 'conflict' \|\| outcome === 'superseded'\) return/)
  const errorBranch = body.match(/if \(outcome === 'error'\) \{([\s\S]*?)\}/)?.[0] ?? ''
  assert.doesNotMatch(errorBranch, /setQuery|setHighlightedProductId|searchRef\.current\?\.focus/, 'branch de erro não pode limpar pesquisa/produto nem focar a busca')
})

test('Enter na quantidade só dispara blur (finishQuantity) — quem decide limpar/focar é finishItemEditing, nunca antes da confirmação do backend', () => {
  const finishQuantityBody = src.match(/const finishQuantity = \(event: KeyboardEvent<HTMLInputElement>\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(finishQuantityBody, 'finishQuantity não encontrada')
  assert.match(finishQuantityBody, /event\.preventDefault\(\); event\.currentTarget\.blur\(\)/)
  assert.doesNotMatch(finishQuantityBody, /searchRef\.current\?\.focus\(\)/, 'não pode mais focar a busca diretamente no keydown — isso agora depende da confirmação do backend')
})

test('campo de quantidade e observação de motivo (OTHER) chamam finishItemEditing no blur, não commitItem diretamente', () => {
  const quantityInput = src.match(/<input aria-label=\{`Quantidade contada de \$\{product\.name\}`\}[\s\S]*?\/>/)?.[0] ?? ''
  assert.match(quantityInput, /onBlur=\{\(\) => void finishItemEditing\(item\.productId\)\}/)
  const noteBlock = src.match(/\{item\.reasonCode === 'OTHER' && <label>Observação[\s\S]*?<\/label>\}/)?.[0] ?? ''
  assert.match(noteBlock, /onBlur=\{\(\) => void finishItemEditing\(item\.productId\)\}/)
})

test('updateReasonCode (seleção do motivo) delega a conclusão a finishItemEditing — mesmo caminho da quantidade, não reimplementa o commit', () => {
  const body = src.match(/const updateReasonCode = \(productId: string, reasonCode: MarketInventoryReasonCode \| null\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'updateReasonCode não encontrada')
  assert.match(body, /void finishItemEditing\(productId\)/)
})
