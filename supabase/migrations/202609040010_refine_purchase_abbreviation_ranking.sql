-- GiroMicro Market - valoriza abreviacoes fiscais distintivas no ranking de
-- conciliacao (ex.: "IPAN" para "IPANEMA", "FAT" para "FATIADO"), sem
-- dicionario de marcas e sem fuzzy matching pesado. Sprint 5C.
--
-- CASO REAL (apos a 009): "MUSS IPAN FAT 150G" retornava os 2 IPANEMA e mais 3
-- concorrentes (FRIMESA/ITALAC/ITAMBE) com diferenca de so 5 pontos entre eles -
-- "IPAN" (bem distintivo) e "MUSS" (generico/categoria) pesavam igual (+5 cada),
-- entao a marca certa nao se destacava o suficiente.
--
-- MECANISMO ADOTADO (generico, sem lista fixa de marcas):
--   para cada palavra fiscal (agora min. 3 letras, antes 4 - permite "FAT"),
--   conta-se em quantos produtos do conjunto ja elegivel (accesys vigente,
--   ativo) ela aparece como substring. Quanto MENOR essa proporcao (palavra
--   rara no catalogo = provavelmente marca/termo distintivo), MAIOR o peso da
--   evidencia; quanto MAIOR a proporcao (palavra comum a muitos produtos =
--   termo de categoria, ex. "queijo", "leite", "mussarela"), MENOR o peso.
--   E o mesmo principio de IDF (inverse document frequency) usado em busca de
--   texto classica, calculado aqui de forma simples (4 faixas fixas sobre a
--   razao match_count/total_elegivel), sem embeddings, sem pg_trgm, sem IA.
--
-- PROTECAO CONTRA FALSO POSITIVO: o calculo de raridade e feito sobre o
-- CONJUNTO DE PRODUTOS DA CONSULTA ATUAL (poucas dezenas a milhares, ja
-- carregado), nao sobre uma tabela auxiliar - uma palavra de 3 letras generica
-- (ex. algo que aparece em quase todo o catalogo) cai automaticamente na faixa
-- de peso minimo, sem precisar de uma regra separada so para "palavra curta".
--
-- presentation_match continua exigindo alguma OUTRA evidencia (EAN, de/para,
-- SKU ou pelo menos 1 palavra textual) para contar - nao muda nesta migration,
-- so a forma de pesar as palavras mudou.
--
-- Migrations 004-009 ja aplicadas e imutaveis, NAO editadas aqui. Apenas
-- market_search_purchase_reconciliation_candidates e substituida (mesma
-- assinatura). Nenhuma outra RPC muda. Continua set-based: o calculo de
-- raridade por palavra roda no maximo uma vez por PALAVRA fiscal (tipicamente
-- 2 a 5), nunca por produto candidato - sem N+1, sem regressao do timeout.
begin;

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
            -- Minimo agora 3 letras (era 4) para permitir abreviacoes curtas
            -- reais como "FAT" - termos curtos genericos ja saem com peso
            -- minimo via word_specificity, entao nao precisam ser bloqueados
            -- aqui por tamanho.
            select w from unnest(string_to_array(
                regexp_replace(
                    regexp_replace(
                        upper(coalesce(v_item.description_raw, '')),
                        '(\d+(?:[.,]\d+)?)\s*(ML|KG|GR|G|L)\y', ' ', 'g'
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
        total_eligible as (
            select count(*) as n from eligible_products
        ),
        -- Raridade de cada palavra fiscal DENTRO do conjunto ja elegivel desta
        -- conta - calculada uma vez por palavra (poucas), nao por produto.
        word_specificity as (
            select
                w.w as word,
                (
                    select count(*) from eligible_products ep
                    where position(w.w in upper(coalesce(ep.name, '') || ' ' || coalesce(ep.description, ''))) > 0
                ) as match_count
            from words w
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
                -- Soma o peso das palavras fiscais que aparecem neste candidato.
                -- Palavra rara no catalogo (provavel marca/termo distintivo) pesa
                -- mais; palavra comum (termo de categoria) pesa pouco.
                coalesce((
                    select sum(
                        case
                            when te.n = 0 then 0
                            when ws.match_count::numeric / te.n <= 0.01 then 18
                            when ws.match_count::numeric / te.n <= 0.05 then 12
                            when ws.match_count::numeric / te.n <= 0.20 then 7
                            else 3
                        end
                    )
                    from word_specificity ws
                    cross join total_eligible te
                    where position(ws.word in upper(coalesce(pr.name, '') || ' ' || coalesce(pr.description, ''))) > 0
                ), 0) as text_score,
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
                -- presentation_match so reforca candidato que ja tem outra evidencia
                -- real (EAN/de-para/SKU/texto) - peso/volume sozinho nunca basta.
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
$$;

comment on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) is
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, apresentacao peso/volume, texto ponderado por especificidade da palavra no catalogo elegivel) dentre os produtos Accesys vigentes da conta. Palavras raras no catalogo pesam mais que termos genericos de categoria; presentation_match so conta com outra evidencia real. Poda relativa ao melhor score, nunca descarta EAN exato/de-para. Conjunto Accesys vigente e raridade de palavra calculados uma vez por chamada (CTEs), nao por produto.';

commit;
