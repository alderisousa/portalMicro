begin;

-- Uma ordem ativa representa o ciclo operacional em andamento. Um batch novo
-- nao cria outra ordem enquanto esse ciclo existir.
create or replace function public.market_generate_replenishment_order_draft(p_market_account_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    v_order uuid;
    v_run uuid;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text, 0));

    select o.id into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.status in ('draft', 'approved', 'in_progress')
    order by o.created_at, o.id
    limit 1
    for update;
    if found then
        return v_order;
    end if;

    select r.id into v_run
    from public.market_replenishment_runs r
    where r.market_account_id = p_market_account_id
      and r.status = 'completed'
      and r.is_effective = true
    order by r.reference_date desc, r.started_at desc, r.id desc
    limit 1;
    if not found then
        raise exception 'REPLENISHMENT_ORDER_EFFECTIVE_RUN_NOT_FOUND';
    end if;

    select o.id into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.run_id = v_run
      and o.status <> 'cancelled'
    order by o.created_at, o.id
    limit 1
    for update;
    if found then
        return v_order;
    end if;

    return public.market_materialize_replenishment_order_draft_internal(p_market_account_id, v_run);
end;
$$;

commit;
