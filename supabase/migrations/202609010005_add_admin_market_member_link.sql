-- GiroMicro Market: vinculo administrativo de usuario a conta existente.
-- Este fluxo nunca cria market_accounts e aceita somente manager/operator/viewer.
begin;

create or replace function public.admin_list_market_link_accounts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then raise exception 'ADMIN_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if not coalesce(public.is_admin(), false) then raise exception 'ADMIN_PERMISSION_DENIED: acesso negado.'; end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', a.id,
            'name', a.name,
            'status', a.status
        ) order by a.name, a.id)
        from public.market_accounts a
        where a.status in ('pilot','active')
    ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_list_market_link_stores(
    p_market_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then raise exception 'ADMIN_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if not coalesce(public.is_admin(), false) then raise exception 'ADMIN_PERMISSION_DENIED: acesso negado.'; end if;
    if p_market_account_id is null or not exists (
        select 1 from public.market_accounts a
        where a.id = p_market_account_id and a.status in ('pilot','active')
    ) then raise exception 'MARKET_LINK_ACCOUNT_UNAVAILABLE: conta Market inexistente ou indisponivel.'; end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'externalCode', s.external_code,
            'status', s.status
        ) order by s.name, s.id)
        from public.market_stores s
        where s.market_account_id = p_market_account_id
          and s.status = 'active'
    ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_link_existing_market_account(
    p_user_id uuid,
    p_market_account_id uuid,
    p_role text,
    p_all_stores boolean,
    p_store_ids uuid[] default array[]::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account public.market_accounts;
    v_existing public.market_account_members;
    v_member_id uuid;
    v_store_ids uuid[] := coalesce(p_store_ids, array[]::uuid[]);
begin
    if auth.uid() is null then raise exception 'ADMIN_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if not coalesce(public.is_admin(), false) then raise exception 'ADMIN_PERMISSION_DENIED: acesso negado.'; end if;
    if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
        raise exception 'MARKET_LINK_USER_NOT_FOUND: usuario nao encontrado.';
    end if;

    select * into v_account from public.market_accounts a
    where a.id = p_market_account_id and a.status in ('pilot','active')
    for update;
    if not found then
        raise exception 'MARKET_LINK_ACCOUNT_UNAVAILABLE: conta Market inexistente ou indisponivel.';
    end if;

    if p_role is null or p_role not in ('manager','operator','viewer') then
        raise exception 'MARKET_LINK_INVALID_ROLE: perfil permitido somente manager, operator ou viewer.';
    end if;
    if p_all_stores is null then
        raise exception 'MARKET_LINK_INVALID_SCOPE: informe o escopo de lojas.';
    end if;

    select * into v_existing from public.market_account_members m
    where m.market_account_id = v_account.id and m.user_id = p_user_id;
    if found then
        if v_existing.status = 'active' then
            raise exception 'MARKET_LINK_ALREADY_ACTIVE: este usuario ja possui acesso a esta conta Market.';
        end if;
        raise exception 'MARKET_LINK_ALREADY_EXISTS: o vinculo ja existe com status % e deve ser gerenciado ou reativado em Gerenciar Market.', v_existing.status;
    end if;

    if not p_all_stores then
        if cardinality(v_store_ids) = 0 then
            raise exception 'MARKET_LINK_STORE_REQUIRED: selecione pelo menos uma loja.';
        end if;
        if exists (
            select 1 from unnest(v_store_ids) selected(store_id)
            where not exists (
                select 1 from public.market_stores s
                where s.id = selected.store_id
                  and s.market_account_id = v_account.id
                  and s.status = 'active'
            )
        ) then
            raise exception 'MARKET_LINK_INVALID_STORE: uma ou mais lojas nao pertencem a conta ou estao inativas.';
        end if;
    end if;

    insert into public.market_account_members (
        market_account_id, user_id, role, all_stores, status, created_by
    ) values (
        v_account.id, p_user_id, p_role, p_all_stores, 'active', auth.uid()
    ) returning id into v_member_id;

    if not p_all_stores then
        insert into public.market_member_stores (market_account_member_id, market_store_id)
        select v_member_id, selected.store_id
        from (select distinct unnest(v_store_ids) store_id) selected;
    end if;

    return v_member_id;
exception
    when unique_violation then
        raise exception 'MARKET_LINK_ALREADY_EXISTS: este usuario ja possui um vinculo com esta conta Market.';
end;
$$;

revoke all on function public.admin_list_market_link_accounts() from public;
revoke all on function public.admin_list_market_link_stores(uuid) from public;
revoke all on function public.admin_link_existing_market_account(uuid,uuid,text,boolean,uuid[]) from public;
grant execute on function public.admin_list_market_link_accounts() to authenticated;
grant execute on function public.admin_list_market_link_stores(uuid) to authenticated;
grant execute on function public.admin_link_existing_market_account(uuid,uuid,text,boolean,uuid[]) to authenticated;

commit;
