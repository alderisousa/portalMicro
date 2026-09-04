-- GiroMicro Market - corrige a conciliacao de itens fiscais para nao deixar
-- produtos legados (source_system='franchise_export', sem integracao) competirem
-- com o catalogo Accesys vigente da conta. Sprint 5C.
--
-- Achado no smoke test real: dois "market_products" para o mesmo item -
-- um legado (integration_id null) e um atual do Accesys (source_system='accesys',
-- integration_id valido, external_is_inactive=false) - e as RPCs da migration 004
-- usavam market_products.status='active' diretamente, sem distinguir os dois.
--
-- A migration 004 ja foi aplicada manualmente e NAO e editada aqui. Esta migration
-- so faz CREATE OR REPLACE FUNCTION preservando exatamente as mesmas assinaturas
-- (mesmos nomes de parametro) das funcoes ja implantadas, para que seja um
-- verdadeiro replace e nao um novo overload. Nao altera 001, 002 nem 003.
begin;

-- ---------------------------------------------------------------------------
-- Quando a conta tem uma integracao Accesys ATIVA (market_integrations.provider
-- = 'accesys' and status = 'active'), um produto so conta como "vigente" se
-- houver um market_product_mappings com source_system='accesys', apontando para
-- essa mesma integracao ativa, e external_is_inactive nao for true (aceita tanto
-- false quanto null - null significa "sync nunca sinalizou inativo", nao e o
-- mesmo que confirmado inativo).
--
-- Quando a conta NAO tem nenhuma integracao Accesys ativa, a funcao retorna true
-- sempre - preserva o comportamento anterior para contas sem essa integracao.
-- ---------------------------------------------------------------------------
create or replace function public.market_is_accesys_current_product(
    p_market_account_id uuid,
    p_product_id uuid
)
returns boolean
language sql
stable
as $$
    select
        not exists (
            select 1 from public.market_integrations mi
            where mi.market_account_id = p_market_account_id
              and mi.provider = 'accesys'
              and mi.status = 'active'
        )
        or exists (
            select 1
            from public.market_product_mappings m
            join public.market_integrations mi
              on mi.id = m.integration_id and mi.market_account_id = m.market_account_id
            where m.market_account_id = p_market_account_id
              and m.product_id = p_product_id
              and m.source_system = 'accesys'
              and mi.provider = 'accesys'
              and mi.status = 'active'
              and m.external_is_inactive is not true
        );
$$;

revoke all on function public.market_is_accesys_current_product(uuid,uuid) from public, anon;
grant execute on function public.market_is_accesys_current_product(uuid,uuid) to authenticated;

comment on function public.market_is_accesys_current_product(uuid,uuid) is
    'True se a conta nao tiver integracao Accesys ativa, ou se o produto for o vigente dessa integracao (via market_product_mappings). Usada para excluir produtos legados da conciliacao quando ha Accesys ativo.';

-- ---------------------------------------------------------------------------
-- market_confirm_purchase_item_reconciliation: valida tambem que o produto
-- escolhido e o vigente do Accesys, quando aplicavel - nunca confia so no
-- client, mesmo que a busca/ranking ja tenham filtrado corretamente.
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
    if not public.market_is_accesys_current_product(p_market_account_id, p_market_product_id) then
        raise exception 'RECONCILE_PRODUCT_NOT_CURRENT';
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

-- ---------------------------------------------------------------------------
-- market_reprocess_purchase_pending_items: tanto o match por de/para persistente
-- quanto o match por EAN exato/unico agora so consideram o produto Accesys
-- vigente, quando aplicavel. Isso tambem corrige a ambiguidade de EAN duplicado
-- entre legado e Accesys atual - o legado deixa de contar para v_ean_count.
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
            where pr.id = v_mapped_product
              and pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and public.market_is_accesys_current_product(p_market_account_id, pr.id)
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
              and pr.status = 'active'
              and public.market_is_accesys_current_product(p_market_account_id, pr.id);

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

-- ---------------------------------------------------------------------------
-- market_search_purchase_reconciliation_candidates: o catalogo candidato
-- (evidence) agora so inclui produtos Accesys vigentes, quando aplicavel -
-- o legado para de aparecer como sugestao competindo com o atual.
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
            where pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and public.market_is_accesys_current_product(p_market_account_id, pr.id)
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

-- ---------------------------------------------------------------------------
-- market_search_market_products: a busca manual tambem passa a excluir
-- produtos legados quando ha Accesys ativo - o usuario nao consegue mais
-- "achar" e escolher o produto antigo por engano na busca livre.
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
              and public.market_is_accesys_current_product(p_market_account_id, pr.id)
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

comment on function public.market_confirm_purchase_item_reconciliation(uuid,uuid,uuid,boolean) is
    'Concilia manualmente um item de compra com um produto sincronizado vigente (Accesys, quando aplicavel); opcionalmente salva de/para por fornecedor+codigo.';
comment on function public.market_reprocess_purchase_pending_items(uuid,uuid) is
    'Reaplica de/para persistente e EAN exato/unico aos itens ainda nao resolvidos de uma compra, considerando somente o produto Accesys vigente quando aplicavel.';
comment on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) is
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, descricao) dentre os produtos Accesys vigentes da conta, quando aplicavel.';
comment on function public.market_search_market_products(uuid,text,integer) is
    'Busca manual limitada no catalogo Accesys vigente da conta (quando aplicavel), por EAN, SKU ou descricao.';

commit;
