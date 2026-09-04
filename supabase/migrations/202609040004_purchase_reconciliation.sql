-- GiroMicro Market - conciliacao de itens fiscais (market_purchase_items) com o
-- catalogo sincronizado (market_products). Sprint 5C.
--
-- Nenhuma alteracao estrutural foi necessaria: market_purchase_items ja possui
-- market_product_id (com FK para market_products(id, market_account_id) desde a
-- migration core), reconciliation_status/confidence/method/notes (migration 001),
-- e market_purchase_product_mappings ja e o de/para fornecedor->produto (migration
-- 001). Esta migration adiciona somente as FUNCOES (RPCs) que faltavam para operar
-- essa conciliacao com seguranca no backend - nenhuma tabela ou coluna nova.
--
-- Nao altera 202609040001, 202609040002 nem 202609040003.
begin;

-- ---------------------------------------------------------------------------
-- Validador de GTIN (EAN-8/12/13/14, digito verificador mod-10 padrao GS1).
-- Porta exatamente o mesmo algoritmo de src/utils/marketSalesImportParser.ts
-- (analyzeBarcode), verificado par a par contra ele antes de aplicar esta
-- migration. So confiamos em barcode_normalized como EAN quando isto for true.
-- ---------------------------------------------------------------------------
create or replace function public.market_is_valid_gtin(p_code text)
returns boolean
language plpgsql
immutable
as $$
declare
    v_digits text := regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g');
    v_len integer := length(v_digits);
    v_check_digit integer;
    v_sum integer := 0;
    v_weight integer;
    v_i integer;
begin
    if v_len not in (8, 12, 13, 14) then
        return false;
    end if;
    v_check_digit := substr(v_digits, v_len, 1)::integer;
    for v_i in 1..(v_len - 1) loop
        v_weight := case when ((v_len - 1 - v_i) % 2) = 0 then 3 else 1 end;
        v_sum := v_sum + substr(v_digits, v_i, 1)::integer * v_weight;
    end loop;
    return ((10 - (v_sum % 10)) % 10) = v_check_digit;
end;
$$;

