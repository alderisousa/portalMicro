// Fechamento da Sprint de Estoque — item 3: "Últimos inventários" na tela
// inicial de Estoque, substituindo a antiga listagem de saldo/produtos.
// Validação por código-fonte (sem framework de DOM), mesmo padrão já usado
// pelos demais testes de MarketStockDashboard.tsx. As RPCs novas
// (market_list_inventory_sessions/market_get_inventory_session, 202609090001)
// são cobertas via PGlite em market-stock-session-history.test.mjs.
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

const src = readFileSync(new URL('../src/pages/MarketStockDashboard.tsx', import.meta.url), 'utf8')
const serviceSrc = readFileSync(new URL('../src/services/marketStock.ts', import.meta.url), 'utf8')

test('serviço: listMarketInventorySessions/getMarketInventorySession chamam as RPCs novas (202609090001), nunca RPCs existentes', () => {
  const listBody = serviceSrc.match(/export async function listMarketInventorySessions\([\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(listBody, /supabase\.rpc\('market_list_inventory_sessions', \{/)
  assert.match(listBody, /p_market_account_id: accountId,/)
  assert.match(listBody, /p_market_store_id: storeId,/)

  const getBody = serviceSrc.match(/export async function getMarketInventorySession\([\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(getBody, /supabase\.rpc\('market_get_inventory_session', \{/)
  assert.match(getBody, /p_inventory_session_id: sessionId,/)
})

test('applyStoreData busca o histórico em paralelo com saldo/rascunho, e uma falha nele não pode impedir o resto da tela de carregar', () => {
  const body = src.match(/const applyStoreData = async \(nextStoreId: string, nextContext: MarketStockContext\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.match(body, /const \[nextBalance, nextDraft, nextHistory\] = await Promise\.all\(\[/)
  assert.match(body, /listMarketInventorySessions\(accountId, nextStoreId\)\.catch\(/, 'falha ao buscar histórico precisa ser best-effort (catch), não pode derrubar o Promise.all inteiro')
})

test('toggleHistoryDetail: alterna abrir/fechar sem nova chamada de rede ao clicar de novo no mesmo item, e busca o detalhe via getMarketInventorySession', () => {
  const body = src.match(/const toggleHistoryDetail = async \(sessionId: string\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'toggleHistoryDetail não encontrada')
  assert.match(body, /if \(historyOpenSessionId === sessionId\) \{ setHistoryOpenSessionId\(''\); setHistoryDetail\(null\); return \}/, 'clicar de novo no mesmo item precisa fechar sem refazer a chamada')
  assert.match(body, /const detail = await getMarketInventorySession\(sessionId\)/)
  assert.match(body, /setHistoryDetail\(detail\)/)
})

test('lista do histórico: mais recente primeiro (ordem já vem da RPC, sem reordenar no cliente), status/data/produtos contados, e só inventário concluído é clicável', () => {
  const listBlock = src.match(/<ul className="market-history-list">\{historySessions\.map\(\(session\) => \{([\s\S]*?)\}\)\}<\/ul>/)?.[0] ?? ''
  assert.ok(listBlock, 'bloco de renderização do histórico não encontrado')
  assert.match(listBlock, /const isCompleted = session\.status === 'completed'/)
  assert.match(listBlock, /disabled=\{!isCompleted\}/, 'inventário cancelado não pode ser clicável para ver detalhe')
  assert.match(listBlock, /onClick=\{\(\) => void toggleHistoryDetail\(session\.id\)\}/)
  assert.match(listBlock, /\{session\.countedProducts\} \{session\.countedProducts === 1 \? 'produto contado' : 'produtos contados'\}/)
  assert.match(listBlock, /new Date\(referenceDate\)/, 'precisa mostrar data/hora do inventário')
})

test('detalhe do histórico mostra os itens da CONFERÊNCIA (productName/quantity de historyDetail), nunca o saldo atual da loja', () => {
  const detailBlock = src.match(/\{isOpen && <div className="market-history-detail">([\s\S]*?)<\/div>\}/)?.[0] ?? ''
  assert.ok(detailBlock, 'bloco de detalhe do histórico não encontrado')
  assert.match(detailBlock, /historyDetail\?\.items\.length/)
  assert.match(detailBlock, /historyDetail\.items\.map\(\(item\) => <tr key=\{item\.productId\}>/)
  assert.match(detailBlock, /item\.isCounted \? number\.format\(item\.quantity\) : '—'/)
  // Nunca usa `balance`/`balanceByProduct` (saldo atual) dentro do detalhe —
  // o detalhe representa aquela conferência específica, não o saldo vigente.
  assert.doesNotMatch(detailBlock, /balanceByProduct|getMarketStockBalance/)
})

test('cancelar um rascunho atualiza "Últimos inventários" automaticamente (best-effort), sem exigir reload da tela', () => {
  const body = src.match(/const cancelDraft = async \(\) => \{([\s\S]*?)\n {2}\}/)?.[0] ?? ''
  assert.ok(body, 'cancelDraft não encontrada')
  assert.match(body, /void listMarketInventorySessions\(accountId, storeId\)\.then\(setHistorySessions\)/)
})

// Requisito 4 (preservar o que já foi homologado): o card "Inventário em
// andamento" e as ações Novo/Continuar/Cancelar continuam exatamente como
// antes — só a área de listagem de saldo foi substituída pelo histórico.
test('card "Inventário em andamento" e as ações Novo inventário/Continuar/Cancelar continuam intactas', () => {
  assert.match(src, /<section className="market-stock-start market-stock-welcome"><RefreshCw size=\{34\} \/><div><span className="panel-kicker">\{draft\.inventoryType === 'cycle' \? 'CONFERÊNCIA SALVA' : 'RASCUNHO SALVO'\}<\/span><h2>Inventário em andamento<\/h2>/)
  assert.match(src, />Continuar inventário</)
  assert.match(src, />Cancelar inventário</)
  assert.match(src, /disabled=\{saving\} onClick=\{\(\) => void startDraft\(\)\}>\{saving \? 'Iniciando\.\.\.' : 'Novo inventário'\}<\/button>/)
})
