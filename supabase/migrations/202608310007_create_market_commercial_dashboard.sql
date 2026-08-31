-- GiroMicro Market - Sprint 3A: agregação segura do dashboard comercial.
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
    v_account_name text;
    v_period_start date;
    v_period_end date;
    v_import_count integer;
    v_has_overlap boolean;
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
    if not public.market_is_member(p_market_account_id) then
        raise exception 'DASHBOARD_PERMISSION_DENIED: conta indisponível ou vínculo inativo.';
    end if;

    select name into v_account_name
    from public.market_accounts
    where id = p_market_account_id and status in ('pilot','active');
    if not found then raise exception 'DASHBOARD_ACCOUNT_UNAVAILABLE: conta Market indisponível.'; end if;

    if p_market_store_id is not null and not exists (
        select 1 from public.market_stores s
        where s.id = p_market_store_id
          and s.market_account_id = p_market_account_id
          and s.status = 'active'
          and public.market_can_access_store(s.id)
    ) then raise exception 'DASHBOARD_STORE_NOT_ALLOWED: loja inexistente, inativa ou sem acesso.'; end if;

    select coalesce(jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'externalCode', s.external_code
    ) order by s.name), '[]'::jsonb)
    into v_stores
    from public.market_stores s
    where s.market_account_id = p_market_account_id
      and s.status = 'active'
      and public.market_can_access_store(s.id);

    select min(i.period_start), max(i.period_end), count(*),
           coalesce(bool_or(i.period_start < i.period_end), false),
           count(*) filter (
               where i.period_start = i.period_end
                 and i.period_end between current_date - 6 and current_date
           )
    into v_period_start, v_period_end, v_import_count, v_has_consolidated, v_recent_daily_count
    from public.market_sales_imports i
    where i.market_account_id = p_market_account_id
      and i.status in ('completed','completed_with_pending');

    select exists (
        select 1
        from public.market_sales_imports a
        join public.market_sales_imports b
          on b.market_account_id = a.market_account_id and b.id > a.id
        where a.market_account_id = p_market_account_id
          and a.status in ('completed','completed_with_pending')
          and b.status in ('completed','completed_with_pending')
          and a.period_start is not null and a.period_end is not null
          and b.period_start is not null and b.period_end is not null
          and daterange(a.period_start, a.period_end, '[]') && daterange(b.period_start, b.period_end, '[]')
    ) into v_has_overlap;

    v_quality := case
        when v_import_count = 0 then 'no_data'
        when v_has_overlap then 'overlap'
        when v_period_end < current_date - 7 then 'stale'
        when v_has_consolidated then 'consolidated'
        when v_period_end >= current_date - 2 and v_recent_daily_count >= 5 then 'updated'
        else 'stale'
    end;

    if v_import_count = 0 or v_has_overlap then
        return jsonb_build_object(
            'accountName', v_account_name, 'periodStart', v_period_start, 'periodEnd', v_period_end,
            'importCount', v_import_count, 'hasOverlap', v_has_overlap, 'quality', v_quality,
            'stores', v_stores, 'totals', null, 'storePerformance', '[]'::jsonb,
            'topByQuantity', '[]'::jsonb, 'topByRevenue', '[]'::jsonb,
            'topByProfit', '[]'::jsonb, 'negativeProfit', '[]'::jsonb
        );
    end if;

    with eligible_rows as (
        select r.*
        from public.market_sales_import_rows r
        join public.market_sales_imports i on i.id = r.import_id and i.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and public.market_can_access_store(r.market_store_id)
          and (p_market_store_id is null or r.market_store_id = p_market_store_id)
    )
    select jsonb_build_object(
        'revenue', coalesce(sum(total_amount), 0),
        'cost', coalesce(sum(total_cost), 0),
        'profit', coalesce(sum(profit), 0),
        'quantity', coalesce(sum(quantity), 0),
        'margin', case when coalesce(sum(total_amount), 0) = 0 then null
                       else sum(profit) / sum(total_amount) * 100 end
    ) into v_totals from eligible_rows;

    with eligible_rows as (
        select r.*
        from public.market_sales_import_rows r
        join public.market_sales_imports i on i.id = r.import_id and i.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and public.market_can_access_store(r.market_store_id)
          and (p_market_store_id is null or r.market_store_id = p_market_store_id)
    ), by_store as (
        select s.id, s.name, s.external_code,
               coalesce(sum(r.quantity), 0) quantity, coalesce(sum(r.total_amount), 0) revenue,
               coalesce(sum(r.total_cost), 0) cost, coalesce(sum(r.profit), 0) profit
        from eligible_rows r join public.market_stores s on s.id = r.market_store_id
        group by s.id, s.name, s.external_code
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'storeId', id, 'storeName', name, 'externalCode', external_code,
        'quantity', quantity, 'revenue', revenue, 'cost', cost, 'profit', profit,
        'margin', case when revenue = 0 then null else profit / revenue * 100 end
    ) order by revenue desc), '[]'::jsonb) into v_store_performance from by_store;

    with eligible_rows as (
        select r.*, p.name product_name,
               coalesce(r.product_id::text, nullif(r.barcode_normalized, ''), 'row:' || r.id::text) product_key
        from public.market_sales_import_rows r
        join public.market_sales_imports i on i.id = r.import_id and i.market_account_id = r.market_account_id
        left join public.market_products p on p.id = r.product_id and p.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and public.market_can_access_store(r.market_store_id)
          and (p_market_store_id is null or r.market_store_id = p_market_store_id)
    ), products as (
        select product_key, product_id,
               max(coalesce(product_name, nullif(external_description, ''), 'Produto sem descrição')) product_name,
               max(nullif(external_ean, '')) identifier,
               sum(quantity) quantity, sum(total_amount) revenue,
               sum(coalesce(profit, 0)) profit
        from eligible_rows
        group by product_key, product_id
    ), quantity_rank as (select * from products order by quantity desc nulls last limit 5),
       revenue_rank as (select * from products order by revenue desc nulls last limit 5),
       profit_rank as (select * from products order by profit desc nulls last limit 5),
       negative_rank as (select * from products where profit < 0 order by profit asc limit 5)
    select
      (select coalesce(jsonb_agg(to_jsonb(q) order by q.quantity desc), '[]'::jsonb) from quantity_rank q),
      (select coalesce(jsonb_agg(to_jsonb(r) order by r.revenue desc), '[]'::jsonb) from revenue_rank r),
      (select coalesce(jsonb_agg(to_jsonb(p) order by p.profit desc), '[]'::jsonb) from profit_rank p),
      (select coalesce(jsonb_agg(to_jsonb(n) order by n.profit asc), '[]'::jsonb) from negative_rank n)
    into v_top_quantity, v_top_revenue, v_top_profit, v_negative_profit;

    return jsonb_build_object(
        'accountName', v_account_name, 'periodStart', v_period_start, 'periodEnd', v_period_end,
        'importCount', v_import_count, 'hasOverlap', v_has_overlap, 'quality', v_quality,
        'stores', v_stores, 'totals', v_totals, 'storePerformance', v_store_performance,
        'topByQuantity', v_top_quantity, 'topByRevenue', v_top_revenue,
        'topByProfit', v_top_profit, 'negativeProfit', v_negative_profit
    );
end;
$$;

revoke all on function public.market_get_commercial_dashboard(uuid,uuid) from public;
grant execute on function public.market_get_commercial_dashboard(uuid,uuid) to authenticated;

commit;
