-- GiroMicro Market - escolhe uma unica fonte comercial por conta.
-- Integracao Accesys ativa usa somente vendas sincronizadas; caso contrario,
-- o Dashboard preserva a implementacao historica baseada em importacoes.
begin;

create or replace function public.market_get_synced_commercial_dashboard(
    p_market_account_id uuid,
    p_market_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_active_integration_count integer;
    v_integration_id uuid;
    v_account_name text;
    v_store_ids uuid[] := array[]::uuid[];
    v_effective_store_ids uuid[] := array[]::uuid[];
    v_stores jsonb;
    v_period_start date;
    v_period_end date;
    v_order_count integer;
    v_cost_available boolean;
    v_quality text;
    v_totals jsonb;
    v_store_performance jsonb;
    v_top_quantity jsonb;
    v_top_revenue jsonb;
    v_top_profit jsonb := '[]'::jsonb;
    v_negative_profit jsonb := '[]'::jsonb;
begin
    select * into v_member
    from public.market_account_members m
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid()
      and m.status = 'active'
    order by m.created_at
    limit 1;

    if not found and not public.market_is_platform_admin() then
        raise exception 'DASHBOARD_PERMISSION_DENIED: conta indisponivel ou vinculo inativo.';
    end if;

    select name into v_account_name
    from public.market_accounts
    where id = p_market_account_id and status in ('pilot','active');
    if not found then
        raise exception 'DASHBOARD_ACCOUNT_UNAVAILABLE: conta Market indisponivel.';
    end if;

    select count(*)::integer, (array_agg(i.id order by i.id))[1]
    into v_active_integration_count, v_integration_id
    from public.market_integrations i
    where i.market_account_id = p_market_account_id
      and i.provider = 'accesys'
      and i.status = 'active';

    if v_active_integration_count <> 1 then
        raise exception 'DASHBOARD_INTEGRATION_AMBIGUOUS: esperada exatamente uma integracao Accesys ativa.';
    end if;

    select coalesce(array_agg(s.id order by s.id), array[]::uuid[])
    into v_store_ids
    from public.market_stores s
    where s.market_account_id = p_market_account_id
      and s.status = 'active'
      and s.store_type = 'store'
      and (
          (v_member.id is null and public.market_is_platform_admin())
          or v_member.all_stores = true
          or v_member.role in ('owner','admin')
          or exists (
              select 1 from public.market_member_stores ms
              where ms.market_account_member_id = v_member.id
                and ms.market_store_id = s.id
          )
      );

    if p_market_store_id is not null and not (p_market_store_id = any(v_store_ids)) then
        raise exception 'DASHBOARD_STORE_NOT_ALLOWED: loja inexistente, inativa ou sem acesso.';
    end if;

    v_effective_store_ids := case
        when p_market_store_id is null then v_store_ids
        else array[p_market_store_id]
    end;

    select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'externalCode', s.external_code
    ) order by s.name), '[]'::jsonb)
    into v_stores
    from public.market_stores s
    where s.id = any(v_store_ids);

    select min(s.sold_at)::date, max(s.sold_at)::date, count(*)::integer
    into v_period_start, v_period_end, v_order_count
    from public.market_sales s
    where s.market_account_id = p_market_account_id
      and s.source_type = 'api'
      and s.source_system = 'accesys'
      and s.integration_id = v_integration_id
      and s.market_store_id = any(v_effective_store_ids);

    v_quality := case
        when v_order_count = 0 then 'no_data'
        when v_period_end < current_date - 7 then 'stale'
        else 'updated'
    end;

    select v_order_count > 0
       and exists (
           select 1 from public.market_sale_items i
           join public.market_sales s
             on s.id = i.sale_id and s.market_account_id = i.market_account_id
           where s.market_account_id = p_market_account_id
             and s.source_type = 'api'
             and s.source_system = 'accesys'
             and s.integration_id = v_integration_id
             and s.market_store_id = any(v_effective_store_ids)
       )
       and not exists (
           select 1 from public.market_sale_items i
           join public.market_sales s
             on s.id = i.sale_id and s.market_account_id = i.market_account_id
           where s.market_account_id = p_market_account_id
             and s.source_type = 'api'
             and s.source_system = 'accesys'
             and s.integration_id = v_integration_id
             and s.market_store_id = any(v_effective_store_ids)
             and (i.total_cost_snapshot is null
                  or coalesce(i.net_amount, i.total_amount) is null)
       )
    into v_cost_available;

    if v_order_count = 0 then
        v_totals := null;
        v_store_performance := '[]'::jsonb;
        v_top_quantity := '[]'::jsonb;
        v_top_revenue := '[]'::jsonb;
    else
        with sales_totals as (
            select coalesce(sum(s.total_amount), 0) revenue,
                   coalesce(sum(s.items_quantity), 0) quantity
            from public.market_sales s
            where s.market_account_id = p_market_account_id
              and s.source_type = 'api'
              and s.source_system = 'accesys'
              and s.integration_id = v_integration_id
              and s.market_store_id = any(v_effective_store_ids)
        ), cost_totals as (
            select sum(i.total_cost_snapshot) cost
            from public.market_sale_items i
            join public.market_sales s
              on s.id = i.sale_id and s.market_account_id = i.market_account_id
            where s.market_account_id = p_market_account_id
              and s.source_type = 'api'
              and s.source_system = 'accesys'
              and s.integration_id = v_integration_id
              and s.market_store_id = any(v_effective_store_ids)
        )
        select jsonb_build_object(
            'revenue', st.revenue,
            'cost', case when v_cost_available then ct.cost else null end,
            'profit', case when v_cost_available then st.revenue - ct.cost else null end,
            'quantity', st.quantity,
            'margin', case when v_cost_available and st.revenue <> 0
                           then (st.revenue - ct.cost) / st.revenue * 100 else null end,
            'orderCount', v_order_count
        ) into v_totals
        from sales_totals st cross join cost_totals ct;

        with sales_by_store as (
            select s.market_store_id,
                   count(*)::integer order_count,
                   coalesce(sum(s.total_amount), 0) revenue,
                   coalesce(sum(s.items_quantity), 0) quantity
            from public.market_sales s
            where s.market_account_id = p_market_account_id
              and s.source_type = 'api'
              and s.source_system = 'accesys'
              and s.integration_id = v_integration_id
              and s.market_store_id = any(v_effective_store_ids)
            group by s.market_store_id
        ), costs_by_store as (
            select s.market_store_id,
                   count(*) filter (where i.total_cost_snapshot is null) = 0 cost_available,
                   sum(i.total_cost_snapshot) cost
            from public.market_sale_items i
            join public.market_sales s
              on s.id = i.sale_id and s.market_account_id = i.market_account_id
            where s.market_account_id = p_market_account_id
              and s.source_type = 'api'
              and s.source_system = 'accesys'
              and s.integration_id = v_integration_id
              and s.market_store_id = any(v_effective_store_ids)
            group by s.market_store_id
        )
        select coalesce(jsonb_agg(jsonb_build_object(
            'storeId', st.id, 'storeName', st.name, 'externalCode', st.external_code,
            'quantity', bs.quantity, 'revenue', bs.revenue,
            'cost', case when coalesce(cs.cost_available, false) then cs.cost else null end,
            'profit', case when coalesce(cs.cost_available, false) then bs.revenue - cs.cost else null end,
            'margin', case when coalesce(cs.cost_available, false) and bs.revenue <> 0
                           then (bs.revenue - cs.cost) / bs.revenue * 100 else null end,
            'orderCount', bs.order_count
        ) order by bs.revenue desc), '[]'::jsonb)
        into v_store_performance
        from sales_by_store bs
        join public.market_stores st on st.id = bs.market_store_id
        left join costs_by_store cs on cs.market_store_id = bs.market_store_id;

        with products as (
            select coalesce(i.product_id::text, nullif(i.external_ean, ''),
                            nullif(i.external_product_id, ''), 'item:' || i.id::text) product_key,
                   i.product_id,
                   max(coalesce(p.name, nullif(i.external_description, ''), 'Produto sem descricao')) product_name,
                   max(coalesce(nullif(i.external_ean, ''), nullif(i.external_product_id, ''))) identifier,
                   sum(i.quantity) quantity,
                   sum(coalesce(i.net_amount, i.total_amount)) revenue,
                   case when count(*) filter (where i.total_cost_snapshot is null) = 0
                        then sum(coalesce(i.net_amount, i.total_amount) - i.total_cost_snapshot)
                        else null end profit
            from public.market_sale_items i
            join public.market_sales s
              on s.id = i.sale_id and s.market_account_id = i.market_account_id
            left join public.market_products p
              on p.id = i.product_id and p.market_account_id = i.market_account_id
            where s.market_account_id = p_market_account_id
              and s.source_type = 'api'
              and s.source_system = 'accesys'
              and s.integration_id = v_integration_id
              and s.market_store_id = any(v_effective_store_ids)
            group by coalesce(i.product_id::text, nullif(i.external_ean, ''),
                              nullif(i.external_product_id, ''), 'item:' || i.id::text), i.product_id
        )
        select
            coalesce((select jsonb_agg(to_jsonb(q) order by q.quantity desc)
                      from (select * from products order by quantity desc nulls last limit 5) q), '[]'::jsonb),
            coalesce((select jsonb_agg(to_jsonb(r) order by r.revenue desc)
                      from (select * from products where revenue is not null order by revenue desc limit 5) r), '[]'::jsonb),
            coalesce((select jsonb_agg(to_jsonb(p) order by p.profit desc)
                      from (select * from products where profit is not null order by profit desc limit 5) p), '[]'::jsonb),
            coalesce((select jsonb_agg(to_jsonb(n) order by n.profit asc)
                      from (select * from products where profit < 0 order by profit asc limit 5) n), '[]'::jsonb)
        into v_top_quantity, v_top_revenue, v_top_profit, v_negative_profit;
    end if;

    return jsonb_build_object(
        'source', 'sync',
        'accountName', v_account_name,
        'periodStart', v_period_start,
        'periodEnd', v_period_end,
        'importCount', 0,
        'orderCount', v_order_count,
        'costAvailable', v_cost_available,
        'hasOverlap', false,
        'hasGaps', false,
        'gapCount', 0,
        'gaps', '[]'::jsonb,
        'quality', v_quality,
        'stores', v_stores,
        'totals', v_totals,
        'storePerformance', v_store_performance,
        'topByQuantity', v_top_quantity,
        'topByRevenue', v_top_revenue,
        'topByProfit', v_top_profit,
        'negativeProfit', v_negative_profit
    );
