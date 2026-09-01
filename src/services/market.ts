import { supabase } from '../lib/supabase'
import type {
  AdminUserMarketAccount,
  CurrentUserMarketAccess,
  MarketAccount,
  MarketAccountMember,
  MarketStore,
  MarketStoreInput,
} from '../types/market'

const throwIfError = (error: unknown) => {
  if (error) throw error
}

export async function listMarketStores(accountId: string): Promise<MarketStore[]> {
  const { data, error } = await supabase
    .from('market_stores')
    .select('id, market_account_id, name, external_code, description, status, stock_control_started_at, created_at')
    .eq('market_account_id', accountId)
    .order('name')
  throwIfError(error)
  return (data ?? []) as MarketStore[]
}

async function listMarketStoresForMembership(accountId: string, member: MarketAccountMember): Promise<MarketStore[]> {
  if (member.all_stores || member.role === 'owner' || member.role === 'admin') return listMarketStores(accountId)
  const { data, error } = await supabase
    .from('market_member_stores')
    .select('market_store_id')
    .eq('market_account_member_id', member.id)
  throwIfError(error)
  const allowedIds = (data ?? []).map((link) => link.market_store_id)
  if (!allowedIds.length) return []
  const { data: stores, error: storesError } = await supabase
    .from('market_stores')
    .select('id, market_account_id, name, external_code, description, status, stock_control_started_at, created_at')
    .eq('market_account_id', accountId)
    .in('id', allowedIds)
    .order('name')
  throwIfError(storesError)
  return (stores ?? []) as MarketStore[]
}

export async function getMarketAccount(accountId: string): Promise<MarketAccount | null> {
  const { data, error } = await supabase
    .from('market_accounts')
    .select('id, name, plan_code, status, created_at')
    .eq('id', accountId)
    .maybeSingle()
  throwIfError(error)
  return data as MarketAccount | null
}

export async function listMarketMembers(accountId: string): Promise<MarketAccountMember[]> {
  const { data, error } = await supabase
    .from('market_account_members')
    .select('id, market_account_id, user_id, role, all_stores, status')
    .eq('market_account_id', accountId)
    .order('created_at')
  throwIfError(error)
  const members = (data ?? []) as MarketAccountMember[]
  if (!members.length) return []
  const { data: storeLinks, error: storeLinksError } = await supabase
    .from('market_member_stores')
    .select('market_account_member_id, market_store_id')
    .in('market_account_member_id', members.map((member) => member.id))
  throwIfError(storeLinksError)
  return members.map((member) => ({
    ...member,
    store_ids: (storeLinks ?? [])
      .filter((link) => link.market_account_member_id === member.id)
      .map((link) => link.market_store_id),
  }))
}

async function listAccountsForMemberships(
  memberships: MarketAccountMember[]
): Promise<CurrentUserMarketAccess[]> {
  if (!memberships.length) return []
  const accountIds = memberships.map((member) => member.market_account_id)
  const { data, error } = await supabase
    .from('market_accounts')
    .select('id, name, plan_code, status, created_at')
    .in('id', accountIds)
    .order('name')
  throwIfError(error)
  const accounts = (data ?? []) as MarketAccount[]

  return Promise.all(accounts.map(async (account) => {
    const member = memberships.find((item) => item.market_account_id === account.id)!
    return {
      ...account,
      member_id: member.id,
      role: member.role,
      all_stores: member.all_stores,
      member_status: member.status,
      stores: account.status === 'pilot' || account.status === 'active'
        ? await listMarketStoresForMembership(account.id, member)
        : [],
    }
  }))
}

export async function listUserMarketAccounts(userId: string): Promise<AdminUserMarketAccount[]> {
  const { data, error } = await supabase
    .from('market_account_members')
    .select('id, market_account_id, user_id, role, all_stores, status')
    .eq('user_id', userId)
    .order('created_at')
  throwIfError(error)
  const accounts = await listAccountsForMemberships((data ?? []) as MarketAccountMember[])
  return Promise.all(accounts.map(async (account) => {
    const stores = account.status === 'suspended' || account.status === 'cancelled'
      ? await listMarketStores(account.id)
      : account.stores
    return { ...account, stores, store_count: stores.length }
  }))
}

