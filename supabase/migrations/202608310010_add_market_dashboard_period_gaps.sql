-- GiroMicro Market - Sprint 3A: identifica lacunas reais na cobertura comercial.
-- Mantém overlaps bloqueantes e gaps apenas informativos, sem inventar série diária.
begin;

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
    v_member public.market_account_members;
    v_account_name text;
    v_store_ids uuid[] := array[]::uuid[];
    v_effective_store_ids uuid[] := array[]::uuid[];
    v_period_start date;
    v_period_end date;
    v_import_count integer;
    v_has_overlap boolean;
    v_has_gaps boolean;
    v_gap_count integer;
    v_gaps jsonb;
    v_has_consolidated boolean;
    v_recent_daily_count integer;
    v_quality text;
    v_stores jsonb;
    v_totals jsonb;
    v_store_performance jsonb;
    v_top_quantity jsonb;
    v_top_revenue jsonb;
    v_top_profit jsonb;
    v_negative_profit jsonb;
begin
    select * into v_member
    from public.market_account_members m
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid()
      and m.status = 'active'
    order by m.created_at
    limit 1;

    if not found and not public.market_is_platform_admin() then
        raise exception 'DASHBOARD_PERMISSION_DENIED: conta indisponível ou vínculo inativo.';
    end if;

    select name into v_account_name
    from public.market_accounts
    where id = p_market_account_id and status in ('pilot','active');
    if not found then
        raise exception 'DASHBOARD_ACCOUNT_UNAVAILABLE: conta Market indisponível.';
    end if;

    select coalesce(array_agg(s.id order by s.id), array[]::uuid[])
    into v_store_ids
    from public.market_stores s
    where s.market_account_id = p_market_account_id
      and s.status = 'active'
      and (
          (v_member.id is null and public.market_is_platform_admin())
          or v_member.all_stores = true
          or v_member.role in ('owner','admin')
          or exists (
              select 1
              from public.market_member_stores ms
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

    -- A cobertura considera apenas importações que efetivamente possuam linhas
    -- em alguma loja do escopo atual. O máximo acumulado une intervalos
    -- sobrepostos antes de identificar as lacunas entre as ilhas resultantes.
    with eligible_imports as (
        select i.*
        from public.market_sales_imports i
        where i.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and exists (
              select 1
              from public.market_sales_import_rows r
              where r.import_id = i.id
                and r.market_account_id = i.market_account_id
                and r.market_store_id = any(v_effective_store_ids)
          )
    ), valid_periods as (
        select id, period_start, period_end
        from eligible_imports
        where period_start is not null and period_end is not null
    ), ordered_periods as (
        select *, max(period_end) over (
            order by period_start, period_end, id
            rows between unbounded preceding and 1 preceding
        ) as previous_max_end
        from valid_periods
    ), marked_periods as (
        select *, case
            when previous_max_end is null or period_start > previous_max_end + 1 then 1
            else 0
        end as starts_new_island
        from ordered_periods
    ), grouped_periods as (
        select *, sum(starts_new_island) over (
            order by period_start, period_end, id
        ) as island_number
        from marked_periods
    ), coverage_islands as (
        select island_number, min(period_start) as island_start, max(period_end) as island_end
        from grouped_periods
        group by island_number
    ), islands_with_next as (
        select *, lead(island_start) over (order by island_start) as next_island_start
        from coverage_islands
    ), detected_gaps as (
        select island_end + 1 as gap_start, next_island_start - 1 as gap_end
        from islands_with_next
        where next_island_start > island_end + 1
    )
    select
        (select min(period_start) from valid_periods),
        (select max(period_end) from valid_periods),
        (select count(*) from eligible_imports),
        coalesce((select bool_or(period_start < period_end) from valid_periods), false),
        (select count(*) from valid_periods
         where period_start = period_end
           and period_end between current_date - 6 and current_date),
        coalesce((select bool_or(period_start <= previous_max_end) from ordered_periods), false),
        exists(select 1 from detected_gaps),
        (select count(*) from detected_gaps),
        coalesce((select jsonb_agg(jsonb_build_object(
            'startDate', gap_start,
            'endDate', gap_end
        ) order by gap_start) from detected_gaps), '[]'::jsonb)
    into
        v_period_start, v_period_end, v_import_count, v_has_consolidated,
        v_recent_daily_count, v_has_overlap, v_has_gaps, v_gap_count, v_gaps;

    v_quality := case
        when v_import_count = 0 then 'no_data'
        when v_has_overlap then 'overlap'
        when v_has_gaps then 'incomplete'
        when v_period_end < current_date - 7 then 'stale'
        when v_has_consolidated then 'consolidated'
        when v_period_end >= current_date - 2 and v_recent_daily_count >= 5 then 'updated'
        else 'stale'
    end;

    if v_import_count = 0 or v_has_overlap then
        return jsonb_build_object(
            'accountName', v_account_name,
            'periodStart', v_period_start,
            'periodEnd', v_period_end,
            'importCount', v_import_count,
            'hasOverlap', v_has_overlap,
            'hasGaps', v_has_gaps,
            'gapCount', v_gap_count,
            'gaps', v_gaps,
            'quality', v_quality,
            'stores', v_stores,
            'totals', null,
            'storePerformance', '[]'::jsonb,
            'topByQuantity', '[]'::jsonb,
            'topByRevenue', '[]'::jsonb,
            'topByProfit', '[]'::jsonb,
            'negativeProfit', '[]'::jsonb
        );
    end if;

    with eligible_rows as (
        select r.*
        from public.market_sales_import_rows r
        join public.market_sales_imports i
          on i.id = r.import_id and i.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and r.market_store_id = any(v_effective_store_ids)
    )
    select jsonb_build_object(
        'revenue', coalesce(sum(total_amount), 0),
        'cost', coalesce(sum(total_cost), 0),
        'profit', coalesce(sum(profit), 0),
        'quantity', coalesce(sum(quantity), 0),
        'margin', case when coalesce(sum(total_amount), 0) = 0 then null
                       else sum(profit) / sum(total_amount) * 100 end
    )
    into v_totals
    from eligible_rows;

    with eligible_rows as (
        select r.*
        from public.market_sales_import_rows r
        join public.market_sales_imports i
          on i.id = r.import_id and i.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and r.market_store_id = any(v_effective_store_ids)
    ), by_store as (
        select s.id, s.name, s.external_code,
               coalesce(sum(r.quantity), 0) quantity,
               coalesce(sum(r.total_amount), 0) revenue,
               coalesce(sum(r.total_cost), 0) cost,
               coalesce(sum(r.profit), 0) profit
        from eligible_rows r
        join public.market_stores s on s.id = r.market_store_id
        group by s.id, s.name, s.external_code
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'storeId', id, 'storeName', name, 'externalCode', external_code,
        'quantity', quantity, 'revenue', revenue, 'cost', cost, 'profit', profit,
        'margin', case when revenue = 0 then null else profit / revenue * 100 end
    ) order by revenue desc), '[]'::jsonb)
    into v_store_performance
    from by_store;

    with eligible_rows as (
        select r.*, p.name product_name,
               coalesce(r.product_id::text, nullif(r.barcode_normalized, ''), 'row:' || r.id::text) product_key
        from public.market_sales_import_rows r
        join public.market_sales_imports i
          on i.id = r.import_id and i.market_account_id = r.market_account_id
        left join public.market_products p
          on p.id = r.product_id and p.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and r.market_store_id = any(v_effective_store_ids)
    ), products as (
        select product_key, product_id,
               max(coalesce(product_name, nullif(external_description, ''), 'Produto sem descrição')) product_name,
               max(nullif(external_ean, '')) identifier,
               sum(quantity) quantity,
               sum(total_amount) revenue,
               sum(coalesce(profit, 0)) profit
        from eligible_rows
        group by product_key, product_id
    ), quantity_rank as (
        select * from products order by quantity desc nulls last limit 5
    ), revenue_rank as (
        select * from products order by revenue desc nulls last limit 5
    ), profit_rank as (
        select * from products order by profit desc nulls last limit 5
    ), negative_rank as (
        select * from products where profit < 0 order by profit asc limit 5
    )
    select
        (select coalesce(jsonb_agg(to_jsonb(q) order by q.quantity desc), '[]'::jsonb) from quantity_rank q),
        (select coalesce(jsonb_agg(to_jsonb(r) order by r.revenue desc), '[]'::jsonb) from revenue_rank r),
        (select coalesce(jsonb_agg(to_jsonb(p) order by p.profit desc), '[]'::jsonb) from profit_rank p),
        (select coalesce(jsonb_agg(to_jsonb(n) order by n.profit asc), '[]'::jsonb) from negative_rank n)
    into v_top_quantity, v_top_revenue, v_top_profit, v_negative_profit;

    return jsonb_build_object(
        'accountName', v_account_name,
        'periodStart', v_period_start,
        'periodEnd', v_period_end,
        'importCount', v_import_count,
        'hasOverlap', v_has_overlap,
        'hasGaps', v_has_gaps,
        'gapCount', v_gap_count,
        'gaps', v_gaps,
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

revoke all on function public.market_get_commercial_dashboard(uuid,uuid) from public;
grant execute on function public.market_get_commercial_dashboard(uuid,uuid) to authenticated;

commit;