end;
$$;

revoke all on function public.market_get_synced_commercial_dashboard(uuid,uuid)
    from public, anon, authenticated;

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
declare
    v_result jsonb;
    v_stores jsonb;
begin
    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager','viewer']
    ) then
        raise exception 'DASHBOARD_PERMISSION_DENIED: perfil sem acesso a dados comerciais.';
    end if;

    if exists (
        select 1 from public.market_integrations i
        where i.market_account_id = p_market_account_id
          and i.provider = 'accesys'
          and i.status = 'active'
    ) then
        return public.market_get_synced_commercial_dashboard(
            p_market_account_id, p_market_store_id
        );
    end if;

    v_result := public.market_get_commercial_dashboard_all_locations(
        p_market_account_id, p_market_store_id
    );

    if p_market_store_id is not null and exists (
        select 1 from public.market_stores s
        where s.id = p_market_store_id
          and s.market_account_id = p_market_account_id
          and s.store_type = 'warehouse'
    ) then
        raise exception 'DASHBOARD_STORE_TYPE_NOT_ALLOWED: galpao nao participa do Dashboard Comercial.';
    end if;

    select coalesce(jsonb_agg(entry.value order by entry.value->>'name'), '[]'::jsonb)
    into v_stores
    from jsonb_array_elements(coalesce(v_result->'stores', '[]'::jsonb)) entry
    join public.market_stores s
      on s.id = (entry.value->>'id')::uuid
     and s.market_account_id = p_market_account_id
     and s.store_type = 'store';

    v_result := jsonb_set(v_result, '{stores}', v_stores, true);
    return v_result || jsonb_build_object(
        'source', 'import',
        'orderCount', null,
        'costAvailable', true
    );
end;
$$;

revoke all on function public.market_get_commercial_dashboard(uuid,uuid) from public, anon;
grant execute on function public.market_get_commercial_dashboard(uuid,uuid) to authenticated;

commit;
