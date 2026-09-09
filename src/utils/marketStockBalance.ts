import type { MarketInitialInventoryItem, MarketInventoryReasonCode, MarketStockBalanceRow } from '../types/marketStock'

// Mesma normalização usada em MarketStockDashboard (findMarketStockProducts):
// NFD + remoção dos diacríticos combinantes (faixa Unicode 0x0300-0x036f).
// Construído via String.fromCharCode para evitar caracteres combinantes
// literais no código-fonte deste arquivo — mesmo range, mesmo resultado.
const diacritics = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g')
const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(diacritics, '')

// Busca local sobre o saldo já carregado (descrição ou EAN/GTIN) — sem
// depender do catálogo completo de produtos, que só é buscado quando a
// contagem de inventário começa. Query vazia devolve tudo: é a listagem
// padrão da tela de saldo, não um autocomplete que só aparece ao digitar.
export function findMarketStockBalance(balance: MarketStockBalanceRow[], query: string): MarketStockBalanceRow[] {
  const term = normalizeSearch(query)
  if (!term) return balance
  return balance.filter((row) => normalizeSearch(row.productName).includes(term) || (row.ean ? normalizeSearch(row.ean).includes(term) : false))
}

export interface StockCountComparison {
  // false quando o produto não tem nenhum registro em balanceByProduct (nunca
  // teve movimento de estoque neste local) — nunca inventamos "saldo 0" para
  // esse caso, ver compareStockCount.
  known: boolean
  currentQuantity: number
  countedQuantity: number
  difference: number
}

// Compara a contagem de um item com o saldo atual do MESMO local — sempre a
// partir de balanceByProduct (derivado 1:1 de market_get_stock_balance/
// market_stock_balance, já carregado para a tela de contagem). Usada tanto
// para itens já presentes no draft quanto para itens localizados durante a
// contagem (busca por nome, EAN/GTIN, código externo/SKU ou scanner): todos
// resolvem produto para o mesmo productId e passam pela mesma função aqui —
// nenhuma segunda fonte/lógica de saldo. `known: false` quando o produto não
// tem nenhuma linha de saldo (nunca movimentou neste local): currentQuantity
// e difference ficam 0 apenas por tipagem, mas não devem ser exibidos —
// quem chama deve mostrar um estado explícito (ex.: "Saldo não registrado").
export function compareStockCount(balanceByProduct: Map<string, number>, productId: string, countedQuantity: number): StockCountComparison {
  const known = balanceByProduct.has(productId)
  const currentQuantity = balanceByProduct.get(productId) ?? 0
  return { known, currentQuantity, countedQuantity, difference: countedQuantity - currentQuantity }
}

// Mesmo critério usado por market_finalize_inventory_draft (202609080003):
// motivo só é exigido quando o saldo é CONHECIDO (nunca por inventoryType)
// e a contagem já foi informada e diverge dele. Saldo desconhecido = está
// estabelecendo a primeira referência, não é perda/ganho a justificar.
export function requiresDivergenceReason(comparison: StockCountComparison, isCounted: boolean): boolean {
  return comparison.known && isCounted && comparison.difference !== 0
}

// Mesma regra de obrigatoriedade da RPC: reasonCode sempre necessário quando
// o item diverge; reasonNote só quando reasonCode for 'OTHER'.
export function isReasonMissing(item: Pick<MarketInitialInventoryItem, 'reasonCode' | 'reasonNote'>): boolean {
  if (!item.reasonCode) return true
  if (item.reasonCode === 'OTHER') return !item.reasonNote?.trim()
  return false
}

export type ReasonSign = 'IN' | 'OUT' | 'BOTH'

// Classificação única do sentido de cada motivo — mesma matriz usada pela
// validação da RPC (market_finalize_inventory_draft, 202609080004). Único
// lugar onde essa matriz existe no frontend; não duplicar em componentes.
export const reasonSignByCode: Record<MarketInventoryReasonCode, ReasonSign> = {
  EXPIRED_LOSS: 'OUT',
  DAMAGE: 'OUT',
  THEFT_LOSS: 'OUT',
  INTERNAL_USE: 'OUT',
  UNREGISTERED_PURCHASE: 'IN',
  PREVIOUS_COUNT_ERROR: 'BOTH',
  UNREGISTERED_TRANSFER: 'BOTH',
  OTHER: 'BOTH',
}

