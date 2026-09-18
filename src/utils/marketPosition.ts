import type { CurrentUserMarketAccess, MarketMemberRole, MarketStore } from '../types/market'

export const marketModules = ['dashboard', 'stock', 'replenishment', 'purchases', 'commercial', 'imports', 'duplicates', 'replenishmentSettings', 'storeProductParameters', 'saleMargin'] as const
export type MarketModule = typeof marketModules[number]
export type PurchasingView = 'buy' | 'waiting' | 'supply'
export interface StockPosition { storeId: string; counting: boolean }
export interface ReplenishmentPosition { orderId: string; storeId: string; view: PurchasingView }
export interface MarketPosition {
  version: 1
  userId: string
  marketAccountId: string
  module: MarketModule
  savedAt: number
  stock?: StockPosition
  replenishment?: ReplenishmentPosition
}
const prefix = 'giromicro:market-position:v1:'
const key = (userId: string) => prefix + encodeURIComponent(userId)
const id = (value: unknown): value is string => typeof value === 'string' && value.length <= 128
export const purchasingView = (value: unknown): PurchasingView => value === 'waiting' || value === 'supply' ? value : 'buy'
// Posicao mais velha que isso e tratada como fluxo inicial normal/Home, nao como retomada.
export const marketPositionMaxAgeMs = 60 * 60 * 1000

// Lista explicita de campos: nunca serializa props, rascunhos ou dados de operacao.
function sanitize(value: unknown, userId: string): MarketPosition | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<MarketPosition>
  if (v.version !== 1 || v.userId !== userId || !id(v.marketAccountId) || !v.marketAccountId
    || !marketModules.includes(v.module as MarketModule)
    || typeof v.savedAt !== 'number' || !Number.isFinite(v.savedAt)) return null
  const result: MarketPosition = { version: 1, userId, marketAccountId: v.marketAccountId, module: v.module!, savedAt: v.savedAt }
  if (v.module === 'stock' && v.stock && id(v.stock.storeId)) result.stock = { storeId: v.stock.storeId, counting: v.stock.counting === true }
  if (v.module === 'replenishment' && v.replenishment) result.replenishment = {
    orderId: id(v.replenishment.orderId) ? v.replenishment.orderId : '',
    storeId: id(v.replenishment.storeId) ? v.replenishment.storeId : '',
    view: purchasingView(v.replenishment.view),
  }
  return result
}
export function clearMarketPosition(userId: string): void {
  if (!userId) return
  try { localStorage.removeItem(key(userId)) } catch { /* Armazenamento indisponivel nao bloqueia a navegacao. */ }
}
export function readMarketPosition(userId: string, accountId?: string): MarketPosition | null {
  if (!userId || userId === 'demo-user') return null
  try {
    const raw = localStorage.getItem(key(userId))
    if (!raw) return null
    const result = sanitize(JSON.parse(raw), userId)
    if (!result || Date.now() - result.savedAt >= marketPositionMaxAgeMs) { clearMarketPosition(userId); return null }
    return accountId && result.marketAccountId !== accountId ? null : result
  } catch { clearMarketPosition(userId); return null }
}
export function writeMarketPosition(position: Omit<MarketPosition, 'savedAt'>): void {
  if (!position.userId || position.userId === 'demo-user') return
  try {
    const safe = sanitize({ ...position, savedAt: Date.now() }, position.userId)
    if (safe) localStorage.setItem(key(position.userId), JSON.stringify(safe))
  } catch { /* Quota/modo privado: permanece funcional sem retomada. */ }
}
export function saveMarketModule(userId: string, marketAccountId: string, module: MarketModule): void {
  const previous = readMarketPosition(userId, marketAccountId)
  if (previous?.module === module) return
  writeMarketPosition({ version: 1, userId, marketAccountId, module })
}
export function canRestoreMarketModule(module: MarketModule, role: MarketMemberRole, integration: boolean | null): boolean {
  if (module === 'imports') return integration === false && ['owner', 'admin', 'manager'].includes(role)
  if (module === 'replenishmentSettings') return ['owner', 'admin', 'manager'].includes(role)
  if (module === 'storeProductParameters' || module === 'saleMargin') return ['owner', 'admin', 'manager', 'operator'].includes(role)
  if (module === 'purchases') return role !== 'operator'
  return true
}
export function accessiblePositionAccount(position: MarketPosition, accounts: CurrentUserMarketAccess[]) {
  return accounts.find(account => account.id === position.marketAccountId && account.member_status === 'active' && ['pilot', 'active'].includes(account.status))
}
export function validPositionStore(storeId: string, stores: MarketStore[]): string {
  return stores.some(store => store.id === storeId && store.status === 'active') ? storeId : ''
}
export function canResumeInventory(position: StockPosition | undefined, storeId: string, accountId: string,
  canStart: boolean, draft: { marketAccountId: string; marketStoreId: string; status: string } | null): boolean {
  return !!position?.counting && position.storeId === storeId && canStart && !!draft
    && draft.marketAccountId === accountId && draft.marketStoreId === storeId && draft.status === 'draft'
}
