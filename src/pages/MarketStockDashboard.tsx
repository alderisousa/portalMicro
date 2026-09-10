import { ArrowLeft, Boxes, CheckCircle2, Minus, Plus, RefreshCw, ScanBarcode, Search, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  cancelMarketInventoryDraft, finalizeMarketInventoryDraft, getMarketInventoryDraft, getMarketInventorySession,
  getMarketStockBalance, getMarketStockContext, listActiveProducts, listMarketInventorySessions,
  listMarketStoreProductSettings, removeMarketInventoryItem, saveMarketInventoryDraft, saveMarketInventoryItem,
  saveMarketStoreProductMinimumStock,
} from '../services/marketStock'
import type {
  MarketInitialInventoryItem, MarketInventoryDraft, MarketInventoryReasonCode, MarketInventorySessionDetail,
  MarketInventorySessionSummary, MarketStockBalanceRow, MarketStockContext, MarketStockProduct,
} from '../types/marketStock'
import { BarcodeScanner } from '../components/BarcodeScanner'
import { findAccesysIntegrationId, getMarketProductSyncStatus, synchronizeMarketProducts } from '../services/marketIntegration'
import type { MarketProductSyncRun } from '../types/marketIntegration'
import {
  compareStockCount, isReasonCodeAllowedForDifference, isReasonMissing,
  applyItemSaveResponse, detectServerUpdatedProductIds, mergeDraftItems, reasonNeedsReset,
  requiresDivergenceReason, runSerializedByKey, seedItemOrder, sortItemsByRecency,
} from '../utils/marketStockBalance'

interface Props { accountId: string; onBack: () => void }
// Estado de SESSAO (started_at, criacao, finalize/cancel) — nao mais o
// array de itens, que tem sua propria concorrencia por produto (202609080005,
// ver ItemSaveState/itemConflicts abaixo).
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict' | 'finalized-elsewhere'
type ItemSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'
// 'superseded': a resposta chegou depois de o PRÓPRIO operador editar o
// mesmo item de novo enquanto o request estava em voo — não é conflito com
// outro usuário (isso continua sendo 'conflict', via version do servidor).
// commitDirtyItems trata 'superseded' como "ainda não terminou" (mesma
// regra de 'error'/'conflict': não é 'saved' nem 'nothing-to-save'), então
// quem chama (fechar/sair/finalizar) sabe que precisa de outro commit.
type ItemCommitOutcome = 'saved' | 'nothing-to-save' | 'conflict' | 'error' | 'superseded'
interface ItemConflict {
  productId: string
  action: 'save' | 'remove'
  localItem: MarketInitialInventoryItem
  serverItem: MarketInitialInventoryItem | null
}