// Sentido da diferença: quem sobrou (IN, vira ADJUSTMENT_IN) vs quem faltou
// (OUT, vira ADJUSTMENT_OUT). Diferença zero não tem sentido — null.
export function differenceSign(difference: number): 'IN' | 'OUT' | null {
  if (difference > 0) return 'IN'
  if (difference < 0) return 'OUT'
  return null
}

// Diferença zero nunca é "inválida" aqui — quem decide se motivo é exigido
// é requiresDivergenceReason; esta função só avalia coerência de sentido.
export function isReasonCodeAllowedForDifference(reasonCode: MarketInventoryReasonCode, difference: number): boolean {
  const sign = differenceSign(difference)
  if (!sign) return true
  const allowed = reasonSignByCode[reasonCode]
  return allowed === 'BOTH' || allowed === sign
}

// Único ponto de decisão de quando um motivo já selecionado deixa de fazer
// sentido e precisa ser limpo: sem contagem, saldo desconhecido, diferença
// zerada, ou motivo incoerente com o sentido atual da diferença. Usado tanto
// ao editar a quantidade (updateQuantity) quanto ao sanear um rascunho
// retomado (resumeDraft) — mesma regra, um único lugar.
export function reasonNeedsReset(
  reasonCode: MarketInventoryReasonCode | null,
  comparison: StockCountComparison,
  isCounted: boolean,
): boolean {
  if (!reasonCode) return false
  if (!isCounted || !comparison.known || comparison.difference === 0) return true
  return !isReasonCodeAllowedForDifference(reasonCode, comparison.difference)
}

// Merge seguro entre o estado local (o que este operador está editando/já
// editou) e o estado do servidor (o que qualquer usuário já persistiu),
// usado nos pontos de sincronização sem realtime (202609080005): ao
// retomar, após salvar um item, após resolver um conflito. Nunca sobrescreve
// um item que este operador ainda não salvou (dirtyProductIds) — é
// exatamente isso que evita apagar contagem local só porque outro usuário
// mudou outro produto. Item local que o servidor ainda não conhece (novo,
// ainda não persistido) sempre sobrevive, esteja ou não em dirtyProductIds.
export function mergeDraftItems(
  localItems: MarketInitialInventoryItem[],
  serverItems: MarketInitialInventoryItem[],
  dirtyProductIds: ReadonlySet<string>,
): MarketInitialInventoryItem[] {
  const localByProduct = new Map(localItems.map((item) => [item.productId, item]))
  const merged = serverItems.map((serverItem) => {
    const local = localByProduct.get(serverItem.productId)
    return local && dirtyProductIds.has(serverItem.productId) ? local : serverItem
  })
  const serverProductIds = new Set(serverItems.map((item) => item.productId))
  for (const local of localItems) {
    if (!serverProductIds.has(local.productId)) merged.push(local)
  }
  return merged
}

// Ordenação da lista compartilhada (bloco "Inventário multiusuário" —
// lançamento/alteração mais recente primeiro). Sem updated_at por item na
// resposta das RPCs (202609080005 não expõe isso e migrations aplicadas são
// imutáveis — não há como acrescentar sem alterar aquela migration), a ordem
// é mantida no cliente: um valor por productId, tanto maior quanto mais
// recente a última persistência efetiva conhecida por este operador (própria
// ou sincronizada de outro usuário). Item sem valor (ainda não persistido)
// sempre fica no topo — é exatamente o item que o operador está editando agora.
export function sortItemsByRecency<T extends { productId: string }>(items: T[], order: Record<string, number>): T[] {
  return [...items].sort((a, b) => (order[b.productId] ?? Number.POSITIVE_INFINITY) - (order[a.productId] ?? Number.POSITIVE_INFINITY))
}

// Ordem inicial ao carregar/retomar um rascunho: draft.items já vem ordenado
// por created_at ascendente (mesma query em market_get_inventory_draft), então
// o índice no array serve como valor de ordenação — o último item (criado por
// último) recebe o maior índice e aparece no topo, sem inventar um timestamp.
export function seedItemOrder(items: { productId: string }[]): Record<string, number> {
  return Object.fromEntries(items.map((item, index) => [item.productId, index]))
}

