-- GiroMicro Market - fechamento da Sprint 1 administrativa e de segurança.
begin;

create or replace function public.admin_add_market_member(
    p_market_account_id uuid,
    p_user_id uuid,
    p_role text,
    p_all_stores boolean,
    p_store_ids uuid[] default array[]::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_member_id uuid;
    v_store_ids uuid[] := coalesce(p_store_ids, array[]::uuid[]);
begin
    if not coalesce(public.is_admin(), false) then raise exception 'Acesso negado.'; end if;
    if not exists (select 1 from public.market_accounts where id = p_market_account_id) then raise exception 'Conta Market não encontrada.'; end if;
    if not exists (select 1 from auth.users where id = p_user_id) then raise exception 'Usuário não encontrado.'; end if;
    if p_role not in ('admin','manager','operator','viewer') then raise exception 'Perfil inválido para este fluxo.'; end if;
    if exists (select 1 from public.market_account_members where market_account_id = p_market_account_id and user_id = p_user_id) then raise exception 'Usuário já vinculado a esta conta.'; end if;
    if not p_all_stores and cardinality(v_store_ids) = 0 then raise exception 'Selecione pelo menos uma loja.'; end if;
    if exists (select 1 from unnest(v_store_ids) sid where not exists (select 1 from public.market_stores s where s.id = sid and s.market_account_id = p_market_account_id)) then raise exception 'Uma ou mais lojas não pertencem a esta conta.'; end if;

    insert into public.market_account_members (market_account_id, user_id, role, all_stores, status, created_by)
    values (p_market_account_id, p_user_id, p_role, p_all_stores, 'active', auth.uid())
    returning id into v_member_id;

    if not p_all_stores then
        insert into public.market_member_stores (market_account_member_id, market_store_id)
        select v_member_id, sid from (select distinct unnest(v_store_ids) sid) selected;
    end if;
    return v_member_id;
end;
$$;

create or replace function public.admin_update_market_member_access(
    p_market_account_id uuid,
    p_member_id uuid,
    p_role text,
    p_status text,
    p_all_stores boolean,
    p_store_ids uuid[] default array[]::uuid[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_store_ids uuid[] := coalesce(p_store_ids, array[]::uuid[]);
begin
    if not coalesce(public.is_admin(), false) then raise exception 'Acesso negado.'; end if;
    if not exists (select 1 from public.market_accounts where id = p_market_account_id) then raise exception 'Conta Market não encontrada.'; end if;
    if exists (select 1 from public.market_account_members where id = p_member_id and market_account_id = p_market_account_id and role = 'owner') then raise exception 'O proprietário não pode ser alterado por este fluxo.'; end if;
    if not exists (select 1 from public.market_account_members where id = p_member_id and market_account_id = p_market_account_id) then raise exception 'Membro não encontrado nesta conta.'; end if;
    if p_role not in ('admin','manager','operator','viewer') then raise exception 'Perfil inválido para este fluxo.'; end if;
    if p_status not in ('active','disabled') then raise exception 'Status inválido.'; end if;
    if not p_all_stores and cardinality(v_store_ids) = 0 then raise exception 'Selecione pelo menos uma loja.'; end if;
    if exists (select 1 from unnest(v_store_ids) sid where not exists (select 1 from public.market_stores s where s.id = sid and s.market_account_id = p_market_account_id)) then raise exception 'Uma ou mais lojas não pertencem a esta conta.'; end if;

    update public.market_account_members set role = p_role, status = p_status, all_stores = p_all_stores, updated_at = now()
    where id = p_member_id and market_account_id = p_market_account_id;
    delete from public.market_member_stores where market_account_member_id = p_member_id;
    if not p_all_stores then
        insert into public.market_member_stores (market_account_member_id, market_store_id)
        select p_member_id, sid from (select distinct unnest(v_store_ids) sid) selected;
    end if;
end;
$$;

create or replace function public.admin_update_market_account_settings(
    p_market_account_id uuid,
    p_plan_code text,
    p_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not coalesce(public.is_admin(), false) then raise exception 'Acesso negado.'; end if;
    if p_plan_code not in ('pilot','pro') then raise exception 'Plano Market inválido.'; end if;
    if p_status not in ('pilot','active','suspended','cancelled') then raise exception 'Status da conta inválido.'; end if;
    update public.market_accounts set plan_code = p_plan_code, status = p_status, updated_at = now() where id = p_market_account_id;
    if not found then raise exception 'Conta Market não encontrada.'; end if;
end;
$$;

-- Reforça no backend a regra de uma conta própria por owner durante o piloto.
create or replace function public.admin_create_market_account(
    p_name text,
    p_owner_user_id uuid,
    p_plan_code text default 'pilot',
    p_partner_referrer_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_account_id uuid;
begin
    if not coalesce(public.is_admin(), false) then raise exception 'Acesso negado.'; end if;
    if nullif(btrim(p_name), '') is null then raise exception 'Informe o nome da conta Market.'; end if;
    if p_plan_code not in ('pilot','pro') then raise exception 'Plano Market inválido.'; end if;
    if not exists (select 1 from auth.users where id = p_owner_user_id) then raise exception 'Usuário proprietário não encontrado.'; end if;
    if exists (
        select 1 from public.market_account_members m
        join public.market_accounts a on a.id = m.market_account_id
        where m.user_id = p_owner_user_id and m.role = 'owner'
    ) then
        raise exception 'Este usuário já possui uma conta Market como proprietário. Gerencie a conta existente.';
    end if;

    insert into public.market_accounts (name, status, plan_code, partner_referrer_user_id, created_by)
    values (btrim(p_name), 'pilot', p_plan_code, p_partner_referrer_user_id, auth.uid())
    returning id into v_account_id;
    insert into public.market_account_members (market_account_id, user_id, role, all_stores, status, created_by)
    values (v_account_id, p_owner_user_id, 'owner', true, 'active', auth.uid());
    return v_account_id;
end;
$$;

revoke all on function public.admin_add_market_member(uuid,uuid,text,boolean,uuid[]) from public;
revoke all on function public.admin_update_market_member_access(uuid,uuid,text,text,boolean,uuid[]) from public;
revoke all on function public.admin_update_market_account_settings(uuid,text,text) from public;
grant execute on function public.admin_add_market_member(uuid,uuid,text,boolean,uuid[]) to authenticated;
grant execute on function public.admin_update_market_member_access(uuid,uuid,text,text,boolean,uuid[]) to authenticated;
grant execute on function public.admin_update_market_account_settings(uuid,text,text) to authenticated;
revoke all on function public.admin_create_market_account(text,uuid,text,uuid) from public;
grant execute on function public.admin_create_market_account(text,uuid,text,uuid) to authenticated;

commit;
