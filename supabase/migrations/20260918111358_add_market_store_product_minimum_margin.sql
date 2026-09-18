-- Parametro comercial por produto + loja. Nenhuma alteracao em RLS ou calculos.
begin;

alter table public.market_store_products
    add column minimum_margin_pct numeric(5,2) null
    constraint market_store_products_minimum_margin_pct_ck
    check (minimum_margin_pct between 0 and 100);

comment on column public.market_store_products.minimum_margin_pct is
    'Margem minima desejada em percentual por loja/produto. NULL = nao configurada. Meta cadastral; nao altera custo, preco de venda ou markup.';

commit;
