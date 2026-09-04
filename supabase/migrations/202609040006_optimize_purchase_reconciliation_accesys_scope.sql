-- GiroMicro Market - corrige o timeout (57014) na conciliacao de itens fiscais
-- com ~5.336 produtos sincronizados. Sprint 5C.
--
-- CAUSA: market_search_purchase_reconciliation_candidates e
-- market_search_market_products (migration 005) chamavam
-- market_is_accesys_current_product(account, product_id) uma vez PARA CADA linha
-- de market_products (ate ~5.336 chamadas por consulta). Cada chamada refazia,
-- sozinha, o JOIN market_product_mappings x market_integrations - um padrao O(n^2)
-- (n produtos x n mappings), sem indice em market_product_mappings.product_id
-- para tornar cada chamada barata. Isso e o suficiente para estourar o
-- statement_timeout sozinho, mesmo em uma conta de porte pequeno/medio.
--
-- INDEXES: auditados antes de alterar qualquer RPC. Nenhum indice novo foi
-- necessario - ja existem e cobrem exatamente os filtros usados aqui:
--   ix_market_product_mappings_lookup(market_account_id, source_system, ...)
--     (202608310001) cobre m.market_account_id + m.source_system = 'accesys'.
--   ix_market_integrations_account_status(market_account_id, status)
--     (202609020001) cobre mi.market_account_id + mi.status = 'active'.
--   ux_market_products_account_ean / ux_market_products_account_sku
--     (202608310001) ja cobrem os matches exatos de EAN/SKU usados em
--     market_reprocess_purchase_pending_items e market_search_market_products.
--
-- CORRECAO: calcular o conjunto de produtos Accesys vigentes UMA VEZ por
-- chamada de RPC (CTE com JOIN/EXISTS), em vez de reavaliar a funcao escalar
-- para cada produto. market_is_accesys_current_product continua existindo e e
-- reaproveitada sem alteracao onde so precisa validar UM produto por vez
-- (market_confirm_purchase_item_reconciliation, e as duas checagens de
-- market_reprocess_purchase_pending_items - ali cada checagem ja incide sobre
-- no maximo 1 produto por vez, por causa do proprio de/para ou do indice unico
-- de EAN por conta: nao ha N+1 nessas duas, revisado e confirmado abaixo).
--
-- A migration 005 ja foi aplicada manualmente e NAO e editada aqui. Esta
-- migration so faz CREATE OR REPLACE FUNCTION nas duas RPCs que faziam scan de
-- catalogo inteiro, preservando exatamente as mesmas assinaturas ja implantadas
-- e a MESMA semantica funcional da 005 (nenhuma regra de elegibilidade Accesys
-- mudou, so a forma de calcula-la). Nao altera 001, 002, 003 nem 004.
begin;

-- ---------------------------------------------------------------------------
-- market_search_purchase_reconciliation_candidates: calcula o conjunto de
-- produtos Accesys vigentes UMA VEZ (accesys_current_products), reduz
-- market_products a eligible_products com um unico LEFT JOIN/hash lookup, e so
-- entao aplica o ranking (EAN, de/para, SKU, palavras da descricao) sobre esse
-- conjunto ja reduzido - sem chamar nenhuma funcao escalar por produto.
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
        has_active_accesys as (
            select exists (
                select 1 from public.market_integrations mi
                where mi.market_account_id = p_market_account_id
                  and mi.provider = 'accesys'
                  and mi.status = 'active'
            ) as value
        ),
        -- Um unico JOIN/filtro sobre market_product_mappings x market_integrations,
        -- calculado uma vez (nao por produto). distinct evita duplicar produto
        -- quando ha mais de um mapping externo apontando para o mesmo product_id.
        accesys_current_products as (
            select distinct m.product_id
            from public.market_product_mappings m
            join public.market_integrations mi
              on mi.id = m.integration_id and mi.market_account_id = m.market_account_id
            where m.market_account_id = p_market_account_id
              and m.source_system = 'accesys'
              and mi.provider = 'accesys'
              and mi.status = 'active'
              and m.external_is_inactive is not true
        ),
        eligible_products as (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.description
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
            from eligible_products pr
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
-- market_search_market_products: mesma estrategia - eligible_products
-- calculado uma vez via LEFT JOIN, sem chamar funcao escalar por produto. A
-- busca por EAN/SKU/descricao continua identica a da 005.
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
            select distinct m.product_id
            from public.market_product_mappings m
            join public.market_integrations mi
              on mi.id = m.integration_id and mi.market_account_id = m.market_account_id
            where m.market_account_id = p_market_account_id
              and m.source_system = 'accesys'
              and mi.provider = 'accesys'
              and mi.status = 'active'
              and m.external_is_inactive is not true
        ),
        eligible_products as (
            select pr.id, pr.name, pr.sku, pr.ean, pr.unit, pr.description
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

comment on function public.market_search_purchase_reconciliation_candidates(uuid,uuid,integer) is
    'Ate 20 candidatos ranqueados server-side (EAN, de/para, SKU, descricao) dentre os produtos Accesys vigentes da conta, quando aplicavel. Conjunto Accesys vigente calculado uma vez por chamada (CTE), nao por produto.';
comment on function public.market_search_market_products(uuid,text,integer) is
    'Busca manual limitada no catalogo Accesys vigente da conta (quando aplicavel), por EAN, SKU ou descricao. Conjunto Accesys vigente calculado uma vez por chamada (CTE), nao por produto.';

commit;
