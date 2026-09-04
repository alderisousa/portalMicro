-- GiroMicro Market - corrige contagem dupla de tokens de apresentacao (peso/
-- volume) no ranking de conciliacao. Sprint 5C.
--
-- CAUSA CONFIRMADA no smoke test real: "350G" contribuia DUAS vezes para o
-- score de um candidato - uma vez via has_presentation_match (+40) e outra vez
-- via word_hits/description_match (+5), porque a extracao de "palavras" da
-- descricao fiscal (CTE "words") nao excluia os proprios tokens de peso/volume.
-- Isso fazia qualquer produto com "350G" no nome parecer ter "descricao
-- semelhante" ao fiscal, mesmo sem nenhuma palavra realmente em comum (ex.:
-- "BEM FOOD MARMITA CARNE LOUCA 350G" pontuando por causa so do "350G").
--
-- CORRECAO (so em market_search_purchase_reconciliation_candidates):
--   1) a CTE "words" agora remove os trechos de apresentacao (mesmo padrao de
--      market_extract_presentation_tokens, migration 008, com \y) da descricao
--      fiscal ANTES de tokenizar em palavras - "350G" nunca mais vira uma
--      "palavra" para fins de word_hits/description_match;
--   2) presentation_match so soma ao score (+40) e so aparece em matchReasons
--      quando o candidato ja tem alguma outra evidencia real (EAN exato,
--      de/para, SKU ou pelo menos 1 palavra textual em comum) - peso/volume
--      sozinho nunca basta para virar sugestao (regra explicita desta
--      correcao, nao so um efeito colateral da fix acima);
--   3) presentation_conflict continua penalizando (-30) sempre que detectado -
--      isso nunca cria falso positivo, so demove.
--
-- A poda relativa (score >= melhor - 40, nunca descarta EAN/de-para) e o
-- LIMIT continuam identicos a 007/008 - com o score corrigido, candidatos
-- irrelevantes (so peso, sem palavra real em comum) ja saem com score <= 0 e
-- sao excluidos pelo "where score > 0" antes mesmo da poda relativa. p_limit
-- continua sendo "no maximo N", nunca "preencher N".
--
-- Migrations 004-008 ja aplicadas e imutaveis, NAO editadas aqui. Nenhuma
-- outra funcao (market_search_market_products, market_search_purchase_
-- reconciliation_by_ean, market_extract_presentation_tokens, confirmar/
-- desfazer/reprocessar) e alterada - nenhuma delas calcula word_hits ou
-- presentation_match. Scanner, fluxo de confirmacao, de/para, externalProductId
-- e frontend continuam intocados. Mesmo padrao set-based da 006/007 - nenhuma
-- funcao escalar reavaliada por produto, sem consulta a outra tabela em loop.
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
            -- Remove os tokens de apresentacao (peso/volume) ANTES de tokenizar
            -- em palavras, para que "350G" nao conte tambem como acerto textual.
            select w from unnest(string_to_array(
                regexp_replace(
                    regexp_replace(
                        upper(coalesce(v_item.description_raw, '')),
                        '(\d+(?:[.,]\d+)?)\s*(ML|KG|GR|G|L)\y', ' ', 'g'
                    ),
                    '[^A-Z0-9 ]', ' ', 'g'
                ), ' '
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
                -- presentation_match so reforca candidato que ja tem outra evidencia
                -- real (EAN/de-para/SKU/palavra) - peso/volume sozinho nunca basta.
                + (case when has_presentation_match
                        and (is_ean_match or is_mapping_match or is_sku_match or word_hits > 0)
                   then 40 else 0 end)
                + (case when has_presentation_conflict then -30 else 0 end)
                + word_hits * 5 as score,
                array_remove(array[
                    case when is_ean_match then 'ean_exact' end,
                    case when is_mapping_match then 'supplier_mapping' end,
                    case when is_sku_match then 'sku_match' end,
                    case when has_presentation_match
                              and (is_ean_match or is_mapping_match or is_sku_match or word_hits > 0)
                         then 'presentation_match' end,
                    case when word_hits > 0 then 'description_match' end
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
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, apresentacao peso/volume, descricao) dentre os produtos Accesys vigentes da conta. Tokens de peso/volume sao excluidos do word_hits textual e presentation_match so conta quando ha outra evidencia real (nunca sozinho). Poda relativa ao melhor score, nunca descarta EAN exato/de-para. Conjunto Accesys vigente calculado uma vez por chamada (CTE), nao por produto.';

commit;