revoke all on function public.market_is_valid_gtin(text) from public, anon;
grant execute on function public.market_is_valid_gtin(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Confirma a conciliacao manual de UM item: usuario escolheu o produto na tela.
-- Sempre grava reconciliation_status = 'matched_manual' (decisao humana, nao
-- algoritmica - por isso reconciliation_confidence fica null aqui, reservado
-- para os matches deterministicos automaticos de ean_exact/purchase_mapping).
-- Opcionalmente persiste o de/para fornecedor->produto quando ha
-- supplier_product_code confiavel (nunca cria de/para so pela descricao).
-- ---------------------------------------------------------------------------
create or replace function public.market_confirm_purchase_item_reconciliation(
    p_market_account_id uuid,
    p_purchase_item_id uuid,
    p_market_product_id uuid,
    p_save_supplier_mapping boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item record;
    v_purchase record;
    v_product record;
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select i.id, i.market_purchase_id, i.stock_entry_status, i.supplier_product_code
    into v_item
    from public.market_purchase_items i
    where i.id = p_purchase_item_id and i.market_account_id = p_market_account_id
    for update;

    if not found then
        raise exception 'RECONCILE_ITEM_NOT_FOUND';
    end if;

    if v_item.stock_entry_status <> 'pending' then
        raise exception 'RECONCILE_STOCK_ALREADY_ADVANCED';
    end if;

    select p.id, p.destination_store_id, p.supplier_document
    into v_purchase
    from public.market_purchases p
    where p.id = v_item.market_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    select pr.id, pr.status
    into v_product
    from public.market_products pr
    where pr.id = p_market_product_id and pr.market_account_id = p_market_account_id;

    if not found then
        raise exception 'RECONCILE_PRODUCT_NOT_FOUND';
    end if;
    if v_product.status <> 'active' then
        raise exception 'RECONCILE_PRODUCT_INACTIVE';
    end if;

    update public.market_purchase_items set
        market_product_id = p_market_product_id,
        reconciliation_status = 'matched_manual',
        reconciliation_confidence = null,
        reconciliation_method = 'manual',
        reconciliation_notes = null
    where id = p_purchase_item_id and market_account_id = p_market_account_id;

    if p_save_supplier_mapping and nullif(btrim(v_item.supplier_product_code), '') is not null then
        insert into public.market_purchase_product_mappings (
            market_account_id, supplier_document, supplier_product_code,
            barcode_normalized, description_normalized, market_product_id, created_by
        ) values (
            p_market_account_id,
            nullif(btrim(v_purchase.supplier_document), ''),
            nullif(btrim(v_item.supplier_product_code), ''),
            null, null, p_market_product_id, auth.uid()
        )
        on conflict (
            market_account_id,
            coalesce(supplier_document, ''),
            coalesce(supplier_product_code, ''),
            coalesce(barcode_normalized, ''),
            coalesce(description_normalized, '')
        )
        -- updated_at e mantido pelo trigger market_purchase_product_mappings_touch_updated_at
        do update set market_product_id = excluded.market_product_id;
    end if;

    return jsonb_build_object(
        'purchaseItemId', p_purchase_item_id,
        'marketProductId', p_market_product_id,
        'reconciliationStatus', 'matched_manual'
    );
end;
$$;

revoke all on function public.market_confirm_purchase_item_reconciliation(uuid,uuid,uuid,boolean) from public, anon;
grant execute on function public.market_confirm_purchase_item_reconciliation(uuid,uuid,uuid,boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Desfaz a conciliacao de UM item, somente enquanto stock_entry_status ainda
-- for 'pending'. Nao apaga nenhum de/para persistente ja salvo.
-- ---------------------------------------------------------------------------
create or replace function public.market_undo_purchase_item_reconciliation(
    p_market_account_id uuid,
    p_purchase_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item record;
    v_purchase record;
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select i.id, i.market_purchase_id, i.stock_entry_status
    into v_item
    from public.market_purchase_items i
    where i.id = p_purchase_item_id and i.market_account_id = p_market_account_id
    for update;

    if not found then
        raise exception 'RECONCILE_ITEM_NOT_FOUND';
    end if;

    if v_item.stock_entry_status <> 'pending' then
        raise exception 'RECONCILE_STOCK_ALREADY_ADVANCED';
    end if;

    select p.id, p.destination_store_id
    into v_purchase
    from public.market_purchases p
    where p.id = v_item.market_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    update public.market_purchase_items set
        market_product_id = null,
        reconciliation_status = 'pending',
        reconciliation_confidence = null,
        reconciliation_method = null,
        reconciliation_notes = null
    where id = p_purchase_item_id and market_account_id = p_market_account_id;

    return jsonb_build_object('purchaseItemId', p_purchase_item_id, 'reconciliationStatus', 'pending');
end;
$$;

revoke all on function public.market_undo_purchase_item_reconciliation(uuid,uuid) from public, anon;
grant execute on function public.market_undo_purchase_item_reconciliation(uuid,uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Reprocessa os itens ainda nao resolvidos de UMA nota: reaplica de/para
-- persistente e EAN exato/unico. Nunca toca itens ja matched_auto/matched_manual/
-- mapped. Se nada for encontrado, o item permanece exatamente como estava.
-- ---------------------------------------------------------------------------
create or replace function public.market_reprocess_purchase_pending_items(
    p_market_account_id uuid,
    p_purchase_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_purchase record;
    v_item record;
    v_mapped_product uuid;
    v_ean_product uuid;
    v_ean_count integer;
    v_matched_count integer := 0;
    v_processed_count integer := 0;
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select p.id, p.destination_store_id, p.supplier_document
    into v_purchase
    from public.market_purchases p
    where p.id = p_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    for v_item in
        select i.id, i.supplier_product_code, i.barcode_normalized
        from public.market_purchase_items i
        where i.market_purchase_id = p_purchase_id
          and i.market_account_id = p_market_account_id
          and i.reconciliation_status in ('pending', 'not_found', 'needs_review')
        for update
    loop
        v_processed_count := v_processed_count + 1;
        v_mapped_product := null;
        v_ean_product := null;

        if nullif(btrim(v_item.supplier_product_code), '') is not null then
            select m.market_product_id
            into v_mapped_product
            from public.market_purchase_product_mappings m
            where m.market_account_id = p_market_account_id
              and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
              and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
            limit 1;
        end if;

        if v_mapped_product is not null and exists (
            select 1 from public.market_products pr
            where pr.id = v_mapped_product and pr.market_account_id = p_market_account_id and pr.status = 'active'
        ) then
            update public.market_purchase_items set
                market_product_id = v_mapped_product,
                reconciliation_status = 'mapped',
                reconciliation_confidence = 1.0,
                reconciliation_method = 'purchase_mapping',
                reconciliation_notes = null
            where id = v_item.id;
            v_matched_count := v_matched_count + 1;
            continue;
        end if;

        if v_item.barcode_normalized is not null and public.market_is_valid_gtin(v_item.barcode_normalized) then
            select count(*), min(pr.id)
            into v_ean_count, v_ean_product
            from public.market_products pr
            where pr.market_account_id = p_market_account_id
              and pr.ean = v_item.barcode_normalized
              and pr.status = 'active';

            if v_ean_count = 1 then
                update public.market_purchase_items set
                    market_product_id = v_ean_product,
                    reconciliation_status = 'matched_auto',
                    reconciliation_confidence = 1.0,
                    reconciliation_method = 'ean_exact',
                    reconciliation_notes = null
                where id = v_item.id;
                v_matched_count := v_matched_count + 1;
            end if;
        end if;
    end loop;

    return jsonb_build_object(
        'purchaseId', p_purchase_id,
        'itemsProcessed', v_processed_count,
        'itemsMatched', v_matched_count,
        'itemsStillPending', v_processed_count - v_matched_count
    );
end;
$$;

revoke all on function public.market_reprocess_purchase_pending_items(uuid,uuid) from public, anon;
grant execute on function public.market_reprocess_purchase_pending_items(uuid,uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Ate 5 (no maximo 20) candidatos ranqueados server-side para UM item, sem
-- trazer o catalogo inteiro ao browser. EAN exato e de/para persistente pesam
-- mais que SKU, que pesa mais que sobreposicao de palavras da descricao -
-- nenhum desses sinais fecha a conciliacao sozinho aqui, so ordena sugestoes.
-- ---------------------------------------------------------------------------
create or replace function public.market_search_purchase_reconciliation_candidates(
    p_market_account_id uuid,
    p_purchase_item_id uuid,
    p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_item record;
    v_purchase record;
    v_limit integer := least(greatest(coalesce(p_limit, 5), 1), 20);
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager','viewer']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select i.id, i.market_purchase_id, i.supplier_product_code, i.barcode_normalized, i.description_raw
    into v_item
    from public.market_purchase_items i
    where i.id = p_purchase_item_id and i.market_account_id = p_market_account_id;

    if not found then
        raise exception 'RECONCILE_ITEM_NOT_FOUND';
    end if;

    select p.id, p.destination_store_id, p.supplier_document
    into v_purchase
    from public.market_purchases p
    where p.id = v_item.market_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    return coalesce((
        with words as (
            select w from unnest(string_to_array(
                regexp_replace(upper(coalesce(v_item.description_raw, '')), '[^A-Z0-9 ]', ' ', 'g'), ' '
            )) w
            where length(w) >= 4
        ),
        evidence as (
            select
                pr.id, pr.name, pr.sku, pr.ean, pr.unit,
                (
                    v_item.barcode_normalized is not null
                    and public.market_is_valid_gtin(v_item.barcode_normalized)
                    and pr.ean = v_item.barcode_normalized
                ) as is_ean_match,
                exists (
                    select 1 from public.market_purchase_product_mappings m
                    where m.market_account_id = p_market_account_id
                      and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
                      and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
                      and m.market_product_id = pr.id
                ) as is_mapping_match,
                (
                    nullif(btrim(v_item.supplier_product_code), '') is not null
                    and pr.sku = nullif(btrim(v_item.supplier_product_code), '')
                ) as is_sku_match,
                (
                    select count(*) from words w
                    where position(w in upper(coalesce(pr.name, '') || ' ' || coalesce(pr.description, ''))) > 0
                ) as word_hits
            from public.market_products pr
            where pr.market_account_id = p_market_account_id and pr.status = 'active'
        ),
        scored as (
            select id, name, sku, ean, unit,
                (case when is_ean_match then 100 else 0 end)
                + (case when is_mapping_match then 80 else 0 end)
                + (case when is_sku_match then 20 else 0 end)
                + word_hits * 5 as score,
                array_remove(array[
                    case when is_ean_match then 'ean_exact' end,
                    case when is_mapping_match then 'supplier_mapping' end,
                    case when is_sku_match then 'sku_match' end,
                    case when word_hits > 0 then 'description_match' end
                ], null) as match_reasons
            from evidence
        )
        select jsonb_agg(jsonb_build_object(
            'productId', id, 'name', name, 'sku', sku, 'ean', ean, 'unit', unit,
            'score', score, 'matchReasons', to_jsonb(match_reasons)
        ) order by score desc, name)
        from (
            select * from scored where score > 0 order by score desc, name limit v_limit
        ) top
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) from public, anon;
grant execute on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Busca manual no catalogo (EAN exato / SKU exato / descricao parcial),
-- limitada server-side - nunca traz o catalogo inteiro ao browser.
-- ---------------------------------------------------------------------------
create or replace function public.market_search_market_products(
    p_market_account_id uuid,
    p_query text,
    p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
    v_digits text;
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager','viewer']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    if v_query is null then
        return '[]'::jsonb;
    end if;

    v_digits := regexp_replace(v_query, '[^0-9]', '', 'g');

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'productId', id, 'name', name, 'sku', sku, 'ean', ean, 'unit', unit
        ) order by rank desc, name)
        from (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit,
                (case
                    when v_digits <> '' and pr.ean = v_digits then 100
                    when pr.sku is not null and upper(pr.sku) = upper(v_query) then 90
                    when pr.name ilike '%' || v_query || '%' then 50
                    when pr.description ilike '%' || v_query || '%' then 30
                    else 0
                end) as rank
            from public.market_products pr
            where pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and (
                (v_digits <> '' and pr.ean = v_digits)
                or (pr.sku is not null and upper(pr.sku) = upper(v_query))
                or pr.name ilike '%' || v_query || '%'
                or pr.description ilike '%' || v_query || '%'
              )
            order by rank desc, pr.name
            limit v_limit
        ) matches
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.market_search_market_products(uuid,text,integer) from public, anon;
grant execute on function public.market_search_market_products(uuid,text,integer) to authenticated;

comment on function public.market_confirm_purchase_item_reconciliation(uuid,uuid,uuid,boolean) is
    'Concilia manualmente um item de compra com um produto sincronizado; opcionalmente salva de/para por fornecedor+codigo.';
comment on function public.market_undo_purchase_item_reconciliation(uuid,uuid) is
    'Desfaz a conciliacao de um item enquanto stock_entry_status ainda for pending; nao remove de/para persistente.';
comment on function public.market_reprocess_purchase_pending_items(uuid,uuid) is
    'Reaplica de/para persistente e EAN exato/unico aos itens ainda nao resolvidos de uma compra.';
comment on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) is
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, descricao) para um item de compra.';
comment on function public.market_search_market_products(uuid,text,integer) is
    'Busca manual limitada no catalogo sincronizado por EAN, SKU ou descricao.';

commit;
