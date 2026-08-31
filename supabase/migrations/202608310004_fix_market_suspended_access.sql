-- Bloqueia acesso operacional a contas Market suspensas/canceladas,
-- preservando a visibilidade do vínculo e o acesso do admin da plataforma.
begin;

create or replace function public.market_account_is_operational(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.market_is_platform_admin()
        or exists (
            select 1 from public.market_accounts a
            where a.id = p_account_id
              and a.status in ('pilot','active')
        );
$$;

create or replace function public.market_has_active_membership(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.market_account_members m
        where m.market_account_id = p_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
    );
$$;

create or replace function public.market_is_member(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.market_is_platform_admin()
        or (
            exists (
                select 1 from public.market_accounts a
                where a.id = p_account_id and a.status in ('pilot','active')
            )
            and exists (
                select 1 from public.market_account_members m
                where m.market_account_id = p_account_id
                  and m.user_id = auth.uid()
                  and m.status = 'active'
            )
        );
$$;

create or replace function public.market_has_role(p_account_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.market_is_platform_admin()
        or (
            exists (
                select 1 from public.market_accounts a
                where a.id = p_account_id and a.status in ('pilot','active')
            )
            and exists (
                select 1 from public.market_account_members m
                where m.market_account_id = p_account_id
                  and m.user_id = auth.uid()
                  and m.status = 'active'
                  and m.role = any(p_roles)
            )
        );
$$;

create or replace function public.market_can_access_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select public.market_is_platform_admin()
        or exists (
            select 1
            from public.market_stores s
            join public.market_accounts a
              on a.id = s.market_account_id
             and a.status in ('pilot','active')
            join public.market_account_members m
              on m.market_account_id = s.market_account_id
             and m.user_id = auth.uid()
             and m.status = 'active'
            where s.id = p_store_id
              and (
                    m.all_stores = true
                    or m.role in ('owner','admin')
                    or exists (
                        select 1 from public.market_member_stores ms
                        where ms.market_account_member_id = m.id
                          and ms.market_store_id = s.id
                    )
              )
        );
$$;

-- Conta e vínculo continuam visíveis para comunicar suspensão/cancelamento.
drop policy if exists market_accounts_select on public.market_accounts;
create policy market_accounts_select
on public.market_accounts for select
to authenticated
using (
    public.market_is_platform_admin()
    or public.market_has_active_membership(id)
);

drop policy if exists market_members_select on public.market_account_members;
create policy market_members_select
on public.market_account_members for select
to authenticated
using (
    public.market_is_platform_admin()
    or (user_id = auth.uid() and status = 'active')
    or public.market_is_member(market_account_id)
);

revoke all on function public.market_account_is_operational(uuid) from public;
revoke all on function public.market_has_active_membership(uuid) from public;
grant execute on function public.market_account_is_operational(uuid) to authenticated;
grant execute on function public.market_has_active_membership(uuid) to authenticated;

commit;
