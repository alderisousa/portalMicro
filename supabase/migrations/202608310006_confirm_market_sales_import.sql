-- GiroMicro Market - Sprint 2B.2: confirmação segura de importações de vendas.
-- Usa staging nas próprias tabelas em status processing; nenhuma movimentação
-- de estoque é criada nesta migration.
begin;

alter table public.market_sales_import_rows
    add column if not exists barcode_validation_status text not null default 'missing';

alter table public.market_sales_import_rows
    drop constraint if exists market_sales_import_rows_barcode_validation_check;

alter table public.market_sales_import_rows
    add constraint market_sales_import_rows_barcode_validation_check
    check (barcode_validation_status in ('valid_gtin','not_validated_gtin','missing'));

create or replace function public.market_is_valid_gtin(p_code text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
    v_code text := btrim(coalesce(p_code, ''));
    v_sum integer := 0;
    v_index integer;
    v_position integer := 0;
    v_check integer;
begin
    if v_code !~ '^[0-9]+$' or length(v_code) not in (8,12,13,14) then return false; end if;
    v_check := substring(v_code, length(v_code), 1)::integer;
    for v_index in reverse 1..(length(v_code) - 1) loop
        v_sum := v_sum + substring(v_code, v_index, 1)::integer
            * case when v_position % 2 = 0 then 3 else 1 end;
        v_position := v_position + 1;
    end loop;
    return ((10 - (v_sum % 10)) % 10) = v_check;
end;
$$;

update public.market_sales_import_rows
set barcode_validation_status = case
    when nullif(btrim(barcode_normalized), '') is null then 'missing'
    when public.market_is_valid_gtin(barcode_normalized) then 'valid_gtin'
    else 'not_validated_gtin'
end
where barcode_validation_status = 'missing'
  and nullif(btrim(barcode_normalized), '') is not null;

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
    v_existing public.market_sales_imports;
    v_import_id uuid;
    v_code text;
    v_store public.market_stores;
    v_overlap boolean;
    v_persisted_rows integer;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_market_account_id::text, 0));
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager','operator']) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuário sem permissão ou conta indisponível.';
    end if;
    if nullif(btrim(p_file_name), '') is null then raise exception 'INVALID_FILE_NAME: informe o nome do arquivo.'; end if;
    if p_file_hash !~ '^[0-9a-fA-F]{64}$' then raise exception 'INVALID_FILE_HASH: SHA-256 inválido.'; end if;
    if p_total_rows is null or p_total_rows <= 0 or p_total_rows > 20000 then raise exception 'INVALID_ROW_COUNT: quantidade de linhas fora do limite.'; end if;
    if p_period_start is not null and p_period_end is not null and p_period_start > p_period_end then raise exception 'INVALID_PERIOD: período inválido.'; end if;

    select * into v_existing
    from public.market_sales_imports
    where market_account_id = p_market_account_id and lower(file_hash) = lower(p_file_hash)
    limit 1;

    if found then
        select count(*) into v_persisted_rows from public.market_sales_import_rows where import_id = v_existing.id;
        if v_existing.status = 'processing' and (v_existing.imported_by = auth.uid() or public.market_is_platform_admin()) then
            return jsonb_build_object('duplicate', false, 'resume', true, 'importId', v_existing.id, 'persistedRows', v_persisted_rows, 'overlapWarning', false);
        end if;
        return jsonb_build_object('duplicate', true, 'resume', false, 'importId', v_existing.id, 'status', v_existing.status, 'createdAt', v_existing.created_at, 'periodStart', v_existing.period_start, 'periodEnd', v_existing.period_end);
    end if;

    foreach v_code in array coalesce(p_store_codes, array[]::text[]) loop
        v_code := btrim(v_code);
        select * into v_store from public.market_stores
        where market_account_id = p_market_account_id and btrim(external_code) = v_code limit 1;
        if not found then raise exception 'STORE_NOT_FOUND: código %.', v_code; end if;
        if v_store.status <> 'active' then raise exception 'STORE_INACTIVE: código %.', v_code; end if;
        if not public.market_can_access_store(v_store.id) then raise exception 'STORE_NOT_ALLOWED: código %.', v_code; end if;
    end loop;

    select exists (
        select 1 from public.market_sales_imports i
        where i.market_account_id = p_market_account_id
          and i.status in ('completed','completed_with_pending')
          and p_period_start is not null and p_period_end is not null
          and i.period_start is not null and i.period_end is not null
          and daterange(i.period_start, i.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
    ) into v_overlap;

    if v_overlap and not p_accept_overlap then
        return jsonb_build_object('duplicate', false, 'resume', false, 'overlapWarning', true);
    end if;

    insert into public.market_sales_imports (
        market_account_id, file_name, file_hash, source_system, period_start,
        period_end, status, total_rows, processed_rows, pending_rows,
        error_rows, imported_by
    ) values (
        p_market_account_id, btrim(p_file_name), lower(p_file_hash),
        coalesce(nullif(btrim(p_source_system), ''), 'franchise_export'),
        p_period_start, p_period_end, 'processing', p_total_rows, 0, 0, 0, auth.uid()
    ) returning id into v_import_id;

    return jsonb_build_object('duplicate', false, 'resume', false, 'importId', v_import_id, 'persistedRows', 0, 'overlapWarning', v_overlap);
exception
    when unique_violation then
        select * into v_existing from public.market_sales_imports
        where market_account_id = p_market_account_id and lower(file_hash) = lower(p_file_hash) limit 1;
        return jsonb_build_object('duplicate', true, 'resume', false, 'importId', v_existing.id, 'status', v_existing.status, 'createdAt', v_existing.created_at, 'periodStart', v_existing.period_start, 'periodEnd', v_existing.period_end);
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
declare
    v_import public.market_sales_imports;
    v_item jsonb;
    v_row_number integer;
    v_store public.market_stores;
    v_raw_data jsonb;
    v_external_code text;
    v_external_ean text;
    v_barcode text;
    v_inserted integer := 0;
    v_persisted integer;
begin
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 500 then
        raise exception 'INVALID_CHUNK: cada lote deve conter entre 1 e 500 linhas.';
    end if;
    select * into v_import from public.market_sales_imports where id = p_import_id and market_account_id = p_market_account_id for update;
    if not found then raise exception 'IMPORT_NOT_FOUND: importação inexistente.'; end if;
    if v_import.status <> 'processing' then raise exception 'IMPORT_NOT_PROCESSING: importação não aceita novos lotes.'; end if;
    if v_import.imported_by <> auth.uid() and not public.market_is_platform_admin() then raise exception 'IMPORT_PERMISSION_DENIED: somente o autor pode continuar esta importação.'; end if;
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager','operator']) then raise exception 'IMPORT_PERMISSION_DENIED: usuário sem permissão ou conta indisponível.'; end if;

    for v_item in select value from jsonb_array_elements(p_rows) loop
        v_row_number := (v_item->>'sourceRowNumber')::integer;
        v_raw_data := v_item->'rawData';
        v_external_code := btrim(coalesce(v_item->>'externalStoreCode', ''));
        v_external_ean := nullif(btrim(v_item->>'externalEanRaw'), '');
        v_barcode := nullif(btrim(v_item->>'barcodeNormalized'), '');
        if v_row_number <= 0 then raise exception 'INVALID_ROW_NUMBER: linha inválida.'; end if;
        if lower(v_external_code) ~ '^totais?\s*:?$'
           or (v_external_code = '' and lower(btrim(coalesce(v_item->>'externalStoreName', ''))) ~ '^totais?\s*:?$')
        then raise exception 'TOTALIZATION_ROW_REJECTED: linha %.', v_row_number; end if;
        if v_raw_data is null or jsonb_typeof(v_raw_data) <> 'object' or v_raw_data = '{}'::jsonb then raise exception 'RAW_DATA_REQUIRED: linha %.', v_row_number; end if;
        if v_item->'quantity' is null or v_item->'totalAmount' is null then raise exception 'INVALID_REQUIRED_NUMBER: linha %.', v_row_number; end if;

        select * into v_store from public.market_stores
        where market_account_id = p_market_account_id and btrim(external_code) = v_external_code limit 1;
        if not found then raise exception 'STORE_NOT_FOUND: código %.', v_external_code; end if;
        if v_store.status <> 'active' then raise exception 'STORE_INACTIVE: código %.', v_external_code; end if;
        if not public.market_can_access_store(v_store.id) then raise exception 'STORE_NOT_ALLOWED: código %.', v_external_code; end if;

        if exists (
            select 1 from public.market_sales_import_rows r
            where r.import_id = p_import_id and r.row_number = v_row_number
              and r.raw_data is distinct from v_raw_data
        ) then raise exception 'CHUNK_CONFLICT: linha % já recebida com conteúdo diferente.', v_row_number; end if;

        insert into public.market_sales_import_rows (
            market_account_id, import_id, row_number, market_store_id,
            external_store_code, external_store_name, external_product_code,
            external_ean, external_description, barcode_normalized,
            barcode_validation_status, quantity, unit_price, total_amount,
            total_cost, profit, markup, markdown, status,
            store_resolution_status, product_resolution_status,
            pending_reason, raw_data
        ) values (
            p_market_account_id, p_import_id, v_row_number, v_store.id,
            v_external_code, nullif(btrim(v_item->>'externalStoreName'), ''),
            nullif(btrim(v_item->>'externalProductCode'), ''), v_external_ean,
            nullif(btrim(v_item->>'description'), ''), v_barcode,
            case when v_barcode is null then 'missing' when public.market_is_valid_gtin(v_barcode) then 'valid_gtin' else 'not_validated_gtin' end,
            (v_item->>'quantity')::numeric, nullif(v_item->>'unitPrice', '')::numeric,
            (v_item->>'totalAmount')::numeric, nullif(v_item->>'totalCost', '')::numeric,
            nullif(v_item->>'profit', '')::numeric, nullif(v_item->>'markup', '')::numeric,
            nullif(v_item->>'markdown', '')::numeric, 'pending', 'resolved', 'pending',
            case when v_barcode is null then 'MISSING_PRODUCT_CODE' else null end,
            v_raw_data
        ) on conflict (import_id, row_number) do nothing;
        if found then v_inserted := v_inserted + 1; end if;
    end loop;

    select count(*) into v_persisted from public.market_sales_import_rows where import_id = p_import_id;
    if v_persisted > v_import.total_rows then raise exception 'ROW_COUNT_EXCEEDED: mais linhas que o declarado.'; end if;
    return jsonb_build_object('insertedRows', v_inserted, 'persistedRows', v_persisted, 'totalRows', v_import.total_rows);
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
declare
    v_import public.market_sales_imports;
    v_count integer;
    v_identifier record;
    v_mapping_count integer;
    v_mapping_product uuid;
    v_catalog_product uuid;
    v_product_id uuid;
    v_products_created integer := 0;
    v_processed integer;
    v_pending integer;
    v_errors integer;
    v_products_associated integer;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_market_account_id::text, 0));
    select * into v_import from public.market_sales_imports where id = p_import_id and market_account_id = p_market_account_id for update;
    if not found then raise exception 'IMPORT_NOT_FOUND: importação inexistente.'; end if;
    if v_import.status <> 'processing' then raise exception 'IMPORT_NOT_PROCESSING: importação já finalizada ou cancelada.'; end if;
    if v_import.imported_by <> auth.uid() and not public.market_is_platform_admin() then raise exception 'IMPORT_PERMISSION_DENIED: somente o autor pode finalizar esta importação.'; end if;
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager','operator']) then raise exception 'IMPORT_PERMISSION_DENIED: usuário sem permissão ou conta indisponível.'; end if;

    select count(*) into v_count from public.market_sales_import_rows where import_id = p_import_id;
    if v_count <> v_import.total_rows then raise exception 'INCOMPLETE_IMPORT: recebidas % de % linhas.', v_count, v_import.total_rows; end if;
    if exists (
        select 1 from public.market_sales_import_rows r
        left join public.market_stores s on s.id = r.market_store_id and s.market_account_id = p_market_account_id
        where r.import_id = p_import_id
          and (s.id is null or s.status <> 'active' or not public.market_can_access_store(s.id))
    ) then raise exception 'STORE_ACCESS_CHANGED: uma loja deixou de estar disponível durante a confirmação.'; end if;

    update public.market_sales_import_rows
    set status = 'product_pending', product_resolution_status = 'pending',
        pending_reason = 'MISSING_PRODUCT_CODE', error_code = null,
        error_message = 'Produto sem código externo; associação automática não realizada.'
    where import_id = p_import_id and nullif(btrim(barcode_normalized), '') is null;

    for v_identifier in
        select barcode_normalized as code,
               min(coalesce(nullif(btrim(external_description), ''), 'Produto ' || barcode_normalized)) as description,
               bool_or(barcode_validation_status = 'valid_gtin') as valid_gtin
        from public.market_sales_import_rows
        where import_id = p_import_id and nullif(btrim(barcode_normalized), '') is not null
        group by barcode_normalized
    loop
        select count(distinct product_id), (array_agg(distinct product_id))[1]
        into v_mapping_count, v_mapping_product
        from public.market_product_mappings
        where market_account_id = p_market_account_id
          and source_system = v_import.source_system
          and external_ean = v_identifier.code;

        v_catalog_product := null;
        if v_identifier.valid_gtin then
            select id into v_catalog_product from public.market_products
            where market_account_id = p_market_account_id and ean = v_identifier.code limit 1;
        end if;

        if v_mapping_count > 1 or (v_mapping_count = 1 and v_catalog_product is not null and v_catalog_product <> v_mapping_product) then
            update public.market_sales_import_rows
            set product_id = null, product_resolution_status = 'conflict', status = 'product_pending',
                pending_reason = 'PRODUCT_IDENTIFIER_CONFLICT', error_code = 'PRODUCT_IDENTIFIER_CONFLICT',
                error_message = 'O código está associado de forma conflitante no catálogo.'
            where import_id = p_import_id and barcode_normalized = v_identifier.code;
            continue;
        end if;

        v_product_id := coalesce(v_mapping_product, v_catalog_product);
        if v_product_id is null then
            insert into public.market_products (market_account_id, ean, name, description, created_by)
            values (
                p_market_account_id,
                case when v_identifier.valid_gtin then v_identifier.code else null end,
                v_identifier.description,
                v_identifier.description,
                auth.uid()
            ) returning id into v_product_id;
            v_products_created := v_products_created + 1;
        end if;

        insert into public.market_product_mappings (
            market_account_id, source_system, external_ean, external_description,
            product_id, confidence, confirmed_by, confirmed_at
        ) select
            p_market_account_id, v_import.source_system, v_identifier.code,
            v_identifier.description, v_product_id, 1, auth.uid(), now()
        where not exists (
            select 1 from public.market_product_mappings m
            where m.market_account_id = p_market_account_id
              and m.source_system = v_import.source_system
              and m.external_ean = v_identifier.code
        );

        update public.market_sales_import_rows
        set product_id = v_product_id, product_resolution_status = 'resolved', status = 'processed',
            pending_reason = null, error_code = null, error_message = null
        where import_id = p_import_id and barcode_normalized = v_identifier.code;
    end loop;

    select count(*) filter (where status <> 'error'),
           count(*) filter (where product_resolution_status in ('pending','conflict')),
           count(*) filter (where status = 'error'),
           count(distinct product_id) filter (where product_id is not null)
    into v_processed, v_pending, v_errors, v_products_associated
    from public.market_sales_import_rows where import_id = p_import_id;

    update public.market_sales_imports
    set processed_rows = v_processed, pending_rows = v_pending, error_rows = v_errors,
        status = case when v_pending > 0 or v_errors > 0 then 'completed_with_pending' else 'completed' end,
        processed_at = now()
    where id = p_import_id;

    return jsonb_build_object(
        'importId', p_import_id, 'status', case when v_pending > 0 or v_errors > 0 then 'completed_with_pending' else 'completed' end,
        'totalRows', v_count, 'processedRows', v_processed, 'pendingRows', v_pending,
        'errorRows', v_errors, 'productsCreated', v_products_created,
        'productsAssociated', v_products_associated, 'processedAt', now()
    );
end;
$$;

revoke all on function public.market_is_valid_gtin(text) from public;
revoke all on function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean) from public;
revoke all on function public.market_append_sales_import_chunk(uuid,uuid,jsonb) from public;
revoke all on function public.market_finalize_sales_import(uuid,uuid) from public;
grant execute on function public.market_is_valid_gtin(text) to authenticated;
grant execute on function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean) to authenticated;
grant execute on function public.market_append_sales_import_chunk(uuid,uuid,jsonb) to authenticated;
grant execute on function public.market_finalize_sales_import(uuid,uuid) to authenticated;

commit;
