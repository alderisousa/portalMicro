-- GiroMicro Market - refina o ranking de conciliacao apos o smoke test real
-- (caso NESCAU 350G vs 200G/370G, caso PIRACANJUBA vs concorrentes) e expoe o
-- codigo Accesys (external_product_id) nas sugestoes/busca. Sprint 5C.
--
-- A migration 006 ja foi aplicada manualmente e NAO e editada aqui. Esta
-- migration so faz CREATE OR REPLACE FUNCTION preservando as assinaturas ja
-- implantadas de market_search_purchase_reconciliation_candidates e
-- market_search_market_products, mais UMA funcao auxiliar nova
-- (market_extract_presentation_tokens) e UMA RPC nova para o scanner
-- (market_search_purchase_reconciliation_by_ean). Nao altera 001-006.
--
-- PERFORMANCE: mantido o mesmo padrao set-based da 006 (CTEs calculadas uma
-- vez, sem funcao escalar reavaliada por produto, sem consulta a outra tabela
-- dentro de um loop por linha). market_extract_presentation_tokens e IMMUTABLE
-- e opera so sobre o texto ja carregado em memoria (regex), sem tocar o banco -
-- mesma classe de custo do word_hits que ja existia na 004/005/006.
begin;

-- ---------------------------------------------------------------------------
-- Extrai tokens normalizados de apresentacao (peso/volume) de um texto, ex.:
-- "350G" -> {G:350}; "1KG" -> {G:1000} (1000g); "1L" -> {ML:1000}; "500ML" ->
-- {ML:500}. Reconhece tambem a abreviacao "GR" (comum nas NFC-e reais deste
-- projeto, ex. "SUCRILH 240GR..."). Nao converte entre peso e volume (familias
-- separadas por prefixo G:/ML:) e nao inventa conversao de embalagem (DP/CX
-- continuam fora disso - ja tratado so na UI, visualmente, desde a Sprint
-- anterior). IMMUTABLE: nao consulta nenhuma tabela, so processa o texto.
-- ---------------------------------------------------------------------------
create or replace function public.market_extract_presentation_tokens(p_text text)
returns text[]
language sql
immutable
as $$
    select coalesce(array_agg(distinct token), array[]::text[])
    from (
        select case upper(m[2])
            when 'KG' then 'G:' || round(replace(m[1], ',', '.')::numeric * 1000)::text
            when 'GR' then 'G:' || round(replace(m[1], ',', '.')::numeric)::text
            when 'G'  then 'G:' || round(replace(m[1], ',', '.')::numeric)::text
            when 'L'  then 'ML:' || round(replace(m[1], ',', '.')::numeric * 1000)::text
            when 'ML' then 'ML:' || round(replace(m[1], ',', '.')::numeric)::text
        end as token
        from regexp_matches(upper(coalesce(p_text, '')), '(\d+(?:[.,]\d+)?)\s*(ML|KG|GR|G|L)\b', 'g') as m
    ) tokens;
$$;

revoke all on function public.market_extract_presentation_tokens(text) from public, anon;
grant execute on function public.market_extract_presentation_tokens(text) to authenticated;

comment on function public.market_extract_presentation_tokens(text) is
    'Extrai tokens normalizados de peso/volume de um texto (350G, 1KG=1000G, 1L=1000ML, 500ML, 240GR). Usada so para ranking de sugestoes - nunca altera quantity/unit fiscais.';

-- ---------------------------------------------------------------------------
-- market_search_purchase_reconciliation_candidates:
--   1) retorna externalProductId (codigo Accesys) por candidato, via a mesma
--      CTE que ja decide elegibilidade Accesys (distinct on product_id evita
--      duplicar quando ha mais de um mapping externo para o mesmo produto);
--   2) adiciona evidencia de apresentacao (peso/volume): match forte (+40),
--      conflito forte (-30) quando a nota tem uma apresentacao clara e o
--      candidato tem outra;
--   3) poda relativa ao melhor score (nunca descarta EAN exato/de-para):
--      mantem so candidatos dentro de 40 pontos do melhor, ou com score<=0
--      exclui totalmente - nao preenche 5 sugestoes artificialmente.
-- Continua sem nenhuma funcao escalar reavaliada por produto (mesmo padrao
-- set-based da 006).
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
        eligible_products as (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.description, acp.external_product_id
            from public.market_products pr
            left join accesys_current_products acp on acp.product_id = pr.id
            where pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and (
                not (select value from has_active_accesys)
                or acp.product_id is not null
              )
        ),
        evidence as (
            select
                pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.external_product_id,
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
                ) as word_hits,
                (fp.tokens && ct.tokens) as has_presentation_match,
                (array_length(fp.tokens, 1) > 0 and not (fp.tokens && ct.tokens)) as has_presentation_conflict
            from eligible_products pr
            cross join fiscal_presentation fp
            cross join lateral (
                select public.market_extract_presentation_tokens(pr.name || ' ' || coalesce(pr.description, '')) as tokens
            ) ct
        ),
        scored as (
            select id, name, sku, ean, unit, external_product_id, is_ean_match, is_mapping_match,
                (case when is_ean_match then 100 else 0 end)
                + (case when is_mapping_match then 80 else 0 end)
                + (case when is_sku_match then 20 else 0 end)
                + (case when has_presentation_match then 40 else 0 end)
                + (case when has_presentation_conflict then -30 else 0 end)
                + word_hits * 5 as score,
                array_remove(array[
                    case when is_ean_match then 'ean_exact' end,
                    case when is_mapping_match then 'supplier_mapping' end,
                    case when is_sku_match then 'sku_match' end,
                    case when has_presentation_match then 'presentation_match' end,
                    case when word_hits > 0 then 'description_match' end
                ], null) as match_reasons
            from evidence
        ),
        -- score>0 ja exclui a maioria dos candidatos com apresentacao conflitante
        -- (penalidade de -30 costuma zerar o ganho de description_match sozinho).
        -- A poda relativa abaixo cobre os demais casos, sem nunca descartar
        -- EAN exato/de-para.
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
$$;