export async function listCurrentUserMarketAccounts(): Promise<CurrentUserMarketAccess[]> {
  const { data: authData, error: authError } = await supabase.auth.getUser()
  throwIfError(authError)
  if (!authData.user) return []
  const { data, error } = await supabase
    .from('market_account_members')
    .select('id, market_account_id, user_id, role, all_stores, status')
    .eq('user_id', authData.user.id)
    .eq('status', 'active')
    .order('created_at')
  throwIfError(error)
  return listAccountsForMemberships((data ?? []) as MarketAccountMember[])
}

export async function getCurrentUserMarketAccess(
  accountId: string
): Promise<CurrentUserMarketAccess | null> {
  const { data: authData, error: authError } = await supabase.auth.getUser()
  throwIfError(authError)
  if (!authData.user) return null

  const { data: member, error: memberError } = await supabase
    .from('market_account_members')
    .select('id, market_account_id, user_id, role, all_stores, status')
    .eq('market_account_id', accountId)
    .eq('user_id', authData.user.id)
    .eq('status', 'active')
    .maybeSingle()
  throwIfError(memberError)
  if (!member) return null

  const account = await getMarketAccount(accountId)
  if (!account) return null
  const operational = account.status === 'pilot' || account.status === 'active'

  return {
    ...account,
    member_id: member.id,
    role: member.role,
    all_stores: member.all_stores,
    member_status: member.status,
    stores: operational ? await listMarketStoresForMembership(accountId, member as MarketAccountMember) : [],
  } as CurrentUserMarketAccess
}

export async function createMarketStore(accountId: string, input: MarketStoreInput): Promise<MarketStore> {
  const { data: authData, error: authError } = await supabase.auth.getUser()
  throwIfError(authError)
  const { data, error } = await supabase
    .from('market_stores')
    .insert({ ...input, market_account_id: accountId, created_by: authData.user?.id ?? null })
    .select('id, market_account_id, name, external_code, description, status, stock_control_started_at, created_at')
    .eq('market_account_id', accountId)
    .single()
  throwIfError(error)
  return data as MarketStore
}

export async function updateMarketStore(accountId: string, storeId: string, input: MarketStoreInput): Promise<MarketStore> {
  const { data, error } = await supabase
    .from('market_stores')
    .update(input)
    .eq('id', storeId)
    .eq('market_account_id', accountId)
    .select('id, market_account_id, name, external_code, description, status, stock_control_started_at, created_at')
    .single()
  throwIfError(error)
  return data as MarketStore
}

export async function addMarketMember(
  accountId: string,
  userId: string,
  role: Exclude<MarketAccountMember['role'], 'owner'>,
  allStores: boolean,
  storeIds: string[]
): Promise<void> {
  const { error } = await supabase.rpc('admin_add_market_member', {
    p_market_account_id: accountId, p_user_id: userId, p_role: role,
    p_all_stores: allStores, p_store_ids: storeIds,
  })
  throwIfError(error)
}

export async function updateMarketMemberAccess(
  accountId: string, memberId: string,
  role: Exclude<MarketAccountMember['role'], 'owner'>,
  status: Exclude<MarketAccountMember['status'], 'invited'>,
  allStores: boolean, storeIds: string[]
): Promise<void> {
  const { error } = await supabase.rpc('admin_update_market_member_access', {
    p_market_account_id: accountId, p_member_id: memberId, p_role: role,
    p_status: status, p_all_stores: allStores, p_store_ids: storeIds,
  })
  throwIfError(error)
}

export async function updateMarketAccountSettings(
  accountId: string, planCode: 'pilot' | 'pro', status: MarketAccount['status']
): Promise<void> {
  const { error } = await supabase.rpc('admin_update_market_account_settings', {
    p_market_account_id: accountId, p_plan_code: planCode, p_status: status,
  })
  throwIfError(error)
}