const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 3 })
const diacritics = new RegExp(`[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g')
const normalizeSearch = (value: string) => value.trim().toLocaleLowerCase('pt-BR').normalize('NFD').replace(diacritics, '')
const initialDateTime = () => { const now = new Date(); now.setMinutes(now.getMinutes() - now.getTimezoneOffset()); return now.toISOString().slice(0, 16) }
const toLocalDateTime = (value: string) => { const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16) }
const formatProductSyncDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  .format(new Date(value)).replace(', ', ' às ')
const externalCodes = (product: MarketStockProduct) => [...product.externalEans, ...product.externalProductCodes]
const productIdentifier = (product: MarketStockProduct) => product.ean
  ? `EAN ${product.ean}`
  : externalCodes(product)[0]
    ? `Código externo: ${externalCodes(product)[0]}`
    : product.sku ? `SKU ${product.sku}` : product.unit

// Conjunto estável de motivos de divergência (market_inventory_session_items.reason_code,
// 202609080003) — mesmos códigos aceitos pelo check constraint no banco.
const reasonCodes: MarketInventoryReasonCode[] = [
  'EXPIRED_LOSS', 'DAMAGE', 'THEFT_LOSS', 'PREVIOUS_COUNT_ERROR',
  'UNREGISTERED_PURCHASE', 'UNREGISTERED_TRANSFER', 'INTERNAL_USE', 'OTHER',
]
const reasonLabels: Record<MarketInventoryReasonCode, string> = {
  EXPIRED_LOSS: 'Perda / produto vencido',
  DAMAGE: 'Quebra / avaria',
  THEFT_LOSS: 'Furto / extravio',
  PREVIOUS_COUNT_ERROR: 'Contagem anterior incorreta',
  UNREGISTERED_PURCHASE: 'Compra / nota não registrada',
  UNREGISTERED_TRANSFER: 'Transferência não registrada',
  INTERNAL_USE: 'Consumo / uso interno',
  OTHER: 'Outro',
}

export function findMarketStockProducts(products: MarketStockProduct[], query: string): MarketStockProduct[] {
  const term = normalizeSearch(query)
  if (!term) return []
  const exactEan = products.filter((product) => product.ean?.trim().toLocaleLowerCase('pt-BR') === term)
  if (exactEan.length) return exactEan
  const exactExternalCode = products.filter((product) => externalCodes(product).some((code) => code.trim().toLocaleLowerCase('pt-BR') === term))
  if (exactExternalCode.length) return exactExternalCode
  const exactSku = products.filter((product) => product.sku?.trim().toLocaleLowerCase('pt-BR') === term)
  if (exactSku.length) return exactSku
  return products.filter((product) => [product.name, product.ean, product.sku, ...externalCodes(product)].some((value) => value && normalizeSearch(value).includes(term)))
}

export function findExactMarketStockProduct(products: MarketStockProduct[], query: string): MarketStockProduct | null {
  const term = query.trim().toLocaleLowerCase('pt-BR')
  if (!term) return null
  const exactEan = products.filter((product) => product.ean?.trim().toLocaleLowerCase('pt-BR') === term)
  if (exactEan.length === 1) return exactEan[0]
  const exactExternalCode = products.filter((product) => externalCodes(product).some((code) => code.trim().toLocaleLowerCase('pt-BR') === term))
  if (exactExternalCode.length === 1) return exactExternalCode[0]
  if (exactExternalCode.length > 1) return null
  const exactSku = products.filter((product) => product.sku?.trim().toLocaleLowerCase('pt-BR') === term)
  return exactSku.length === 1 ? exactSku[0] : null
}

const isVersionConflict = (cause: unknown) => typeof cause === 'object' && cause && 'message' in cause
  && (String(cause.message).includes('INVENTORY_VERSION_CONFLICT') || String(cause.message).includes('INVENTORY_DRAFT_CONFLICT'))
const isDraftUnavailable = (cause: unknown) => typeof cause === 'object' && cause && 'message' in cause
  && String(cause.message).includes('INVENTORY_DRAFT_UNAVAILABLE')
// Proteção backend (unique_violation) que impede dois rascunhos ativos na
// mesma loja — não alterada. Só decide o que a UI faz quando ela dispara:
// outra tela/dispositivo criou o rascunho enquanto esta ainda achava que não
// havia nenhum (ver startDraft).
const isDraftAlreadyActive = (cause: unknown) => typeof cause === 'object' && cause && 'message' in cause
  && String(cause.message).includes('INVENTORY_DRAFT_CONFLICT')

export function MarketStockDashboard({ accountId, onBack }: Props) {
  const [context, setContext] = useState<MarketStockContext | null>(null)
  const [products, setProducts] = useState<MarketStockProduct[] | null>(null)
  const [storeId, setStoreId] = useState('')
  const [balance, setBalance] = useState<MarketStockBalanceRow[]>([])
  // Estoque mínimo (opcional) por produto/loja (market_store_products) —
  // independente da sessão de inventário: chave = productId, valor = último
  // minimum_stock conhecido do servidor (null = não configurado). Nunca
  // participa de dirtyItemIdsRef/itemConflicts (aquilo é só da contagem).
  const [minimumStock, setMinimumStock] = useState<Record<string, number | null>>({})
  // Texto em edição de um campo "Estoque mínimo": só existe uma entrada aqui
  // enquanto o operador está digitando (chave presente = houve onChange
  // desde o último commit). Ausência da chave é o que faz commitMinimumStock
  // não reenviar nada quando o campo é só aberto/fechado sem alteração.
  const [minimumStockInput, setMinimumStockInput] = useState<Record<string, string>>({})
  const [minimumStockSaveState, setMinimumStockSaveState] = useState<Record<string, 'saving' | 'error'>>({})
  const minimumStockRef = useRef<Record<string, number | null>>({})
  // "Últimos inventários" (fechamento da Sprint, item 3): resumo por loja,
  // mais recente primeiro (já vem ordenado da RPC). null = ainda carregando;
  // [] = loja sem nenhum inventário concluído/cancelado ainda.
  const [historySessions, setHistorySessions] = useState<MarketInventorySessionSummary[] | null>(null)
  const [historyOpenSessionId, setHistoryOpenSessionId] = useState('')
  const [historyDetail, setHistoryDetail] = useState<MarketInventorySessionDetail | null>(null)
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false)
  const [draft, setDraft] = useState<MarketInventoryDraft | null>(null)
  const [counting, setCounting] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmCancel, setConfirmCancel] = useState(false)
  // false: nenhuma saída pendente. 'back'/'close': falha genérica ao salvar
  // (retry via "Tentar novamente"). 'back-conflict'/'close-conflict': saída
  // bloqueada especificamente por um conflito de item pendente — nunca tenta
  // reenviar sozinho, só aponta para o item (ver focusConflictedItem).
  const [exitBlocked, setExitBlocked] = useState<false | 'back' | 'close' | 'back-conflict' | 'close-conflict'>(false)
  const [query, setQuery] = useState('')
  const [scannerOpen, setScannerOpen] = useState(false)
  const [items, setItems] = useState<MarketInitialInventoryItem[]>([])
  const [startedAt, setStartedAt] = useState(initialDateTime)
  const [highlightedProductId, setHighlightedProductId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  // Concorrência POR ITEM (202609080005): cada produto tem seu próprio
  // estado de salvamento e, quando aplicável, um conflito pendente de
  // resolução manual — nunca um único estado global para a sessão inteira.
  const [itemSaveState, setItemSaveState] = useState<Record<string, ItemSaveState>>({})
  const [itemConflicts, setItemConflicts] = useState<Record<string, ItemConflict>>({})
  // Ordenação client-side da lista compartilhada (bloco "Inventário
  // multiusuário", item 3): valor por productId, maior = alteração mais
  // recente conhecida por este operador — ver sortItemsByRecency/seedItemOrder/
  // detectServerUpdatedProductIds em utils/marketStockBalance.
  const [itemOrder, setItemOrder] = useState<Record<string, number>>({})
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [productIntegrationId, setProductIntegrationId] = useState<string | null>(null)
  const [productSyncRun, setProductSyncRun] = useState<MarketProductSyncRun | null>(null)
  const [lastProductSync, setLastProductSync] = useState<MarketProductSyncRun | null>(null)
  const [productSyncing, setProductSyncing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<Record<string, HTMLElement | null>>({})
  const quantityRefs = useRef<Record<string, HTMLInputElement | null>>({})
  const draftRef = useRef<MarketInventoryDraft | null>(null)
  const itemsRef = useRef<MarketInitialInventoryItem[]>([])
  const startedAtRef = useRef(startedAt)
  // Produtos com edição local ainda não confirmada no servidor. Nunca inclui
  // um item só porque foi ADICIONADO (ainda não contado não tem nada a
  // salvar) — só quantidade/motivo realmente editados entram aqui.
  const dirtyItemIdsRef = useRef<Set<string>>(new Set())
  // Espelha itemConflicts para commitItem poder checar sincronamente (sem
  // depender do timing de re-render) se já existe um conflito conhecido
  // para o produto — evita reenviar ao servidor o mesmo conflito em loop.
  const itemConflictsRef = useRef<Record<string, ItemConflict>>({})
  // Geração/revisão POR ITEM (correção do lost update descrito na auditoria
  // final): incrementada a cada edição local real (updateQuantity,
  // clearQuantity, updateReasonCode, updateReasonNote — sempre via
  // markItemDirty). commitItem captura a revisão no momento do envio; se ela
  // mudar antes da resposta voltar, significa que o PRÓPRIO operador editou
  // o item de novo enquanto aquele request específico estava em voo — a
  // resposta (que corresponde a um snapshot já superado) nunca pode limpar o
  // dirty nem sobrescrever os campos editáveis mais novos.
  const itemRevisionRef = useRef<Record<string, number>>({})

  const setCurrentDraft = (next: MarketInventoryDraft | null) => { draftRef.current = next; setDraft(next) }
  useEffect(() => { itemsRef.current = items }, [items])
  useEffect(() => { minimumStockRef.current = minimumStock }, [minimumStock])
  useEffect(() => { itemConflictsRef.current = itemConflicts }, [itemConflicts])
  useEffect(() => { startedAtRef.current = startedAt }, [startedAt])

  const resetItemConcurrencyState = () => {
    dirtyItemIdsRef.current = new Set(); itemRevisionRef.current = {}; setItemSaveState({}); setItemConflicts({}); setItemOrder({})
  }

  const applyStoreData = async (nextStoreId: string, nextContext: MarketStockContext) => {
    const [nextBalance, nextDraft, nextHistory, nextMinimumStock] = await Promise.all([
      nextStoreId ? getMarketStockBalance(accountId, nextStoreId) : Promise.resolve([]),
      nextStoreId ? getMarketInventoryDraft(accountId, nextStoreId) : Promise.resolve(null),
      // "Últimos inventários" (fechamento da Sprint, item 3) — best-effort:
      // falha aqui não pode impedir o resto da tela de carregar (mesmo
      // espírito do status de sincronização de produtos, ver load()).
      nextStoreId ? listMarketInventorySessions(accountId, nextStoreId).catch((cause) => { console.error('Falha ao carregar historico de inventarios:', cause); return [] }) : Promise.resolve([]),
      // Estoque mínimo (opcional): mesmo tratamento best-effort — sem isso o
      // campo só fica temporariamente indisponível, nunca bloqueia a contagem.
      nextStoreId ? listMarketStoreProductSettings(accountId, nextStoreId).catch((cause) => { console.error('Falha ao carregar estoque minimo configurado:', cause); return [] }) : Promise.resolve([]),
    ])
    setBalance(nextBalance); setCurrentDraft(nextDraft)
    setHistorySessions(nextHistory); setHistoryOpenSessionId(''); setHistoryDetail(null)
    setMinimumStock(Object.fromEntries(nextMinimumStock.map((row) => [row.productId, row.minimumStock])))
    setMinimumStockInput({}); setMinimumStockSaveState({})
    setItems([]); itemsRef.current = []; setCounting(false); setConfirming(false); setConfirmCancel(false)
    resetItemConcurrencyState(); setSaveState(nextDraft ? 'saved' : 'idle')
  }

  const load = useCallback(async (preferredStoreId?: string) => {
    setLoading(true); setError('')
    try {
      const nextContext = await getMarketStockContext(accountId)
      const nextStoreId = preferredStoreId && nextContext.access.stores.some((store) => store.id === preferredStoreId) ? preferredStoreId : nextContext.access.stores[0]?.id ?? ''
      setContext(nextContext); setStoreId(nextStoreId); await applyStoreData(nextStoreId, nextContext)
      try {
        const integrationId = await findAccesysIntegrationId(accountId)
        setProductIntegrationId(integrationId ?? null)
        if (integrationId) {
          const status = await getMarketProductSyncStatus(accountId, integrationId)
          setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
        } else {
          setProductSyncRun(null); setLastProductSync(null)
        }
      } catch (cause) {
        console.error('Falha ao carregar status da sincronizacao de produtos:', cause)
        setProductIntegrationId(null); setProductSyncRun(null); setLastProductSync(null)
      }
    } catch (cause) { console.error('Falha ao carregar estoque:', cause); setError('Não foi possível carregar os dados de estoque.') }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (counting && !confirming) window.setTimeout(() => searchRef.current?.focus(), 0) }, [counting, confirming])

  const selectedStore = context?.access.stores.find((store) => store.id === storeId) ?? null
  const searchResults = useMemo(() => findMarketStockProducts(products ?? [], query).slice(0, 8), [products, query])
  const positiveItems = items.filter((item) => item.quantity > 0)
  const isCycleInventory = draft?.inventoryType === 'cycle'
  // "Contado" nunca inclui item ainda sem quantidade informada (isCounted=false)
  // — positiveItems/items já excluem quantity=0 de outras formas, mas um item
  // não contado também tem quantity=0 por construção; o filtro por isCounted é
  // quem faz a distinção correta entre "zero contado" e "ainda não contado".
  const countedItems = (isCycleInventory ? items : positiveItems).filter((item) => item.isCounted)
  const uncountedItems = items.filter((item) => !item.isCounted)
  const balanceByProduct = useMemo(() => new Map(balance.map((row) => [row.productId, row.quantityOnHand])), [balance])
  // Divergência com saldo conhecido exige motivo — nunca decidido por
  // isCycleInventory/inventoryType (ver requiresDivergenceReason). Só avalia
  // item já contado: item ainda não contado já é bloqueado por outra regra.
  const itemsNeedingReason = items.filter((item) =>
    item.isCounted && requiresDivergenceReason(compareStockCount(balanceByProduct, item.productId, item.quantity), item.isCounted) && isReasonMissing(item))
  const unresolvedConflictCount = Object.keys(itemConflicts).length
  // Lista compartilhada (bloco "Inventário multiusuário", item 3): do
  // lançamento/alteração mais recente para o mais antigo — só para exibição,
  // `items`/itemsRef continuam na ordem usada pelo resto da lógica (dirty,
  // merge, contadores).
  const orderedItems = useMemo(() => sortItemsByRecency(items, itemOrder), [items, itemOrder])
  const cycleSummary = useMemo(() => items.filter((item) => item.isCounted).reduce((summary, item) => {
    const difference = item.quantity - (balanceByProduct.get(item.productId) ?? 0)
    if (difference > 0) { summary.adjustmentInProducts += 1; summary.adjustmentInQuantity += difference }
    else if (difference < 0) { summary.adjustmentOutProducts += 1; summary.adjustmentOutQuantity += Math.abs(difference) }
    else summary.unchangedProducts += 1
    return summary
  }, { adjustmentInProducts: 0, adjustmentOutProducts: 0, unchangedProducts: 0, adjustmentInQuantity: 0, adjustmentOutQuantity: 0 }), [items, balanceByProduct])

  // Toda edição local real passa por aqui — é o único lugar que incrementa
  // itemRevisionRef, a base da proteção contra lost update em commitItem.
  const markItemDirty = (productId: string) => {
    dirtyItemIdsRef.current.add(productId)
    itemRevisionRef.current[productId] = (itemRevisionRef.current[productId] ?? 0) + 1
  }

  // Sem realtime: este é o único jeito de um usuário ver o que outro já
  // persistiu. Nunca sobrescreve um item que ESTE operador ainda não salvou
  // (dirtyItemIdsRef) — mergeDraftItems garante isso. Best-effort: falha aqui
  // não interrompe a contagem, só significa "não atualizou desta vez".
  const syncDraftItems = useCallback(async () => {
    if (!draftRef.current) return
    try {
      const fresh = await getMarketInventoryDraft(accountId, draftRef.current.marketStoreId)
      if (!fresh || fresh.id !== draftRef.current.id) return
      const previousItems = itemsRef.current
      const merged = mergeDraftItems(previousItems, fresh.items, dirtyItemIdsRef.current)
      itemsRef.current = merged; setItems(merged)
      // Produto com version diferente da última conhecida por este cliente e
      // que não é edição local pendente = outro operador salvou/alterou o
      // item — sobe para o topo da lista (regra 3, "alterado de novo").
      const updatedByOthers = detectServerUpdatedProductIds(previousItems, fresh.items, dirtyItemIdsRef.current)
      if (updatedByOthers.length) {
        const now = Date.now()
        setItemOrder((prev) => { const next = { ...prev }; updatedByOthers.forEach((id) => { next[id] = now }); return next })
      }
    } catch (cause) { console.error('Falha ao sincronizar itens do inventario:', cause) }
  }, [accountId])

  // Unidade de concorrência = UM produto (202609080005). Nunca envolve
  // nenhum outro item da sessão. expectedVersionOverride é usado só pela
  // resolução de conflito ("usar minha contagem"), que reaplica a edição
  // local com a version atual do servidor como base.
  //
  // performItemCommit é a lógica de envio em si — SEMPRE lê itemsRef/
  // dirtyItemIdsRef no momento em que realmente executa, nunca no momento
  // em que foi solicitada. Isso é o que torna correto rodá-la depois de
  // esperar um commit anterior do MESMO produto (ver commitItem abaixo):
  // quando ela finalmente roda, já reflete qualquer edição feita nesse meio-tempo.
  const performItemCommit = useCallback(async (productId: string, expectedVersionOverride?: number | null): Promise<ItemCommitOutcome> => {
    if (!draftRef.current) return 'nothing-to-save'
    const localItem = itemsRef.current.find((item) => item.productId === productId)
    if (!localItem) return 'nothing-to-save'
    const overriding = expectedVersionOverride !== undefined
    if (!dirtyItemIdsRef.current.has(productId) && !overriding) return 'nothing-to-save'
    // Já existe um conflito conhecido para este produto e ninguém pediu
    // explicitamente para retentar (overriding, via resolveConflictUseMine):
    // não reenvia a mesma disputa ao servidor em loop — só reafirma o
    // conflito já registrado, a resolução é sempre manual.
    if (itemConflictsRef.current[productId] && !overriding) return 'conflict'
    const expectedVersion = overriding ? expectedVersionOverride : localItem.version
    // Snapshot da revisão local NO MOMENTO do envio. Uma resposta só pode
    // limpar o dirty/aplicar os campos editáveis correspondentes à edição
    // que ELA efetivamente enviou — se a revisão mudar antes da resposta
    // voltar (o operador editou de novo enquanto este request específico
    // estava em voo), essa resposta está superada e precisa ser tratada
    // com cuidado (ver supersededBySelf abaixo), nunca como se fosse a
    // confirmação da edição mais nova.
    const revisionAtSend = itemRevisionRef.current[productId] ?? 0
    setItemSaveState((prev) => ({ ...prev, [productId]: 'saving' }))
    try {
      const result = await saveMarketInventoryItem(
        draftRef.current.id, productId, localItem.quantity, localItem.isCounted,
        localItem.reasonCode, localItem.reasonNote, expectedVersion,
      )
      if (result.conflict) {
        // Conflito REAL (version não bateu contra o que está no servidor) —
        // sempre outro usuário, nunca o próprio operador: uma edição local
        // concorrente do mesmo operador é resolvida abaixo (supersededBySelf),
        // sem nunca passar por aqui. Fluxo de resolução manual inalterado.
        setItemConflicts((prev) => ({ ...prev, [productId]: { productId, action: 'save', localItem, serverItem: result.serverItem } }))
        setItemSaveState((prev) => ({ ...prev, [productId]: 'conflict' }))
        return 'conflict'
      }
      // O operador editou este MESMO item de novo enquanto este request
      // estava em voo? (nunca é sobre outro usuário — isso já foi decidido
      // acima, por result.conflict). applyItemSaveResponse parte sempre do
      // item ATUAL (itemsRef.current, que já reflete essa edição mais nova
      // se ela existir) — nunca do snapshot que foi efetivamente enviado.
      const supersededBySelf = (itemRevisionRef.current[productId] ?? 0) !== revisionAtSend
      const currentItem = itemsRef.current.find((item) => item.productId === productId) ?? localItem
      const applied = applyItemSaveResponse(currentItem, result.item.version, supersededBySelf)
      const next = itemsRef.current.map((item) => item.productId === productId ? applied.item : item)
      itemsRef.current = next; setItems(next)
      if (!applied.clearDirty) {
        // Superada: nem limpa o dirty nem apaga a edição mais nova — só a
        // version local avança, para o próximo commit não tentar a version
        // antiga e gerar um conflito falso contra este mesmo save.
        setItemSaveState((prev) => ({ ...prev, [productId]: 'idle' }))
        return 'superseded'
      }
      dirtyItemIdsRef.current.delete(productId)
      setItemConflicts((prev) => { if (!(productId in prev)) return prev; const next2 = { ...prev }; delete next2[productId]; return next2 })
      setItemSaveState((prev) => ({ ...prev, [productId]: 'saved' }))
      // Confirmação de sucesso do backend (bloco "Inventário multiusuário",
      // item 1/3): só agora este item sobe para o topo da lista compartilhada.
      setItemOrder((prev) => ({ ...prev, [productId]: Date.now() }))
      void syncDraftItems()
      return 'saved'
    } catch (cause) {
      if (isDraftUnavailable(cause)) { setSaveState('finalized-elsewhere'); return 'error' }
      console.error('Falha ao salvar item do inventario:', cause)
      setItemSaveState((prev) => ({ ...prev, [productId]: 'error' }))
      return 'error'
    }
  }, [syncDraftItems])

  // Nunca mais de UM save em voo por produto. Duas chamadas rápidas para o
  // MESMO productId (ex.: commitDirtyItems tentando de novo um item que já
  // está sendo salvo por outro gatilho) nunca disparam um segundo request
  // paralelo com a mesma version — isso é exatamente o que geraria um
  // "conflito" artificial do operador contra ele mesmo. runSerializedByKey
  // (função pura, testada isoladamente) encadeia a segunda chamada atrás do
  // request em andamento: só roda performItemCommit depois que o anterior
  // terminar, e nesse momento já lê o estado mais recente (revisão/version/
  // edição) — reaproveitando integralmente a proteção de itemRevisionRef/
  // applyItemSaveResponse já existente para o caso de uma edição nova ter
  // chegado nesse meio-tempo. Produtos diferentes nunca compartilham essa
  // fila (chave = productId): X em voo nunca atrasa Y.
  const inFlightCommitRef = useRef<Record<string, Promise<ItemCommitOutcome>>>({})
  const commitItem = useCallback((productId: string, expectedVersionOverride?: number | null): Promise<ItemCommitOutcome> =>
    runSerializedByKey(inFlightCommitRef.current, productId, () => performItemCommit(productId, expectedVersionOverride)),
  [performItemCommit])

  // Flush de tudo que ainda não foi confirmado no servidor — chamado nos
  // pontos de saída (fechar/sair/finalizar), nunca a cada tecla digitada.
  // ok=false quando algo ficou pendente — hasConflict distingue "existe
  // conflito de item, resolução é manual" (nunca reenviar sozinho) de "erro
  // genérico de rede" (aí sim, vale tentar de novo). Baseado sempre no
  // RETORNO de commitItem, nunca em estado React lido logo após o await
  // (evita qualquer risco de leitura desatualizada). 'superseded' também
  // conta como ok=false/hasConflict=false: o item continua dirty com a
  // edição mais nova preservada, então basta chamar commitDirtyItems de
  // novo (o próprio "Tentar novamente" já faz isso) para completar — não é
  // um conflito de outro usuário, só uma edição do próprio operador que
  // chegou depois do request anterior já estar em voo.
  const commitDirtyItems = useCallback(async (): Promise<{ ok: boolean; hasConflict: boolean }> => {
    const ids = Array.from(dirtyItemIdsRef.current)
    if (!ids.length) return { ok: true, hasConflict: false }
    const outcomes = await Promise.all(ids.map((id) => commitItem(id)))
    const ok = outcomes.every((outcome) => outcome === 'saved' || outcome === 'nothing-to-save')
    return { ok, hasConflict: !ok && outcomes.some((outcome) => outcome === 'conflict') }
  }, [commitItem])

  // Fluxo de conclusão do item (bloco "Inventário multiusuário", item 1): só
  // depois que o backend confirma o save deste item — e nenhum motivo
  // obrigatório ainda está pendente — a pesquisa/produto atual são limpos e o
  // foco volta sozinho para o campo de busca. Erro ou conflito (commitItem
  // não devolve 'saved'/'nothing-to-save') mantém o operador exatamente onde
  // está, sem limpar nada nem tirar o foco do item (regra 5) — o aviso de
  // erro/conflito já exibido no próprio item cobre a nova tentativa.
  const finishItemEditing = async (productId: string) => {
    const outcome = await commitItem(productId)
    // 'error': o campo já ficou habilitado (sem conflict), então devolve o
    // foco a ele mesmo — nunca ao scanner/pesquisa — para retentar direto.
    // 'conflict'/'superseded': o item já mostra seu próprio aviso (banner de
    // conflito ou "Tentar novamente"); não force foco nenhum, só não avance.
    if (outcome === 'error') { quantityRefs.current[productId]?.focus(); return }
    if (outcome === 'conflict' || outcome === 'superseded') return
    const current = itemsRef.current.find((item) => item.productId === productId)
    if (current) {
      const comparison = compareStockCount(balanceByProduct, productId, current.quantity)
      if (requiresDivergenceReason(comparison, current.isCounted) && isReasonMissing(current)) return
    }
    setQuery(''); setHighlightedProductId(''); searchRef.current?.focus()
  }

  const focusConflictedItem = () => {
    const [firstConflictId] = Object.keys(itemConflictsRef.current)
    if (!firstConflictId) return
    itemRefs.current[firstConflictId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setHighlightedProductId(firstConflictId)
    window.setTimeout(() => setHighlightedProductId(''), 1400)
  }

  const changeStore = async (nextStoreId: string) => {
    if (!context) return
    setStoreId(nextStoreId); setQuery(''); setSuccess(''); setError(''); setLoading(true)
    try { await applyStoreData(nextStoreId, context) }
    catch (cause) { console.error('Falha ao consultar estoque:', cause); setError('Não foi possível consultar este local.') }
    finally { setLoading(false) }
  }

  const startDraft = async () => {
    if (!selectedStore || saving) return
    setSaving(true); setError(''); setSuccess('')
    try {
      // O catálogo completo só é carregado quando a contagem realmente começa.
      const nextProducts = products ?? await listActiveProducts(accountId)
      if (!products) setProducts(nextProducts)
      const nextStartedAt = initialDateTime()
      setStartedAt(nextStartedAt); startedAtRef.current = nextStartedAt
      const created = await saveMarketInventoryDraft(selectedStore.id, null, null, new Date(nextStartedAt).toISOString(), [])
      setCurrentDraft(created); setItems([]); itemsRef.current = []
      resetItemConcurrencyState(); setSaveState('saved'); setCounting(true)
    } catch (cause) {
      // Proteção backend contra dois rascunhos ativos na mesma loja
      // (unique_violation -> INVENTORY_DRAFT_CONFLICT) não é alterada — só
      // decide o que a UI faz quando ela dispara: outra tela/dispositivo já
      // criou o rascunho enquanto esta ainda mostrava "Novo/Iniciar
      // inventário". Carrega e entra automaticamente nesse rascunho já
      // existente, sem pedir reload nem exigir outro clique — mesmo
      // saneamento de motivo incoerente que resumeDraft aplica ao continuar
      // um rascunho salvo (duplicado aqui de propósito: resumeDraft parte do
      // estado `draft`, já carregado antes; aqui o rascunho só é conhecido
      // agora, na resposta deste conflito).
      if (isDraftAlreadyActive(cause)) {
        try {
          const existing = await getMarketInventoryDraft(accountId, selectedStore.id)
          if (existing) {
            const sanitizedProductIds: string[] = []
            const nextItems = existing.items.map((item) => {
              const comparison = compareStockCount(balanceByProduct, item.productId, item.quantity)
              if (!reasonNeedsReset(item.reasonCode, comparison, item.isCounted)) return item
              sanitizedProductIds.push(item.productId)
              return { ...item, reasonCode: null, reasonNote: null }
            })
            setCurrentDraft(existing); itemsRef.current = nextItems; setItems(nextItems)
            resetItemConcurrencyState(); setItemOrder(seedItemOrder(existing.items))
            setStartedAt(toLocalDateTime(existing.startedAt)); startedAtRef.current = toLocalDateTime(existing.startedAt)
            setSaveState('saved'); setCounting(true)
            sanitizedProductIds.forEach(markItemDirty)
            void Promise.all(sanitizedProductIds.map((id) => commitItem(id)))
            return
          }
        } catch (loadCause) { console.error('Falha ao carregar inventario ja ativo:', loadCause) }
      }
      console.error('Falha ao iniciar rascunho:', cause)
      setError('Não foi possível iniciar o inventário.')
    } finally { setSaving(false) }
  }

  const resumeDraft = async () => {
    if (!draft || saving) return
    setSaving(true); setError('')
    try {
      // Busca e scanner continuam usando o catálogo em memória durante a contagem.
      const nextProducts = products ?? await listActiveProducts(accountId)
      if (!products) setProducts(nextProducts)
      // Saneia o rascunho retomado: motivo salvo antes desta regra (ou cujo
      // saldo mudou desde o último save) pode estar incoerente com o sentido
      // atual da diferença — reasonNeedsReset decide com o mesmo critério
      // usado ao editar a quantidade. Zero e compatível ficam preservados.
      const sanitizedProductIds: string[] = []
      const nextItems = draft.items.map((item) => {
        const comparison = compareStockCount(balanceByProduct, item.productId, item.quantity)
        if (!reasonNeedsReset(item.reasonCode, comparison, item.isCounted)) return item
        sanitizedProductIds.push(item.productId)
        return { ...item, reasonCode: null, reasonNote: null }
      })
      itemsRef.current = nextItems; setItems(nextItems); setStartedAt(toLocalDateTime(draft.startedAt))
      // Ordem inicial da lista compartilhada a partir do rascunho retomado
      // (draft.items já vem ordenado por created_at — ver seedItemOrder).
      setItemOrder(seedItemOrder(draft.items))
      startedAtRef.current = toLocalDateTime(draft.startedAt); setSaveState('saved'); setCounting(true)
      // A limpeza precisa ser persistida — não deixar reason_code incoerente
      // sobrevivendo no rascunho salvo só porque nada mais mudou. Commit
      // direto por item, sem depender de nenhum autosave global.
      sanitizedProductIds.forEach(markItemDirty)
      void Promise.all(sanitizedProductIds.map((id) => commitItem(id)))
    } catch (cause) {
      console.error('Falha ao carregar produtos para continuar o inventario:', cause)
      setError('Não foi possível carregar o catálogo para continuar o inventário.')
    } finally { setSaving(false) }
  }

  const focusExistingItem = (productId: string) => {
    setHighlightedProductId(productId)
    window.setTimeout(() => { itemRefs.current[productId]?.scrollIntoView({ behavior: 'smooth', block: 'center' }); quantityRefs.current[productId]?.focus(); quantityRefs.current[productId]?.select() }, 0)
    window.setTimeout(() => setHighlightedProductId(''), 1400)
  }

  const selectProduct = (product: MarketStockProduct, focusQuantity = false) => {
    const existing = itemsRef.current.find((item) => item.productId === product.id)
    setQuery(''); setError('')
    if (existing) { focusExistingItem(product.id); return }
    // Antes de adicionar outro produto, garante que o item que estava sendo
    // editado já está confirmado no servidor (não bloqueia a UI por isso).
    void commitDirtyItems()
    // Produto recém-incluído entra "não contado" (não confundir com contado
    // como zero) — o operador ainda precisa informar a quantidade física,
    // qualquer que seja a origem (busca, EAN/GTIN, SKU/código externo, scanner).
    // Ainda não é persistido: só existe no servidor quando alguma contagem
    // real for informada (ver updateQuantity/commitItem).
    const next = [{ productId: product.id, quantity: 0, isCounted: false, reasonCode: null, reasonNote: null, version: null }, ...itemsRef.current]
    itemsRef.current = next; setItems(next); setHighlightedProductId(product.id)
    if (focusQuantity) focusExistingItem(product.id)
    else window.setTimeout(() => { setHighlightedProductId(''); searchRef.current?.focus() }, 500)
  }

  const changeSearch = (value: string) => {
    const exactProduct = findExactMarketStockProduct(products ?? [], value)
    if (exactProduct) { selectProduct(exactProduct, true); return }
    setQuery(value)
  }

  const handleScannedCode = (code: string) => {
    setScannerOpen(false); setError('')
    const loadedProducts = products ?? []
    const exactProduct = findExactMarketStockProduct(loadedProducts, code)
    if (exactProduct) { selectProduct(exactProduct, true); return }
    const matches = findMarketStockProducts(loadedProducts, code)
    setQuery(code)
    setError(matches.length
      ? 'Este código corresponde a mais de um produto. Escolha o item correto na lista.'
      : `Código ${code} não encontrado. Você pode continuar pela busca manual.`)
    window.setTimeout(() => searchRef.current?.focus(), 0)
  }

  // Qualquer número válido informado, inclusive zero, marca isCounted=true —
  // zero é uma contagem real e consciente, diferente de "ainda não contado".
  // Motivo já selecionado é reavaliado contra a NOVA quantidade: diferença
  // zerada ou motivo incoerente com o novo sentido são limpos aqui mesmo
  // (reasonNeedsReset), nunca deixando um motivo "em espera" inválido. Só
  // marca dirty — a gravação em si acontece nos pontos de saída do item
  // (blur, Enter, próximo produto, finalizar), nunca a cada tecla.
  const updateQuantity = (productId: string, quantity: number) => {
    const safeQuantity = Number.isFinite(quantity) ? Math.max(0, quantity) : 0
    const next = itemsRef.current.map((item) => {
      if (item.productId !== productId) return item
      const comparison = compareStockCount(balanceByProduct, productId, safeQuantity)
      const resetReason = reasonNeedsReset(item.reasonCode, comparison, true)
      return { ...item, quantity: safeQuantity, isCounted: true, reasonCode: resetReason ? null : item.reasonCode, reasonNote: resetReason ? null : item.reasonNote }
    })
    itemsRef.current = next; setItems(next); markItemDirty(productId)
  }

  // Campo de quantidade apagado pelo operador: volta para "não contado" (não
  // deixa um "0 contado" residual apenas por ter limpado o campo). Sem
  // contagem não há divergência a justificar — motivo sempre limpo junto.
  const clearQuantity = (productId: string) => {
    const next = itemsRef.current.map((item) => item.productId === productId ? { ...item, quantity: 0, isCounted: false, reasonCode: null, reasonNote: null } : item)
    itemsRef.current = next; setItems(next); markItemDirty(productId)
  }

  // Config independente da contagem (market_store_products.minimum_stock):
  // nunca passa por markItemDirty/dirtyItemIdsRef, nunca bloqueia fechar ou
  // finalizar o inventário, nunca gera movimento de estoque. Vazio no campo
  // = a chave em minimumStockInput existe com string vazia (não confundir
  // com "campo nunca editado", onde a chave está ausente).
  const minimumStockInputValue = (productId: string) => {
    if (productId in minimumStockInput) return minimumStockInput[productId]
    const stored = minimumStockRef.current[productId]
    return stored === null || stored === undefined ? '' : String(stored)
  }

  const changeMinimumStockInput = (productId: string, raw: string) => {
    setMinimumStockInput((prev) => ({ ...prev, [productId]: raw }))
  }

  // Núcleo do salvamento (extraído de commitMinimumStock só para ser
  // reaproveitado por stepMinimumStock — mesmíssima regra de antes: só
  // chama o servidor quando o valor final realmente difere do último
  // conhecido, nunca sobrescreve sale_price/status/is_essential (upsert só
  // envia minimum_stock, ver saveMarketStoreProductMinimumStock).
  const persistMinimumStock = async (productId: string, next: number | null) => {
    const previous = minimumStockRef.current[productId] ?? null
    if (next === previous) {
      setMinimumStockInput((prev) => { const clone = { ...prev }; delete clone[productId]; return clone })
      return
    }
    setMinimumStockSaveState((prev) => ({ ...prev, [productId]: 'saving' }))
    try {
      await saveMarketStoreProductMinimumStock(accountId, storeId, productId, next)
      setMinimumStock((prev) => ({ ...prev, [productId]: next }))
      setMinimumStockInput((prev) => { const clone = { ...prev }; delete clone[productId]; return clone })
      setMinimumStockSaveState((prev) => { const clone = { ...prev }; delete clone[productId]; return clone })
    } catch (cause) {
      console.error('Falha ao salvar estoque minimo:', cause)
      setMinimumStockSaveState((prev) => ({ ...prev, [productId]: 'error' }))
    }
  }

  // Digitação livre no campo: só chama o servidor quando o campo foi de fato
  // editado (chave presente em minimumStockInput) — abrir/fechar sem
  // alteração nunca sobrescreve o que já estava salvo. Em erro, mantém
  // minimumStockInput[productId] intacto (não reverte o texto do operador)
  // para "Tentar novamente" reenviar o mesmo valor sem precisar digitar de novo.
  const commitMinimumStock = async (productId: string) => {
    const raw = minimumStockInput[productId]
    if (raw === undefined) return
    const trimmed = raw.trim()
    let next: number | null
    if (trimmed === '') { next = null }
    else {
      const parsed = Number(trimmed.replace(',', '.'))
      if (!Number.isFinite(parsed) || parsed < 0) {
        // Valor inválido: descarta a edição e volta a exibir o último valor
        // conhecido, sem chamar o servidor.
        setMinimumStockInput((prev) => { const clone = { ...prev }; delete clone[productId]; return clone })
        return
      }
      next = parsed
    }
    await persistMinimumStock(productId, next)
  }

  // Botões +/- do mínimo: escolha discreta (clique), não digitação tecla a
  // tecla — commit imediato, mesmo padrão já usado por updateReasonCode (que
  // também não espera blur). Nunca toca em item.quantity/isCounted — lê e
  // grava exclusivamente o estado do mínimo.
  const minimumStockNumericValue = (productId: string): number | null => {
    const raw = minimumStockInputValue(productId).trim()
    if (raw === '') return null
    const parsed = Number(raw.replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }

  const stepMinimumStock = (productId: string, delta: number) => {
    const current = minimumStockNumericValue(productId) ?? 0
    const next = Math.max(0, current + delta)
    changeMinimumStockInput(productId, String(next))
    void persistMinimumStock(productId, next)
  }

  // Escolha discreta num <select> (não é digitação tecla a tecla) — commit
  // imediato, sem esperar blur.
  const updateReasonCode = (productId: string, reasonCode: MarketInventoryReasonCode | null) => {
    const next = itemsRef.current.map((item) => item.productId === productId
      ? { ...item, reasonCode, reasonNote: reasonCode === 'OTHER' ? item.reasonNote : null }
      : item)
    itemsRef.current = next; setItems(next); markItemDirty(productId)
    void finishItemEditing(productId)
  }

  const updateReasonNote = (productId: string, reasonNote: string) => {
    const next = itemsRef.current.map((item) => item.productId === productId ? { ...item, reasonNote } : item)
    itemsRef.current = next; setItems(next); markItemDirty(productId)
  }

  // Remoção é uma operação por item própria (não um update): se o item nunca
  // foi persistido (version null), só existe localmente e sai sem RPC. Se já
  // existe no servidor, respeita a mesma version-check — nunca apaga
  // silenciosamente uma atualização mais nova de outro usuário.
  const removeCountedProduct = async (productId: string) => {
    const localItem = itemsRef.current.find((item) => item.productId === productId)
    if (!localItem) return
    if (localItem.version === null) {
      dirtyItemIdsRef.current.delete(productId)
      const next = itemsRef.current.filter((item) => item.productId !== productId)
      itemsRef.current = next; setItems(next); searchRef.current?.focus()
      return
    }
    setItemSaveState((prev) => ({ ...prev, [productId]: 'saving' }))
    try {
      const result = await removeMarketInventoryItem(draftRef.current!.id, productId, localItem.version)
      if (result.conflict) {
        setItemConflicts((prev) => ({ ...prev, [productId]: { productId, action: 'remove', localItem, serverItem: result.serverItem } }))
        setItemSaveState((prev) => ({ ...prev, [productId]: 'conflict' }))
        return
      }
      dirtyItemIdsRef.current.delete(productId)
      const next = itemsRef.current.filter((item) => item.productId !== productId)
      itemsRef.current = next; setItems(next)
      setItemSaveState((prev) => { const nextState = { ...prev }; delete nextState[productId]; return nextState })
      searchRef.current?.focus()
    } catch (cause) {
      if (isDraftUnavailable(cause)) { setSaveState('finalized-elsewhere'); return }
      console.error('Falha ao remover item do inventario:', cause)
      setItemSaveState((prev) => ({ ...prev, [productId]: 'error' }))
    }
  }

  // "Usar minha contagem": reaplica a edição local (o que já está em
  // itemsRef.current — inclusive se o operador editou de novo depois do
  // conflito aparecer) usando a version atual do servidor como base. Se
  // houver outra alteração concorrente antes desta resolução, commitItem
  // detecta de novo (retorna 'conflict' e substitui itemConflicts pelo
  // snapshot mais recente) — nunca sobrescreve silenciosamente.
  const resolveConflictUseMine = async (productId: string) => {
    const conflict = itemConflicts[productId]
    if (!conflict) return
    const baseVersion = conflict.serverItem ? conflict.serverItem.version : null
    if (conflict.action === 'remove') {
      dirtyItemIdsRef.current.add(productId)
      setItemSaveState((prev) => ({ ...prev, [productId]: 'saving' }))
      try {
        const result = await removeMarketInventoryItem(draftRef.current!.id, productId, baseVersion)
        if (result.conflict) {
          setItemConflicts((prev) => ({ ...prev, [productId]: { productId, action: 'remove', localItem: conflict.localItem, serverItem: result.serverItem } }))
          setItemSaveState((prev) => ({ ...prev, [productId]: 'conflict' }))
          return
        }
        dirtyItemIdsRef.current.delete(productId)
        setItemConflicts((prev) => { const next = { ...prev }; delete next[productId]; return next })
        const next = itemsRef.current.filter((item) => item.productId !== productId)
        itemsRef.current = next; setItems(next)
      } catch (cause) {
        if (isDraftUnavailable(cause)) { setSaveState('finalized-elsewhere'); return }
        setItemSaveState((prev) => ({ ...prev, [productId]: 'error' }))
      }
      return
    }
    dirtyItemIdsRef.current.add(productId)
    void commitItem(productId, baseVersion)
  }

  // "Usar contagem salva": adota o estado atual do servidor só para ESTE
  // item — nenhum outro item local é tocado. Sem chamada de rede: o
  // servidor já é a fonte autoritativa, só precisamos refletir localmente.
  const resolveConflictUseServer = (productId: string) => {
    const conflict = itemConflicts[productId]
    if (!conflict) return
    dirtyItemIdsRef.current.delete(productId)
    setItemConflicts((prev) => { const next = { ...prev }; delete next[productId]; return next })
    setItemSaveState((prev) => { const next = { ...prev }; delete next[productId]; return next })
    if (!conflict.serverItem) {
      const next = itemsRef.current.filter((item) => item.productId !== productId)
      itemsRef.current = next; setItems(next)
      return
    }
    const serverItem = conflict.serverItem
    const next = itemsRef.current.map((item) => item.productId === productId ? serverItem : item)
    itemsRef.current = next; setItems(next)
  }

  // Enter só dispara o blur — quem decide limpar a pesquisa/produto atual e
  // devolver o foco à busca é finishItemEditing, e só depois de confirmação
  // de sucesso do backend (nunca antes, ver regra 5).
  const finishQuantity = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault(); event.currentTarget.blur()
  }

  const updateStartedAt = async (value: string) => {
    setStartedAt(value); startedAtRef.current = value
    if (!draftRef.current) return
    setSaveState('saving')
    try {
      const saved = await saveMarketInventoryDraft(draftRef.current.marketStoreId, draftRef.current.id, draftRef.current.version, new Date(value).toISOString(), [])
      const merged = mergeDraftItems(itemsRef.current, saved.items, dirtyItemIdsRef.current)
      itemsRef.current = merged; setItems(merged)
      setCurrentDraft({ ...saved, items: merged })
      setSaveState('saved')
    } catch (cause) {
      setSaveState(isVersionConflict(cause) ? 'conflict' : isDraftUnavailable(cause) ? 'finalized-elsewhere' : 'error')
    }
  }

  const finalizeDraft = async () => {
    if (!draftRef.current || saving) return
    // Já bloqueado pelo botão desabilitado (unresolvedConflictCount > 0);
    // checagem aqui é defensiva contra qualquer corrida entre o clique e o
    // render — impede finalização silenciosa com conflito pendente.
    if (Object.keys(itemConflictsRef.current).length > 0) {
      setError('Existe uma contagem em conflito. Resolva o item destacado antes de finalizar o inventário.')
      focusConflictedItem()
      return
    }
    setSaving(true); setError('')
    try {
      const flush = await commitDirtyItems()
      if (!flush.ok) {
        if (flush.hasConflict) { setError('Existe uma contagem em conflito. Resolva o item destacado antes de finalizar o inventário.'); focusConflictedItem() }
        else setError('Não foi possível salvar as últimas alterações. Tente novamente.')
        return
      }
      if (!draftRef.current) return
      const inventoryType = draftRef.current.inventoryType
      await finalizeMarketInventoryDraft(draftRef.current.id, draftRef.current.version)
      setCurrentDraft(null); setItems([]); setCounting(false); setConfirming(false)
      setSuccess(inventoryType === 'cycle' ? 'Inventário concluído e saldo reconciliado com sucesso.' : 'Controle de estoque iniciado com sucesso.'); await load(storeId)
    } catch (cause) {
      console.error('Falha ao finalizar inventário:', cause)
      // O frontend já bloqueia estes casos antes de chegar aqui (botão
      // desabilitado); a RPC valida de novo por segurança — mensagem amigável
      // cobre o caso raro de o estado ter mudado em outro dispositivo/usuário.
      const message = String(cause instanceof Error ? cause.message : cause)
      setError(
        isVersionConflict(cause) ? 'Este inventário foi atualizado em outro dispositivo. Recarregue para continuar.'
        : message.includes('INVENTORY_DRAFT_UNAVAILABLE') ? 'Este inventário já foi finalizado por outro usuário.'
        : message.includes('INVENTORY_UNCOUNTED_ITEMS') ? 'Ainda existem produtos sem contagem informada.'
        : message.includes('INVENTORY_REASON_REQUIRED') ? 'Existem divergências de saldo sem motivo informado.'
        : message.includes('INVENTORY_REASON_SIGN_MISMATCH') ? 'Existem motivos de divergência incompatíveis com o sentido do ajuste (entrada ou saída).'
        : 'Não foi possível finalizar o inventário.'
      )
      if (isVersionConflict(cause)) setSaveState('conflict')
      if (message.includes('INVENTORY_DRAFT_UNAVAILABLE')) setSaveState('finalized-elsewhere')
      setConfirming(false)
    } finally { setSaving(false) }
  }

  const cancelDraft = async () => {
    if (!draftRef.current || saving) return
    setSaving(true); setError('')
    try {
      await cancelMarketInventoryDraft(draftRef.current.id, draftRef.current.version)
      setCurrentDraft(null); setItems([]); itemsRef.current = []; setCounting(false); setConfirmCancel(false); setSaveState('idle')
      // Best-effort: o inventário cancelado passa a aparecer em "Últimos
      // inventários" imediatamente, sem exigir reload da tela.
      void listMarketInventorySessions(accountId, storeId).then(setHistorySessions).catch((cause) => console.error('Falha ao atualizar historico apos cancelar:', cause))
    } catch (cause) {
      setError(isVersionConflict(cause) ? 'Este inventário foi atualizado em outro dispositivo. Recarregue antes de cancelar.' : 'Não foi possível cancelar o inventário.')
      if (isVersionConflict(cause)) setSaveState('conflict')
    } finally { setSaving(false) }
  }

  const leaveStock = async () => {
    if (counting) {
      // Conflito já conhecido: nem tenta reenviar — sai direto para o item.
      if (Object.keys(itemConflictsRef.current).length > 0) { setExitBlocked('back-conflict'); focusConflictedItem(); return }
      const flush = await commitDirtyItems()
      if (!flush.ok) { setExitBlocked(flush.hasConflict ? 'back-conflict' : 'back'); if (flush.hasConflict) focusConflictedItem(); return }
    }
    onBack()
  }

  // "Fechar inventário": sai da contagem sem finalizar (sem RPC, sem
  // movimento, sem tocar no saldo) e sem apagar o rascunho — cada item já
  // confirmado individualmente garante que a última alteração está salva
  // antes de sair. Volta para a tela de Estoque do mesmo local (não sai do
  // módulo, ao contrário de leaveStock): counting=false + draft preenchido
  // já reexibe sozinho o card "Inventário em andamento" com "Continuar inventário".
  const closeInventory = async () => {
    if (Object.keys(itemConflictsRef.current).length > 0) { setExitBlocked('close-conflict'); focusConflictedItem(); return }
    const flush = await commitDirtyItems()
    if (!flush.ok) { setExitBlocked(flush.hasConflict ? 'close-conflict' : 'close'); if (flush.hasConflict) focusConflictedItem(); return }
    setCounting(false); setConfirming(false)
  }

  const syncProducts = async () => {
    if (!productIntegrationId || productSyncing || context?.access.role === 'viewer') return
    setProductSyncing(true); setError(''); setSuccess('')
    try {
      const run = await synchronizeMarketProducts(accountId, productIntegrationId, 'inventory', productSyncRun, setProductSyncRun)
      if (run.status !== 'completed') throw new Error(run.errorMessage || 'Sincronizacao nao concluida.')
      const status = await getMarketProductSyncStatus(accountId, productIntegrationId)
      setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
      setProducts(null)
      setSuccess('Catalogo de produtos sincronizado com sucesso.')
    } catch (cause) {
      console.error('Falha ao sincronizar produtos no inventario:', cause)
      setError('Nao foi possivel sincronizar os produtos. O catalogo existente foi preservado.')
      try {
        const status = await getMarketProductSyncStatus(accountId, productIntegrationId)
        setProductSyncRun(status.run); setLastProductSync(status.lastCompletedRun)
      } catch { /* Mantem o ultimo estado confiavel carregado. */ }
    } finally { setProductSyncing(false) }
  }

  // "Últimos inventários" (fechamento da Sprint, item 3): abre/fecha o
  // detalhe de UMA conferência concluída — nunca o saldo atual da loja, só
  // os itens/quantidades registrados naquele inventário específico
  // (market_get_inventory_session). Clicar de novo no mesmo item fecha sem
  // nova chamada de rede.
  const toggleHistoryDetail = async (sessionId: string) => {
    if (historyOpenSessionId === sessionId) { setHistoryOpenSessionId(''); setHistoryDetail(null); return }
    setHistoryOpenSessionId(sessionId); setHistoryDetail(null); setHistoryDetailLoading(true)
    try {
      const detail = await getMarketInventorySession(sessionId)
      setHistoryDetail(detail)
    } catch (cause) {
      console.error('Falha ao carregar detalhe do inventario:', cause)
      setHistoryOpenSessionId('')
    } finally { setHistoryDetailLoading(false) }
  }

  if (loading && !context) return <div className="admin-message" role="status"><RefreshCw size={20} /> Carregando estoque...</div>
  if (!context) return <div className="admin-message is-error" role="alert"><p>{error || 'Estoque indisponível.'}</p><button className="button button-small button-outline" onClick={onBack}>Voltar</button></div>

  return <div className="market-stock-dashboard">
    {!counting && <section className="market-product-sync-card"><div><span className="panel-kicker">CATÁLOGO</span><h2>Última sincronização de produtos</h2><p>{lastProductSync?.finishedAt ? formatProductSyncDate(lastProductSync.finishedAt) : 'Nenhuma sincronização de produtos concluída.'}</p>{lastProductSync && <small>{number.format(lastProductSync.receivedCount)} produtos sincronizados</small>}{productSyncing && productSyncRun && <small>Página {productSyncRun.currentPage}{productSyncRun.totalPages ? ` de ${productSyncRun.totalPages}` : ''}</small>}</div>{context.access.role !== 'viewer' && <button className="button button-small" disabled={!productIntegrationId || productSyncing} onClick={() => void syncProducts()}><RefreshCw size={15} /> {productSyncing ? 'Sincronizando...' : productSyncRun?.status === 'running' ? 'Continuar sincronização' : 'Sincronizar produtos'}</button>}</section>}
    <button className="button button-small button-outline" onClick={() => void leaveStock()}><ArrowLeft size={16} /> Gestão do Mercado</button>
    <header className="market-import-header market-stock-header"><p className="eyebrow"><Boxes size={16} /> GiroMicro Market</p><h1>Estoque</h1><p>Conte os produtos direto pelo celular, sem sair da tela.</p></header>
    <div className="market-dashboard-filter"><label htmlFor="market-stock-store">Local de estoque</label><select id="market-stock-store" value={storeId} onChange={(event) => void changeStore(event.target.value)} disabled={loading || counting}><option value="">Selecione um local</option>{context.access.stores.map((store) => <option key={store.id} value={store.id}>{store.store_type === 'warehouse' ? 'Galpão' : 'Loja'} — {store.external_code ? `${store.external_code} — ` : ''}{store.name}</option>)}</select>{selectedStore && <span>{selectedStore.name}</span>}</div>
    {error && <div className="admin-message is-error" role="alert">{error}</div>}
    {success && <div className="admin-message" role="status"><CheckCircle2 size={18} /> {success}</div>}
    {/* 202609080005: conflito de item pendente nunca reenvia sozinho (loop) —
        só mantém o operador na tela e aponta para o item destacado. Falha
        genérica de salvamento continua com "Tentar novamente" como antes. */}
    {(exitBlocked === 'back-conflict' || exitBlocked === 'close-conflict') && <div className="market-draft-warning" role="alert"><p>Existe uma contagem em conflito. Resolva o item destacado antes de sair do inventário.</p><div><button className="button button-small button-outline" onClick={() => setExitBlocked(false)}>Continuar na tela</button><button className="button button-small" onClick={() => { setExitBlocked(false); focusConflictedItem() }}>Ver item em conflito</button></div></div>}
    {(exitBlocked === 'back' || exitBlocked === 'close') && <div className="market-draft-warning" role="alert"><p>Não foi possível salvar as últimas alterações. Continue nesta tela para não perder a contagem.</p><div><button className="button button-small button-outline" onClick={() => setExitBlocked(false)}>Continuar na tela</button><button className="button button-small" onClick={() => { const pending = exitBlocked; setExitBlocked(false); void (pending === 'close' ? closeInventory() : leaveStock()) }}>Tentar novamente</button></div></div>}
    {saveState === 'conflict' && <div className="market-draft-warning" role="alert"><p>Este inventário foi atualizado em outro dispositivo. Recarregue para continuar.</p><button className="button button-small" onClick={() => void load(storeId)}>Recarregar rascunho</button></div>}
    {/* Alerta superior duplicado removido de propósito para este estado: a
        mesma mensagem já aparece dentro da área da conferência (ver
        "market-inventory-empty" abaixo), único lugar onde saveState pode
        chegar a 'finalized-elsewhere' (só setado durante counting). */}

    {selectedStore && !selectedStore.stock_control_started_at && !counting && !draft && <section className="market-stock-start market-stock-welcome"><Boxes size={34} /><div><span className="panel-kicker">ESTOQUE</span><h2>Controle de estoque ainda não iniciado</h2><p>Faça uma contagem rápida dos produtos que estão neste local agora.</p></div>{context.canStart ? <button className="button market-stock-primary-action" disabled={saving} onClick={() => void startDraft()}>{saving ? 'Iniciando...' : 'Iniciar inventário'}</button> : <div className="admin-message">Seu perfil possui acesso somente para visualização.</div>}</section>}

    {selectedStore && !counting && draft && <section className="market-stock-start market-stock-welcome"><RefreshCw size={34} /><div><span className="panel-kicker">{draft.inventoryType === 'cycle' ? 'CONFERÊNCIA SALVA' : 'RASCUNHO SALVO'}</span><h2>Inventário em andamento</h2><p>{draft.items.length} {draft.items.length === 1 ? 'produto contado' : 'produtos contados'} · última atualização {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(draft.updatedAt))}</p></div>{context.canStart ? <div className="market-draft-actions"><button className="button" disabled={saving} onClick={() => void resumeDraft()}>{saving ? 'Carregando...' : 'Continuar inventário'}</button><button className="button button-outline" onClick={() => setConfirmCancel(true)}>Cancelar inventário</button></div> : <div className="admin-message">Seu perfil permite apenas visualizar este rascunho.</div>}{confirmCancel && <div className="market-inventory-confirm"><div><strong>Cancelar este rascunho?</strong><p>Nenhum movimento de estoque será criado.</p></div><div><button className="button button-outline" onClick={() => setConfirmCancel(false)}>Voltar</button><button className="button" disabled={saving} onClick={() => void cancelDraft()}>{saving ? 'Cancelando...' : 'Confirmar cancelamento'}</button></div></div>}</section>}

    {selectedStore && counting && draft && <section className="market-quick-inventory">
      <header className="market-quick-heading"><div><span className="panel-kicker">{isCycleInventory ? 'CONFERÊNCIA DE ESTOQUE' : 'INVENTÁRIO RÁPIDO'}</span><h2>{selectedStore.name}</h2></div><div className={`market-draft-status ${saveState}`}><strong>{countedItems.length} {countedItems.length === 1 ? 'produto contado' : 'produtos contados'}</strong><small>{saveState === 'saving' ? 'Salvando...' : saveState === 'saved' ? 'Rascunho salvo' : saveState === 'error' ? 'Não foi possível salvar' : saveState === 'conflict' ? 'Conflito em outro dispositivo' : saveState === 'finalized-elsewhere' ? 'Inventário finalizado por outro usuário' : 'Alterações locais'}</small></div></header>
      {saveState === 'finalized-elsewhere' ? <div className="market-inventory-empty"><p>Este inventário já foi finalizado por outro usuário. Atualize para ver o estado atual.</p><button className="button button-small" onClick={() => void load(storeId)}>Atualizar</button></div> : <>
      <div className="market-product-search"><Search size={23} /><input ref={searchRef} type="search" inputMode="search" autoComplete="off" placeholder="Buscar por nome, EAN, código externo ou SKU" value={query} onChange={(event) => changeSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && searchResults[0]) { event.preventDefault(); selectProduct(searchResults[0]) } }} /><button className="market-scanner-button" type="button" onClick={() => setScannerOpen(true)} aria-label="Escanear código de barras"><ScanBarcode /></button><small>EAN, código externo ou SKU exato entra automaticamente. Para nomes, pressione Enter ou escolha o produto.</small></div>
      {query && <div className="market-product-results" role="listbox">{searchResults.length ? searchResults.map((product) => <button key={product.id} type="button" onClick={() => selectProduct(product)}><span><strong>{product.name}</strong><small>{productIdentifier(product)}</small></span></button>) : <p>Nenhum produto encontrado.</p>}</div>}
      <div className="market-counted-products">{orderedItems.length ? orderedItems.map((item) => {
        const product = products?.find((candidate) => candidate.id === item.productId)
        if (!product) return null
        // Mesma comparação para qualquer origem do item (draft já carregado,
        // busca por nome, EAN/GTIN, código externo/SKU ou scanner): todas
        // resolvem productId e passam por balanceByProduct, a mesma Map já
        // usada acima. "known: false" (nunca movimentou neste local) nunca
        // vira "Saldo 0" silenciosamente — mostra o estado explícito abaixo.
        const comparison = compareStockCount(balanceByProduct, item.productId, item.quantity)
        const needsReason = requiresDivergenceReason(comparison, item.isCounted)
        const balanceLabel = comparison.known ? number.format(comparison.currentQuantity) : 'não registrado'
        const countedLabel = item.isCounted ? number.format(comparison.countedQuantity) : '—'
        const showDifference = item.isCounted && comparison.known
        const differenceLabel = showDifference ? `${comparison.difference > 0 ? '+' : ''}${number.format(comparison.difference)}` : '—'
        const differenceClass = showDifference ? (comparison.difference > 0 ? 'is-positive' : comparison.difference < 0 ? 'is-negative' : '') : ''
        const conflict = itemConflicts[item.productId]
        const itemState = itemSaveState[item.productId]
        return <article ref={(element) => { itemRefs.current[item.productId] = element }} className={`${item.isCounted && item.quantity === 0 && !isCycleInventory ? 'is-zero ' : ''}${highlightedProductId === item.productId ? 'is-highlighted' : ''}`} key={item.productId}>
          <div className="market-counted-product-name"><strong>{product.name}</strong><small>{productIdentifier(product)}</small>{(isCycleInventory || comparison.known) && <span className="market-stock-comparison">Saldo {balanceLabel} · Contagem {countedLabel} · <b className={differenceClass}>Diferença {differenceLabel}</b></span>}</div>
          <div className="market-count-controls">
            <div className="market-quantity-stepper">
              {/* "-" em item não contado fica desabilitado: não há de onde
                  decrementar ainda, e decidir sozinho "0 contado" via minus
                  seria confuso (minus implica reduzir um número existente). */}
              <button type="button" aria-label={`Diminuir quantidade de ${product.name}`} disabled={!item.isCounted || Boolean(conflict)} onClick={() => updateQuantity(item.productId, item.quantity - 1)}><Minus /></button>
              <input aria-label={`Quantidade contada de ${product.name}`} ref={(element) => { quantityRefs.current[item.productId] = element }} type="number" min="0" step="0.001" inputMode="decimal" placeholder="—" disabled={Boolean(conflict)}
                value={item.isCounted ? item.quantity : ''}
                onChange={(event) => { const raw = event.target.value; if (raw.trim() === '') clearQuantity(item.productId); else updateQuantity(item.productId, Number(raw)) }}
                onKeyDown={finishQuantity} onFocus={(event) => event.target.select()} onBlur={() => void finishItemEditing(item.productId)} />
              {/* "+" em item não contado inicia em 1 e já marca contado. */}
              <button type="button" aria-label={`Aumentar quantidade de ${product.name}`} disabled={Boolean(conflict)} onClick={() => updateQuantity(item.productId, (item.isCounted ? item.quantity : 0) + 1)}><Plus /></button>
            </div>
            {/* Estoque mínimo (opcional, market_store_products.minimum_stock):
                mesmo padrão visual do stepper de quantidade (botão/valor/botão),
                mas totalmente independente — os botões e o campo aqui nunca
                tocam item.quantity/isCounted, só o mínimo configurado para a
                loja. Vazio = não configurado (NULL); "0" = mínimo explícito. */}
            <div className="market-minimum-control">
              <span className="market-minimum-label">Mínimo</span>
              <div className="market-quantity-stepper market-minimum-stepper">
                <button type="button" aria-label={`Diminuir estoque mínimo de ${product.name}`} disabled={(minimumStockNumericValue(item.productId) ?? 0) <= 0} onClick={() => stepMinimumStock(item.productId, -1)}><Minus /></button>
                <input aria-label={`Estoque mínimo de ${product.name}`} type="number" min="0" step="0.001" inputMode="decimal" placeholder="—"
                  value={minimumStockInputValue(item.productId)}
                  onChange={(event) => changeMinimumStockInput(item.productId, event.target.value)}
                  onKeyDown={finishQuantity} onFocus={(event) => event.target.select()} onBlur={() => void commitMinimumStock(item.productId)} />
                <button type="button" aria-label={`Aumentar estoque mínimo de ${product.name}`} onClick={() => stepMinimumStock(item.productId, 1)}><Plus /></button>
              </div>
            </div>
          </div>
          {itemState === 'saving' && <small className="market-item-save-state">Salvando...</small>}
          {itemState === 'error' && <small className="market-item-save-state is-error">Não foi possível salvar. <button type="button" className="market-item-retry" onClick={() => { markItemDirty(item.productId); void finishItemEditing(item.productId) }}>Tentar novamente</button></small>}
          {minimumStockSaveState[item.productId] === 'saving' && <small className="market-item-save-state">Salvando mínimo...</small>}
          {minimumStockSaveState[item.productId] === 'error' && <small className="market-item-save-state is-error">Não foi possível salvar o estoque mínimo. <button type="button" className="market-item-retry" onClick={() => void commitMinimumStock(item.productId)}>Tentar novamente</button></small>}
          {/* Contado como zero é sempre persistido (202609080005) — em
              'initial' sem saldo anterior, o produto fica registrado no
              rascunho (visível para outro usuário), mas não gera movimento
              de estoque na finalização (nada a reconciliar). */}
          {item.isCounted && item.quantity === 0 && <small className="market-zero-note">{isCycleInventory ? 'Contado = 0. Este produto será reconciliado com saldo zero.' : 'Contado = 0. Este produto fica registrado, mas não gera movimento de estoque.'}</small>}
          {conflict && <div className="market-item-conflict" role="alert">
            <p><strong>{product.name}</strong> foi alterado por outro usuário antes de você salvar.</p>
            <p>Minha contagem: {conflict.action === 'remove' ? 'remover da contagem' : `${number.format(conflict.localItem.quantity)}${conflict.localItem.reasonCode ? ` · ${reasonLabels[conflict.localItem.reasonCode]}` : ''}`}</p>
            <p>Contagem atualmente salva: {conflict.serverItem ? `${number.format(conflict.serverItem.quantity)}${conflict.serverItem.reasonCode ? ` · ${reasonLabels[conflict.serverItem.reasonCode]}` : ''}` : 'produto removido por outro usuário'}</p>
            <div><button type="button" className="button button-small button-outline" onClick={() => void resolveConflictUseMine(item.productId)}>Usar minha contagem</button><button type="button" className="button button-small" onClick={() => resolveConflictUseServer(item.productId)}>Usar contagem salva</button></div>
          </div>}
          {needsReason && !conflict && <div className="market-stock-reason">
            <label>Motivo da divergência
              <select value={item.reasonCode ?? ''} onChange={(event) => updateReasonCode(item.productId, (event.target.value || null) as MarketInventoryReasonCode | null)}>
                <option value="">Selecione o motivo</option>
                {reasonCodes.filter((code) => isReasonCodeAllowedForDifference(code, comparison.difference)).map((code) => <option key={code} value={code}>{reasonLabels[code]}</option>)}
              </select>
            </label>
            {item.reasonCode === 'OTHER' && <label>Observação
              <input value={item.reasonNote ?? ''} onChange={(event) => updateReasonNote(item.productId, event.target.value)} onBlur={() => void finishItemEditing(item.productId)} placeholder="Descreva o motivo" />
            </label>}
          </div>}
          {isCycleInventory && !conflict && <button className="market-remove-counted" type="button" onClick={() => void removeCountedProduct(item.productId)}><Trash2 size={15} /> Remover da contagem</button>}
        </article>
      }) : <div className="market-inventory-empty"><Search size={25} /><p>Busque o primeiro produto para começar.</p></div>}</div>
      <label className="market-stock-start-date">{isCycleInventory ? 'Data e hora da conferência' : 'Data e hora do marco inicial'}<input type="datetime-local" value={startedAt} onChange={(event) => void updateStartedAt(event.target.value)} /></label>
      {saveState === 'error' && <button className="button button-small button-outline" onClick={() => void updateStartedAt(startedAt)}>Tentar salvar novamente</button>}
      {/* Bloqueio (regra 3/4/5 + conflitos pendentes): também validado no
          backend (market_finalize_inventory_draft/market_save_inventory_item),
          para não depender só da UI. */}
      {!confirming && (uncountedItems.length > 0 || itemsNeedingReason.length > 0 || unresolvedConflictCount > 0) && <div className="market-inventory-block-note" role="status">
        {uncountedItems.length > 0 && <p>Ainda existem produtos sem contagem informada.</p>}
        {itemsNeedingReason.length > 0 && <p>Existem divergências de saldo sem motivo informado.</p>}
        {unresolvedConflictCount > 0 && <p>Existem divergências de contagem com outro usuário ainda não resolvidas.</p>}
      </div>}
      {!confirming ? <div className="market-inventory-finish"><span>{countedItems.length} {countedItems.length === 1 ? (isCycleInventory ? 'produto será reconciliado' : 'produto será enviado') : (isCycleInventory ? 'produtos serão reconciliados' : 'produtos serão enviados')}</span><button className="button button-outline" disabled={saveState === 'conflict'} onClick={() => void closeInventory()}>Fechar inventário</button><button className="button" disabled={!countedItems.length || !startedAt || saveState === 'conflict' || uncountedItems.length > 0 || itemsNeedingReason.length > 0 || unresolvedConflictCount > 0} onClick={() => { void syncDraftItems(); setConfirming(true) }}>Finalizar inventário</button></div> : <div className="market-inventory-confirm"><div><span className="panel-kicker">CONFIRMAR INVENTÁRIO</span><h3>{selectedStore.name}</h3>{isCycleInventory ? <div className="market-cycle-summary"><p><strong>{items.length}</strong> produtos contados</p><p><strong>{cycleSummary.adjustmentInProducts}</strong> ajustes de entrada · {number.format(cycleSummary.adjustmentInQuantity)} unidades</p><p><strong>{cycleSummary.adjustmentOutProducts}</strong> ajustes de saída · {number.format(cycleSummary.adjustmentOutQuantity)} unidades</p><p><strong>{cycleSummary.unchangedProducts}</strong> sem diferença</p></div> : <p>{positiveItems.length} {positiveItems.length === 1 ? 'produto contado' : 'produtos contados'} · marco em {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(startedAt))}</p>}</div><div><button className="button button-outline" disabled={saving} onClick={() => setConfirming(false)}>Continuar inventário</button><button className="button" disabled={saving} onClick={() => void finalizeDraft()}>{saving ? 'Finalizando...' : isCycleInventory ? 'Confirmar inventário' : 'Confirmar e iniciar estoque'}</button></div></div>}
      </>}
    </section>}

    {selectedStore?.stock_control_started_at && !counting && <section className="market-stock-balance">
      <div><span className="panel-kicker">INVENTÁRIOS</span><h2>Controle de estoque iniciado</h2><p>Marco inicial: {new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(selectedStore.stock_control_started_at))}</p><p>As contagens são salvas durante o inventário, mas o saldo do estoque só é atualizado após a finalização.</p></div>
      {!draft && context.canStart && <button className="button market-stock-primary-action" disabled={saving} onClick={() => void startDraft()}>{saving ? 'Iniciando...' : 'Novo inventário'}</button>}
      {/* "Últimos inventários" (fechamento da Sprint, item 3): substitui a
          listagem de saldo atual — cada linha representa uma CONFERÊNCIA já
          concluída/cancelada, não o saldo vigente da loja. Clicar em um
          inventário concluído abre o detalhe daquela conferência específica
          (market_get_inventory_session, 202609090001). */}
      <div className="market-inventory-history">
        <h3>Últimos inventários</h3>
        {!historySessions
          ? <div className="admin-message" role="status"><RefreshCw size={18} /> Carregando histórico...</div>
          : !historySessions.length
            ? <div className="admin-message">Nenhum inventário concluído neste local ainda.</div>
            : <ul className="market-history-list">{historySessions.map((session) => {
                const isCompleted = session.status === 'completed'
                const isOpen = historyOpenSessionId === session.id
                const referenceDate = session.completedAt ?? session.cancelledAt ?? session.updatedAt
                return <li key={session.id} className={isOpen ? 'is-open' : ''}>
                  <button type="button" className="market-history-item" disabled={!isCompleted} onClick={() => void toggleHistoryDetail(session.id)}>
                    <span className={`market-history-status is-${session.status}`}>{isCompleted ? 'Concluído' : 'Cancelado'}</span>
                    <span>{new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(referenceDate))}</span>
                    <span>{session.countedProducts} {session.countedProducts === 1 ? 'produto contado' : 'produtos contados'}</span>
                  </button>
                  {isOpen && <div className="market-history-detail">
                    {historyDetailLoading
                      ? <p>Carregando itens...</p>
                      : historyDetail?.items.length
                        ? <div className="market-preview-table-wrap"><table className="market-preview-table market-stock-table"><thead><tr><th>Produto</th><th>Identificador</th><th>Contagem</th></tr></thead><tbody>{historyDetail.items.map((item) => <tr key={item.productId}><td>{item.productName}</td><td>{item.ean ? `EAN ${item.ean}` : item.sku ? `SKU ${item.sku}` : item.unit}</td><td><strong>{item.isCounted ? number.format(item.quantity) : '—'} {item.unit}</strong></td></tr>)}</tbody></table></div>
                        : <p>Nenhum item registrado nesta conferência.</p>}
                  </div>}
                </li>
              })}</ul>}
      </div>
    </section>}
    {scannerOpen && <BarcodeScanner onDetected={handleScannedCode} onClose={() => { setScannerOpen(false); window.setTimeout(() => searchRef.current?.focus(), 0) }} />}
  </div>
}