-- ---------------------------------------------------------------------------
-- market_search_market_products: so adiciona externalProductId ao resultado
-- (mesma CTE de elegibilidade Accesys). Ranking da busca manual permanece
-- identico ao da 006 - o usuario ja digitou o que procura.
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
        with has_active_accesys as (
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
        eligible_products as (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.description, acp.external_product_id
            from public.market_products pr
            left join accesys_current_products acp on acp.product_id = pr.id
            where pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and (
                not (select value from has_active_accesys)
                or acp.product_id is not null
              )
        )
        select jsonb_agg(jsonb_build_object(
            'productId', id, 'name', name, 'sku', sku, 'ean', ean, 'unit', unit,
            'externalProductId', external_product_id
        ) order by rank desc, name)
        from (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.external_product_id,
                (case
                    when v_digits <> '' and pr.ean = v_digits then 100
                    when pr.sku is not null and upper(pr.sku) = upper(v_query) then 90
                    when pr.name ilike '%' || v_query || '%' then 50
                    when pr.description ilike '%' || v_query || '%' then 30
                    else 0
                end) as rank
            from eligible_products pr
            where
                (v_digits <> '' and pr.ean = v_digits)
                or (pr.sku is not null and upper(pr.sku) = upper(v_query))
                or pr.name ilike '%' || v_query || '%'
                or pr.description ilike '%' || v_query || '%'
            order by rank desc, pr.name
            limit v_limit
        ) matches
    ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- market_search_purchase_reconciliation_by_ean: usada pelo botao "Ler codigo
-- de barras". Recebe o EAN lido pela camera, valida GTIN no servidor (defesa
-- em profundidade - o cliente ja valida antes de chamar), e devolve os
-- produtos Accesys vigentes com esse EAN exato (0, 1 ou mais). Nao persiste o
-- EAN lido em nenhuma tabela - e evidencia operacional transitoria, nao um
-- dado da NFC-e.
-- ---------------------------------------------------------------------------
create or replace function public.market_search_purchase_reconciliation_by_ean(
    p_market_account_id uuid,
    p_ean text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_ean text := regexp_replace(coalesce(p_ean, ''), '[^0-9]', '', 'g');
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager','viewer']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    if v_ean = '' or not public.market_is_valid_gtin(v_ean) then
        raise exception 'RECONCILE_INVALID_EAN';
    end if;

    return coalesce((
        with has_active_accesys as (
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
        )
        select jsonb_agg(jsonb_build_object(
            'productId', pr.id, 'name', pr.name, 'sku', pr.sku, 'ean', pr.ean, 'unit', pr.unit,
            'externalProductId', acp.external_product_id
        ) order by pr.name)
        from public.market_products pr
        left join accesys_current_products acp on acp.product_id = pr.id
        where pr.market_account_id = p_market_account_id
          and pr.status = 'active'
          and pr.ean = v_ean
          and (
            not (select value from has_active_accesys)
            or acp.product_id is not null
          )
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.market_search_purchase_reconciliation_by_ean(uuid,text) from public, anon;
grant execute on function public.market_search_purchase_reconciliation_by_ean(uuid,text) to authenticated;

comment on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) is
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, apresentacao peso/volume, descricao) dentre os produtos Accesys vigentes da conta, com poda relativa ao melhor score (nunca descarta EAN exato/de-para). Conjunto Accesys vigente calculado uma vez por chamada (CTE), nao por produto.';
comment on function public.market_search_market_products(uuid,text,integer) is
    'Busca manual limitada no catalogo Accesys vigente da conta (quando aplicavel), por EAN, SKU ou descricao, retornando o codigo Accesys (externalProductId) de cada produto.';
comment on function public.market_search_purchase_reconciliation_by_ean(uuid,text) is
    'Busca por EAN exato (leitor de codigo de barras) no catalogo Accesys vigente da conta. Nao persiste o EAN lido em nenhuma tabela.';

commit;
