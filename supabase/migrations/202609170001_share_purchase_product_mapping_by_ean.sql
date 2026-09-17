-- Compartilha o aprendizado de de/para de compras entre Markets usando EAN
-- como identidade portavel, sem compartilhar UUIDs locais de market_products.
--
-- Regras:
--   1) de/para do Market atual sempre tem prioridade;
--   2) somente na ausencia de de/para local, consulta aprendizados de outros Markets;
--   3) o aprendizado compartilhado e convertido pelo EAN do produto de origem
--      para o produto Accesys ativo/corrente do Market atual;
--   4) sem EAN valido, sem produto correspondente ou com EANs aprendidos
--      conflitantes, nao ha resolucao automatica;
--   5) nenhuma estrutura, FK, gravacao de mapping ou conversao de unidade e alterada.

begin;

create or replace function public.market_reprocess_purchase_pending_items(
    p_market_account_id uuid,
    p_purchase_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_purchase record;
    v_item record;
    v_mapped_product uuid;
    v_mapping_count integer;
    v_shared_ean text;
    v_shared_ean_count integer;
    v_ean_product uuid;
    v_ean_count integer;
    v_matched_count integer := 0;
    v_processed_count integer := 0;
begin
    perform public.market_assert_purchase_review_access(p_market_account_id,p_purchase_id);
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
        select i.id, i.supplier_product_code, i.barcode_normalized, i.description_raw
        from public.market_purchase_items i
        where i.market_purchase_id = p_purchase_id
          and i.market_account_id = p_market_account_id
          and i.stock_entry_status = 'pending'
          and i.reconciliation_status in ('pending', 'not_found', 'needs_review')
        for update
    loop
        v_processed_count := v_processed_count + 1;
        v_mapped_product := null;
        v_mapping_count := 0;
        v_shared_ean := null;
        v_shared_ean_count := 0;
        v_ean_product := null;
        v_ean_count := 0;

        if nullif(btrim(v_item.supplier_product_code), '') is not null then
            -- 1) O aprendizado do proprio Market sempre prevalece.
            -- Campos preenchidos no mapping qualificam a identidade; campos
            -- vazios preservam o de/para manual por fornecedor + codigo.
            select count(*), min(m.market_product_id::text)::uuid
            into v_mapping_count, v_mapped_product
            from public.market_purchase_product_mappings m
            where m.market_account_id = p_market_account_id
              and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
              and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
              and (nullif(btrim(m.barcode_normalized), '') is null
                or m.barcode_normalized = v_item.barcode_normalized)
              and (nullif(btrim(m.description_normalized), '') is null
                or upper(regexp_replace(btrim(m.description_normalized), '[[:space:]]+', ' ', 'g'))
                  = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')));

            -- 2) Somente sem aprendizado local, reaproveita conhecimento de
            -- outros Markets. UUID nunca atravessa tenant: obtem o EAN do
            -- produto que originou o aprendizado e resolve o UUID no Market atual.
            if v_mapping_count = 0 then
                select count(distinct origin_product.ean), min(origin_product.ean)
                into v_shared_ean_count, v_shared_ean
                from public.market_purchase_product_mappings m
                join public.market_products origin_product
                  on origin_product.id = m.market_product_id
                 and origin_product.market_account_id = m.market_account_id
                where m.market_account_id <> p_market_account_id
                  and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
                  and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
                  and (nullif(btrim(m.barcode_normalized), '') is null
                    or m.barcode_normalized = v_item.barcode_normalized)
                  and (nullif(btrim(m.description_normalized), '') is null
                    or upper(regexp_replace(btrim(m.description_normalized), '[[:space:]]+', ' ', 'g'))
                      = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')))
                  and origin_product.ean is not null
                  and public.market_is_valid_gtin(origin_product.ean);

                if v_shared_ean_count > 1 then
                    update public.market_purchase_items set
                        market_product_id = null,
                        reconciliation_status = 'needs_review',
                        reconciliation_confidence = null,
                        reconciliation_method = null,
                        reconciliation_notes = 'De/para compartilhado ambiguo entre Markets; selecione o produto manualmente.'
                    where id = v_item.id and market_account_id = p_market_account_id;
                    continue;
                end if;

                if v_shared_ean_count = 1 then
                    select count(*), min(pr.id::text)::uuid
                    into v_ean_count, v_ean_product
                    from public.market_products pr
                    where pr.market_account_id = p_market_account_id
                      and pr.ean = v_shared_ean
                      and pr.status = 'active'
                      and public.market_is_accesys_current_product(p_market_account_id, pr.id);

                    if v_ean_count = 1 then
                        v_mapped_product := v_ean_product;
                        v_mapping_count := 1;
                    end if;
                end if;
            end if;
        end if;

        -- Nao desempata identidades locais concorrentes por ordem fisica, UUID
        -- ou EAN. A decisao continua explicita como no comportamento anterior.
        if v_mapping_count > 1 then
            update public.market_purchase_items set
                market_product_id = null, reconciliation_status = 'needs_review',
                reconciliation_confidence = null, reconciliation_method = null,
                reconciliation_notes = 'Mais de um de/para compativel; selecione o produto manualmente.'
            where id = v_item.id and market_account_id = p_market_account_id;
            continue;
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
                reconciliation_method = case
                    when v_shared_ean_count = 1 then 'purchase_mapping_shared_ean'
                    else 'purchase_mapping'
                end,
                reconciliation_notes = null
            where id = v_item.id;
            perform public.market_resolve_purchase_item_unit(p_market_account_id, v_item.id);
            v_matched_count := v_matched_count + 1;
            continue;
        end if;

        -- Mantem intacto o fallback ja existente: EAN vindo diretamente da nota.
        if v_item.barcode_normalized is not null and public.market_is_valid_gtin(v_item.barcode_normalized) then
            select count(*), min(pr.id::text)::uuid
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
                perform public.market_resolve_purchase_item_unit(p_market_account_id, v_item.id);
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
$function$;

create or replace function public.market_search_purchase_reconciliation_candidates(
    p_market_account_id uuid,
    p_purchase_item_id uuid,
    p_limit integer default 5
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
                regexp_replace(
                    regexp_replace(
                        upper(coalesce(v_item.description_raw, '')),
                        '(\\d+(?:[.,]\\d+)?)\\s*(ML|KG|GR|G|L)\\y', ' ', 'g'
                    ),
                    '[^A-Z0-9 ]', ' ', 'g'
                ), ' '
            )) w
            where length(w) >= 3
        ),
        fiscal_presentation as (
            select public.market_extract_presentation_tokens(v_item.description_raw) as tokens
        ),
        has_active_accesys as (
            select exists (
                select 1 from public.market_integrations mi
                where mi.market_account_id = p_market_account_id
                  and mi.provider = 'accesys'
                  and mi.status = 'active'
            ) as value
        ),
        accesys_current_products as (
            select distinct on (m.product_id) m.product_id, m.external_product_id
            from public.market_product_mappings m
            join public.market_integrations mi
              on mi.id = m.integration_id and mi.market_account_id = m.market_account_id
            where m.market_account_id = p_market_account_id
              and m.source_system = 'accesys'
              and mi.provider = 'accesys'
              and mi.status = 'active'
              and m.external_is_inactive is not true
            order by m.product_id, m.external_product_id
        ),
        eligible_products as materialized (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.description, acp.external_product_id,
                   upper(coalesce(pr.name, '') || ' ' || coalesce(pr.description, '')) as haystack
            from public.market_products pr
            left join accesys_current_products acp on acp.product_id = pr.id
            where pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and (
                not (select value from has_active_accesys)
                or acp.product_id is not null
              )
        ),
        total_eligible as (
            select count(*) as n from eligible_products
        ),
        word_matches as (
            select ep.id as product_id, w.w as word
            from eligible_products ep
            join words w on position(w.w in ep.haystack) > 0
        ),
        word_specificity as (
            select word, count(*) as match_count
            from word_matches
            group by word
        ),
        product_text_score as (
            select wm.product_id,
                sum(
                    case
                        when te.n = 0 then 0
                        when ws.match_count::numeric / te.n <= 0.01 then 18
                        when ws.match_count::numeric / te.n <= 0.05 then 12
                        when ws.match_count::numeric / te.n <= 0.20 then 7
                        else 3
                    end
                ) as text_score
            from word_matches wm
            join word_specificity ws on ws.word = wm.word
            cross join total_eligible te
            group by wm.product_id
        ),
        local_mapping_state as (
            select exists (
                select 1
                from public.market_purchase_product_mappings m
                where m.market_account_id = p_market_account_id
                  and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
                  and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
                  and (nullif(btrim(m.barcode_normalized), '') is null
                    or m.barcode_normalized = v_item.barcode_normalized)
                  and (nullif(btrim(m.description_normalized), '') is null
                    or upper(regexp_replace(btrim(m.description_normalized), '[[:space:]]+', ' ', 'g'))
                      = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')))
            ) as exists_local
        ),
        shared_mapping_eans as (
            select distinct origin_product.ean
            from public.market_purchase_product_mappings m
            join public.market_products origin_product
              on origin_product.id = m.market_product_id
             and origin_product.market_account_id = m.market_account_id
            cross join local_mapping_state lms
            where not lms.exists_local
              and m.market_account_id <> p_market_account_id
              and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
              and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
              and (nullif(btrim(m.barcode_normalized), '') is null
                or m.barcode_normalized = v_item.barcode_normalized)
              and (nullif(btrim(m.description_normalized), '') is null
                or upper(regexp_replace(btrim(m.description_normalized), '[[:space:]]+', ' ', 'g'))
                  = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')))
              and origin_product.ean is not null
              and public.market_is_valid_gtin(origin_product.ean)
        ),
        shared_mapping_state as (
            select count(*) as ean_count, min(ean) as ean
            from shared_mapping_eans
        ),
        evidence as (
            select
                pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.external_product_id,
                (
                    v_item.barcode_normalized is not null
                    and public.market_is_valid_gtin(v_item.barcode_normalized)
                    and pr.ean = v_item.barcode_normalized
                ) as is_ean_match,
                (
                    exists (
                        select 1 from public.market_purchase_product_mappings m
                        where m.market_account_id = p_market_account_id
                          and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
                          and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
                          and m.market_product_id = pr.id
                          and (nullif(btrim(m.barcode_normalized), '') is null
                            or m.barcode_normalized = v_item.barcode_normalized)
                          and (nullif(btrim(m.description_normalized), '') is null
                            or upper(regexp_replace(btrim(m.description_normalized), '[[:space:]]+', ' ', 'g'))
                              = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')))
                    )
                    or (
                        not (select exists_local from local_mapping_state)
                        and (select ean_count from shared_mapping_state) = 1
                        and pr.ean = (select ean from shared_mapping_state)
                    )
                ) as is_mapping_match,
                (
                    nullif(btrim(v_item.supplier_product_code), '') is not null
                    and pr.sku = nullif(btrim(v_item.supplier_product_code), '')
                ) as is_sku_match,
                coalesce(pts.text_score, 0) as text_score,
                (fp.tokens && ct.tokens) as has_presentation_match,
                (array_length(fp.tokens, 1) > 0 and not (fp.tokens && ct.tokens)) as has_presentation_conflict
            from eligible_products pr
            cross join fiscal_presentation fp
            left join product_text_score pts on pts.product_id = pr.id
            cross join lateral (
                select public.market_extract_presentation_tokens(pr.name || ' ' || coalesce(pr.description, '')) as tokens
            ) ct
        ),
        scored as (
            select id, name, sku, ean, unit, external_product_id, is_ean_match, is_mapping_match,
                (case when is_ean_match then 100 else 0 end)
                + (case when is_mapping_match then 80 else 0 end)
                + (case when is_sku_match then 20 else 0 end)
                + (case when has_presentation_match
                        and (is_ean_match or is_mapping_match or is_sku_match or text_score > 0)
                   then 40 else 0 end)
                + (case when has_presentation_conflict then -30 else 0 end)
                + text_score as score,
                array_remove(array[
                    case when is_ean_match then 'ean_exact' end,
                    case when is_mapping_match then 'supplier_mapping' end,
                    case when is_sku_match then 'sku_match' end,
                    case when has_presentation_match
                              and (is_ean_match or is_mapping_match or is_sku_match or text_score > 0)
                         then 'presentation_match' end,
                    case when text_score > 0 then 'description_match' end
                ], null) as match_reasons
            from evidence
        ),
        capped as (
            select *, max(score) over () as max_score
            from scored
            where score > 0
        )
        select jsonb_agg(jsonb_build_object(
            'productId', id, 'name', name, 'sku', sku, 'ean', ean, 'unit', unit,
            'externalProductId', external_product_id,
            'score', score, 'matchReasons', to_jsonb(match_reasons)
        ) order by score desc, name)
        from (
            select * from capped
            where is_ean_match or is_mapping_match or score >= max_score - 40
            order by score desc, name
            limit v_limit
        ) top
    ), '[]'::jsonb);
end;
$function$;

commit;
