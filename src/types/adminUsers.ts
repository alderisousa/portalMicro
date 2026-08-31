export type BusinessMemberRole = 'owner' | 'admin' | 'editor' | 'viewer'
export type BusinessMemberStatus = 'active' | 'disabled'
export type BusinessPlanCode = 'free' | 'pilot' | 'pro'

export interface AdminAuthenticatedUser {
  user_id: string
  email: string | null
  full_name: string | null
  avatar_url: string | null
  provider: string | null
  auth_created_at: string
  last_sign_in_at: string | null
  business_count: number
  owned_business_count: number
  market_account_count: number
}

export interface AdminUserDetail {
  user_id: string
  email: string | null
  full_name: string | null
  avatar_url: string | null
  provider: string | null
  auth_created_at: string
  last_sign_in_at: string | null
}

export interface AdminUserBusiness {
  business_id: string
  business_name: string | null
  slug: string | null
  status: string
  plan_code: string
  template_key: string | null
  role: BusinessMemberRole
  member_status: BusinessMemberStatus
  legacy_owner: boolean
}
