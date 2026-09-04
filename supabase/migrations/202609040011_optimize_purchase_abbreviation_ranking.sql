-- GiroMicro Market - corrige o timeout (57014) reintroduzido pela migration
-- 010 no ranking de conciliacao, preservando o comportamento aprovado (IPAN,
-- PIRACANJ, TODDY pesando mais que termos genericos). Sprint 5C.
--
-- CAUSA PROVAVEL (analise estrutural do SQL da 010 - sem Postgres local para
-- EXPLAIN ANALYZE real, confirmar no smoke test apos aplicar esta migration):
--
-- Em "word_specificity" (010), o match_count de cada palavra fiscal era uma
-- SUBQUERY CORRELACIONADA que reconsultava eligible_products inteira:
--   select count(*) from eligible_products ep where position(w.w in ...) > 0
-- Essa subquery, por sua vez, era referenciada de DENTRO de outra subquery
-- correlacionada em "evidence" (text_score), avaliada POR PRODUTO candidato:
--   select sum(...) from word_specificity ws ... where position(ws.word in
--   upper(pr.name...)) > 0
-- Como PostgreSQL (12+) normalmente faz INLINE de CTEs (nao materializa por
-- padrao), nada nesta consulta garantia que "word_specificity" - e a varredura
-- de eligible_products dentro dela - fosse calculada uma unica vez. O plano
-- pode ter reavaliado o match_count de cada palavra a cada produto candidato,
-- equivalente a produtos x palavras x nova varredura completa de produtos -
-- ordem de grandeza suficiente para estourar o timeout com ~5.336 produtos,
-- mesmo sem nenhuma funcao escalar por linha e sem N+1 classico de tabela.
--
-- CORRECAO: eliminar toda subquery correlacionada aninhada do calculo de
-- especificidade/score textual, substituindo por um pipeline de JOIN + GROUP
-- BY puro (a "matriz produto x palavra" sugerida na auditoria):
--   1) eligible_products agora e MATERIALIZED - e referenciada 3 vezes a
--      seguir (total_eligible, word_matches, evidence) e seu calculo (join com
--      accesys_current_products + verificacao de integracao ativa) nao e
--      trivial; forcar UMA materializacao evita qualquer reexecucao, custo ou
--      dependente do planner;
--   2) word_matches: UM JOIN (nao subquery correlacionada) entre
--      eligible_products e words, produzindo a matriz produto x palavra
--      combatida - calculado uma unica vez;
--   3) word_specificity: GROUP BY sobre word_matches - conta quantos produtos
--      cada palavra bate, uma unica vez;
--   4) product_text_score: GROUP BY sobre word_matches + word_specificity -
--      soma o peso por especificidade de cada produto, uma unica vez;
--   5) evidence agora faz um LEFT JOIN simples em product_text_score (nao mais
--      subquery correlacionada) para obter text_score.
-- Nenhuma consulta a tabela e repetida por produto ou por palavra alem do que
-- e estritamente necessario; nenhuma funcao escalar por linha foi introduzida.
--
-- COMPORTAMENTO PRESERVADO (matematica identica a 010, so a execucao mudou -
-- validado com simulacao equivalente antes de aplicar):
--   - mesmas 4 faixas de peso por raridade (<=1%->18, <=5%->12, <=20%->7, senao->3);
--   - presentation_match so conta com outra evidencia real (inalterado);
--   - presentation_conflict continua penalizando (-30, inalterado);
--   - is_ean_match/is_mapping_match/is_sku_match inalterados (ja eram baratos:
--     comparacoes constantes ou lookup por chave unica em tabela pequena,
--     nunca foram a causa do timeout);
--   - poda relativa ao melhor score (>=melhor-40) e "nunca descarta EAN/de-para"
--     inalteradas;
--   - auto-conciliacao continua reservada a EAN exato e de/para (nesta funcao
--     de candidatos nada muda isso - ela so ranqueia sugestoes).
--
-- Migrations 004-010 ja aplicadas e imutaveis, NAO editadas aqui. Apenas
-- market_search_purchase_reconciliation_candidates e substituida (mesma
-- assinatura). Nenhuma outra RPC muda. Nenhum indice novo foi criado - o
-- gargalo era estrutural (reexecucao), nao falta de indice; os indices ja
-- auditados em 006 (ix_market_product_mappings_lookup,
-- ix_market_integrations_account_status) continuam suficientes para o JOIN de
-- accesys_current_products.
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
        -- MATERIALIZED de proposito: referenciada 3 vezes abaixo (total_eligible,
        -- word_matches, evidence) e seu calculo (join com accesys_current_products
        -- + checagem de integracao ativa) nao e trivial - forcar UMA
        -- materializacao evita qualquer reexecucao dependente do planner.
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
        -- Matriz produto x palavra fiscal batida - UM join, calculado uma unica
        -- vez (nao subquery correlacionada por palavra nem por produto).
        word_matches as (
            select ep.id as product_id, w.w as word
            from eligible_products ep
            join words w on position(w.w in ep.haystack) > 0
        ),
        -- Raridade de cada palavra (quantos produtos elegiveis ela bate) via
        -- GROUP BY sobre a matriz ja calculada - uma unica vez.
        word_specificity as (
            select word, count(*) as match_count
            from word_matches
            group by word
        ),
        -- Soma do peso por especificidade, por produto, via GROUP BY sobre a
        -- mesma matriz - uma unica vez. Palavra rara no catalogo elegivel pesa
        -- mais que termo generico de categoria (mesmas 4 faixas da 010).
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
$$;

comment on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) is
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, apresentacao peso/volume, texto ponderado por especificidade da palavra no catalogo elegivel) dentre os produtos Accesys vigentes da conta. Raridade/score textual calculados via JOIN + GROUP BY (matriz produto x palavra), nunca subquery correlacionada por produto - eligible_products e MATERIALIZED por ser referenciada multiplas vezes. presentation_match so conta com outra evidencia real. Poda relativa ao melhor score, nunca descarta EAN exato/de-para.';

commit;
