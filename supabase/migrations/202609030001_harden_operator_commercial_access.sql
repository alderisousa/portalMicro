-- GiroMicro Market - bloqueia o perfil operator nas fronteiras comerciais.
-- Viewer preserva o acesso somente leitura ao Dashboard Comercial.
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
    v_result jsonb;
    v_stores jsonb;
begin
    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager','viewer']
    ) then
        raise exception 'DASHBOARD_PERMISSION_DENIED: perfil sem acesso a dados comerciais.';
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

    return jsonb_set(v_result, '{stores}', v_stores, true);
end;
$$;

create or replace function public.market_begin_sales_import(
    p_market_account_id uuid,
    p_file_name text,
    p_file_hash text,
    p_period_start date,
    p_period_end date,
    p_source_system text,
    p_total_rows integer,
    p_store_codes text[],
    p_accept_overlap boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_code text;
begin
    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager']
    ) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuario sem permissao ou conta indisponivel.';
    end if;

    foreach v_code in array coalesce(p_store_codes, array[]::text[]) loop
        if exists (
            select 1 from public.market_stores s
            where s.market_account_id = p_market_account_id
              and btrim(s.external_code) = btrim(v_code)
              and s.store_type = 'warehouse'
        ) then
            raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: codigo % pertence a um galpao.', btrim(v_code);
        end if;
    end loop;

    return public.market_begin_sales_import_all_locations(
        p_market_account_id, p_file_name, p_file_hash, p_period_start,
        p_period_end, p_source_system, p_total_rows, p_store_codes,
        p_accept_overlap
    );
end;
$$;

create or replace function public.market_append_sales_import_chunk(
    p_market_account_id uuid,
    p_import_id uuid,
    p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if jsonb_typeof(p_rows) <> 'array'
       or jsonb_array_length(p_rows) = 0
       or jsonb_array_length(p_rows) > 500 then
        raise exception 'INVALID_CHUNK: cada lote deve conter entre 1 e 500 linhas.';
    end if;

    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager']
    ) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuario sem permissao ou conta indisponivel.';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_rows) item
        join public.market_stores s
          on s.market_account_id = p_market_account_id
         and btrim(s.external_code) = btrim(coalesce(item->>'externalStoreCode', ''))
        where s.store_type = 'warehouse'
    ) then
        raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: planilha referencia um galpao.';
    end if;

    return public.market_append_sales_import_chunk_all_locations(
        p_market_account_id, p_import_id, p_rows
    );
end;
$$;

create or replace function public.market_finalize_sales_import(
    p_market_account_id uuid,
    p_import_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager']
    ) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuario sem permissao ou conta indisponivel.';
    end if;

    if exists (
        select 1
        from public.market_sales_import_rows r
        join public.market_stores s
          on s.id = r.market_store_id
         and s.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and r.import_id = p_import_id
          and s.store_type = 'warehouse'
    ) then
        raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: importacao contem galpao.';
    end if;

    return public.market_finalize_sales_import_all_locations(
        p_market_account_id, p_import_id
    );
end;
$$;

drop policy if exists market_sales_imports_select on public.market_sales_imports;
create policy market_sales_imports_select
on public.market_sales_imports for select to authenticated
using (public.market_has_role(market_account_id, array['owner','admin','manager','viewer']));

drop policy if exists market_sales_imports_write on public.market_sales_imports;
create policy market_sales_imports_write
on public.market_sales_imports for all to authenticated
using (public.market_has_role(market_account_id, array['owner','admin','manager']))
with check (public.market_has_role(market_account_id, array['owner','admin','manager']));

drop policy if exists market_sales_import_rows_select on public.market_sales_import_rows;
create policy market_sales_import_rows_select
on public.market_sales_import_rows for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and (market_store_id is null or public.market_can_access_store(market_store_id))
);

drop policy if exists market_sales_import_rows_write on public.market_sales_import_rows;
create policy market_sales_import_rows_write
on public.market_sales_import_rows for all to authenticated
using (public.market_has_role(market_account_id, array['owner','admin','manager']))
with check (public.market_has_role(market_account_id, array['owner','admin','manager']));

drop policy if exists market_sales_select on public.market_sales;
create policy market_sales_select
on public.market_sales for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and public.market_can_access_store(market_store_id)
);

drop policy if exists market_sale_items_select on public.market_sale_items;
create policy market_sale_items_select
on public.market_sale_items for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and exists (
        select 1 from public.market_sales s
        where s.id = sale_id
          and s.market_account_id = market_sale_items.market_account_id
          and public.market_can_access_store(s.market_store_id)
    )
);

drop policy if exists market_sale_payments_select on public.market_sale_payments;
create policy market_sale_payments_select
on public.market_sale_payments for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and exists (
        select 1 from public.market_sales s
        where s.id = sale_id
          and s.market_account_id = market_sale_payments.market_account_id
          and public.market_can_access_store(s.market_store_id)
    )
);

drop policy if exists market_product_store_data_select on public.market_product_store_data;
create policy market_product_store_data_select
on public.market_product_store_data for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and public.market_can_access_store(market_store_id)
);

commit;
