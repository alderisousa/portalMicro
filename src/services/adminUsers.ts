import { supabase } from '../lib/supabase'
import type {
  AdminAuthenticatedUser,
  AdminUserBusiness,
  AdminUserDetail,
  BusinessMemberRole,
  BusinessMemberStatus,
  BusinessPlanCode,
} from '../types/adminUsers'

const rpcData = async <T>(
  name: string,
  parameters?: Record<string, unknown>
): Promise<T> => {
  const { data, error } = await supabase.rpc(name, parameters)
  if (error) throw error
  return data as T
}

export const listAuthenticatedUsers = () =>
  rpcData<AdminAuthenticatedUser[]>('admin_list_authenticated_users')

export const getAuthenticatedUser = async (userId: string) => {
  const data = await rpcData<AdminUserDetail[] | AdminUserDetail>(
    'admin_get_authenticated_user',
    { p_user_id: userId }
  )
  return Array.isArray(data) ? (data[0] ?? null) : data
}

export const listUserBusinesses = (userId: string) =>
  rpcData<AdminUserBusiness[]>('admin_list_user_businesses', {
    p_user_id: userId,
  })

export const linkUserToBusiness = (
  userId: string,
  businessId: string,
  role: BusinessMemberRole,
  makeLegacyOwner: boolean
) =>
  rpcData<unknown>('admin_link_user_to_business', {
    p_user_id: userId,
    p_business_id: businessId,
    p_role: role,
    p_make_legacy_owner: makeLegacyOwner,
  })

export const updateBusinessMember = (
  businessId: string,
  userId: string,
  role: BusinessMemberRole,
  status: BusinessMemberStatus
) =>
  rpcData<unknown>('admin_update_business_member', {
    p_business_id: businessId,
    p_user_id: userId,
    p_role: role,
    p_status: status,
  })

export const unlinkUserFromBusiness = (businessId: string, userId: string) =>
  rpcData<unknown>('admin_unlink_user_from_business', {
    p_business_id: businessId,
    p_user_id: userId,
  })

export const setBusinessPlan = (
  businessId: string,
  planCode: BusinessPlanCode
) =>
  rpcData<unknown>('admin_set_business_plan', {
    p_business_id: businessId,
    p_plan_code: planCode,
  })

export const createMarketAccount = (
  name: string,
  ownerUserId: string,
  planCode: BusinessPlanCode
) =>
  rpcData<unknown>('admin_create_market_account', {
    p_name: name,
    p_owner_user_id: ownerUserId,
    p_plan_code: planCode,
    p_partner_referrer_user_id: null,
  })
