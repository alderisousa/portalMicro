-- Corrige o escopo efetivo de loja no Dashboard sem alterar o comportamento
-- administrativo global do Market.
begin;

create or replace function public.market_can_access_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.market_stores s
        join public.market_accounts a
          on a.id = s.market_account_id
         and a.status in ('pilot','active')
        where s.id = p_store_id
          and (
              exists (
                  select 1
                  from public.market_account_members m
                  where m.market_account_id = s.market_account_id
                    and m.user_id = auth.uid()
                    and m.status = 'active'
                    and (
                        m.all_stores = true
                        or m.role in ('owner','admin')
                        or exists (
                            select 1
                            from public.market_member_stores ms
                            where ms.market_account_member_id = m.id
                              and ms.market_store_id = s.id
                        )
                    )
              )
              or (
                  public.market_is_platform_admin()
                  and coalesce(current_setting('app.market_enforce_membership_scope', true), '') <> 'on'
              )
          )
    );
$$;

-- A implementação da migration 007 já aplica market_can_access_store em todas
-- as CTEs e na lista de lojas. Ela fica interna, e a assinatura pública é
-- recriada para preservar integralmente o contrato usado pelo frontend.
alter function public.market_get_commercial_dashboard(uuid,uuid)
    rename to market_get_commercial_dashboard_scoped_impl;

create or replace function public.market_get_commercial_dashboard(
    p_market_account_id uuid,
    p_market_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    perform set_config('app.market_enforce_membership_scope', 'on', true);
    return public.market_get_commercial_dashboard_scoped_impl(
        p_market_account_id,
        p_market_store_id
    );
end;
$$;

revoke all on function public.market_can_access_store(uuid) from public;
revoke all on function public.market_get_commercial_dashboard_scoped_impl(uuid,uuid) from public;
revoke all on function public.market_get_commercial_dashboard_scoped_impl(uuid,uuid) from authenticated;
revoke all on function public.market_get_commercial_dashboard(uuid,uuid) from public;
grant execute on function public.market_can_access_store(uuid) to authenticated;
grant execute on function public.market_get_commercial_dashboard(uuid,uuid) to authenticated;

commit;
