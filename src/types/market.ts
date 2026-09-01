export type MarketPlanCode = 'pilot' | 'pro'
export type MarketAccountStatus = 'pilot' | 'active' | 'suspended' | 'cancelled'
export type MarketMemberRole = 'owner' | 'admin' | 'manager' | 'operator' | 'viewer'
export type MarketMemberStatus = 'active' | 'invited' | 'disabled'
export type MarketStoreStatus = 'active' | 'inactive'

export interface MarketAccount {
  id: string
  name: string
  plan_code: string
  status: MarketAccountStatus
  created_at: string
}

export interface MarketAccountMember {
  id: string
  market_account_id: string
  user_id: string
  role: MarketMemberRole
  all_stores: boolean
  status: MarketMemberStatus
  full_name?: string | null
  email?: string | null
  store_ids?: string[]
}

export interface MarketStore {
  id: string
  market_account_id: string
  name: string
  external_code: string | null
  description: string | null
  status: MarketStoreStatus
  stock_control_started_at: string | null
  created_at: string
}

export interface CurrentUserMarketAccess extends MarketAccount {
  member_id: string
  role: MarketMemberRole
  all_stores: boolean
  member_status: MarketMemberStatus
  stores: MarketStore[]
}

export interface AdminUserMarketAccount extends CurrentUserMarketAccess {
  store_count: number
}

export type AdminMarketLinkRole = 'manager' | 'operator' | 'viewer'

export interface AdminMarketLinkAccount {
  id: string
  name: string
  status: Extract<MarketAccountStatus, 'pilot' | 'active'>
}

export interface AdminMarketLinkStore {
  id: string
  name: string
  externalCode: string | null
  status: 'active'
}

export type MarketStoreInput = {
  name: string
  external_code: string | null
  description: string | null
  status: MarketStoreStatus
}