// Detecta, a cada sincronização best-effort pós-gravação (sem realtime/polling
// — só roda depois de UM save do operador atual), quais produtos foram
// alterados no servidor por OUTRO usuário desde a última leitura conhecida
// deste cliente: version mudou e o produto não está dirty aqui (dirty = edição
// local deste operador ainda não persistida, que mergeDraftItems já preserva
// e não deve "furar fila" na ordenação por causa de um servidor que ainda não
// reflete essa edição). Usado só para decidir quem sobe para o topo da lista.
export function detectServerUpdatedProductIds(
  previousItems: MarketInitialInventoryItem[],
  serverItems: MarketInitialInventoryItem[],
  dirtyProductIds: ReadonlySet<string>,
): string[] {
  const previousByProduct = new Map(previousItems.map((item) => [item.productId, item]))
  return serverItems
    .filter((serverItem) => !dirtyProductIds.has(serverItem.productId))
    .filter((serverItem) => previousByProduct.get(serverItem.productId)?.version !== serverItem.version)
    .map((serverItem) => serverItem.productId)
}

export interface ItemSaveApplication {
  item: MarketInitialInventoryItem
  clearDirty: boolean
}

// Decide o que fazer com a resposta de um save de item quando ela volta,
// isolado do componente React para poder testar exatamente a corrida sem
// simular a tela inteira: correção do lost update em que uma edição local
// mais nova (feita enquanto o request anterior ainda estava em voo) era
// apagada pela resposta do request antigo.
//
// `supersededBySelf` = o PRÓPRIO operador editou este item de novo depois
// de enviar este request e antes da resposta voltar (nunca é sobre outro
// usuário — conflito real de outro usuário já é decidido antes disso, pelo
// campo `conflict` da resposta da RPC, e nunca chega até aqui).
//
// Sempre parte do item ATUAL (currentItem, que pode já refletir uma edição
// mais nova do que a enviada) — nunca do snapshot que foi efetivamente
// enviado ao servidor. Só a version muda; quantity/isCounted/reasonCode/
// reasonNote preservam qualquer edição mais nova, tenha ela acontecido ou
// não. clearDirty só é true quando esta resposta corresponde à edição mais
// recente — superada, o item continua pendente para o próximo commit, que
// já parte da version correta (evita um conflito falso contra este mesmo
// save).
export function applyItemSaveResponse(
  currentItem: MarketInitialInventoryItem,
  // number | null só para casar com o tipo geral de MarketInitialInventoryItem.version
  // (null = nunca persistido) — na prática, a version devolvida por um save
  // bem-sucedido nunca é null, mas a assinatura reflete o tipo real do campo.
  serverVersion: number | null,
  supersededBySelf: boolean,
): ItemSaveApplication {
  return { item: { ...currentItem, version: serverVersion }, clearDirty: !supersededBySelf }
}

// Serializa chamadas assíncronas por chave: no máximo UMA em voo por chave
// ao mesmo tempo — uma segunda chamada para a MESMA chave encadeia atrás da
// que já está em andamento (só roda `task` depois que a anterior terminar,
// com sucesso ou erro) em vez de disparar um request paralelo. Chaves
// diferentes nunca se bloqueiam entre si.
//
// Usado por commitItem em MarketStockDashboard.tsx para nunca disparar dois
// saves do MESMO produto ao mesmo tempo — o que faria a segunda chamada
// enviar a mesma version da primeira e receber um "conflito" que na
// verdade é o próprio operador/navegador disputando consigo mesmo, não
// concorrência real com outro usuário.
//
// `inFlight` é o registro compartilhado entre chamadas (tipicamente um
// useRef.current) — mutado diretamente, sem estado interno próprio, para
// caber no ciclo de vida de quem chama. Extraída como função pura (sem
// nada de React) para poder testar a serialização em si, isolada da tela.
export function runSerializedByKey<T>(
  inFlight: Record<string, Promise<T>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const ongoing = inFlight[key]
  const chained: Promise<T> = ongoing ? ongoing.then(task, task) : task()
  inFlight[key] = chained
  // Limpeza via .then(onFulfilled, onRejected) — nunca .finally() — porque
  // .finally() relança o erro na promise derivada; como ninguém consome essa
  // derivada (só o efeito colateral de limpar o registro importa aqui), isso
  // geraria um unhandledRejection mesmo quando quem chamou já trata o erro
  // na promise `chained` retornada. Os dois ramos fazem a mesma limpeza.
  const cleanup = () => { if (inFlight[key] === chained) delete inFlight[key] }
  chained.then(cleanup, cleanup)
  return chained
}
