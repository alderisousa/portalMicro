-- GiroMicro Market - Sprint 3B.1: catalogo operacional para busca de estoque.
-- Preserva EAN oficial no produto e expoe identificadores externos somente
-- como mappings, sem promover codigos nao-GTIN ao catalogo.
begin;

create or replace function public.market_get_stock_products(
    p_market_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then
        raise exception 'STOCK_AUTH_REQUIRED: usuario nao autenticado.';
    end if;

    if not exists (
        select 1
        from public.market_accounts a
        join public.market_account_members m
          on m.market_account_id = a.id
         and m.user_id = auth.uid()
         and m.status = 'active'
        where a.id = p_market_account_id
          and a.status in ('pilot','active')
    ) then
        raise exception 'STOCK_MEMBERSHIP_REQUIRED: conta indisponivel ou vinculo ativo nao encontrado.';
    end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'ean', p.ean,
            'sku', p.sku,
            'unit', p.unit,
            'externalEans', coalesce(identifiers.external_eans, '[]'::jsonb),
            'externalProductCodes', coalesce(identifiers.external_product_codes, '[]'::jsonb)
        ) order by p.name, p.id)
        from public.market_products p
        left join lateral (
            select
                coalesce(jsonb_agg(distinct btrim(m.external_ean))
                    filter (where nullif(btrim(m.external_ean), '') is not null), '[]'::jsonb) as external_eans,
                coalesce(jsonb_agg(distinct btrim(m.external_product_code))
                    filter (where nullif(btrim(m.external_product_code), '') is not null), '[]'::jsonb) as external_product_codes
            from public.market_product_mappings m
            where m.market_account_id = p.market_account_id
              and m.product_id = p.id
        ) identifiers on true
        where p.market_account_id = p_market_account_id
          and p.status = 'active'
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.market_get_stock_products(uuid) from public;
grant execute on function public.market_get_stock_products(uuid) to authenticated;

commit;
