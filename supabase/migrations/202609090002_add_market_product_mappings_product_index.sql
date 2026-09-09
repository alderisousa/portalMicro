-- Aplicação MANUAL. Correção pontual de performance: timeout (57014
-- "canceling statement due to statement timeout") ao clicar em "Continuar
-- inventário" em MarketStockDashboard.tsx.
--
-- Causa raiz (medida com EXPLAIN ANALYZE, ver .scratch/explain-stock-products.mjs):
-- resumeDraft() chama listActiveProducts() -> market_get_stock_products
-- (202609010003) para carregar o catálogo completo do estoque (não é
-- proporcional ao tamanho do rascunho — por isso a demora aparece mesmo com
-- poucos itens no draft). Essa RPC faz um LEFT JOIN LATERAL por produto
-- contra market_product_mappings, filtrando por
-- "m.market_account_id = p.market_account_id and m.product_id = p.id". O
-- único índice existente em market_product_mappings
-- (ix_market_product_mappings_lookup, 202608310001) começa por
-- (market_account_id, source_system, external_product_code, external_ean) —
-- não cobre product_id, então esse filtro nunca usa índice: cada produto do
-- catálogo dispara um Seq Scan completo da tabela de mappings (nested loop
-- O(produtos × mappings)). Com 4.000 produtos × 3 mappings (12.000 linhas —
-- volume pequeno perto de uma conta real), a consulta isolada já levava
-- ~12s (Seq Scan repetido 4.000 vezes); com o índice abaixo, ~170ms — a
-- mesma consulta, sem nenhuma mudança de RPC/contrato.
--
-- Fora do carrinho: market_get_inventory_draft (202609080005) já lê os
-- itens do rascunho por ix_market_inventory_session_items_session
-- (inventory_session_id, product_id) — filtra primeiro pela sessão (poucas
-- linhas), sem custo relevante mesmo em drafts grandes. Não é a origem do
-- timeout e não foi tocada.
--
-- Não altera nenhuma migration aplicada, nenhuma RPC, nenhuma regra de
-- concorrência/persistência item a item — só acrescenta o índice que faltava
-- para o join já existente.
begin;

create index if not exists ix_market_product_mappings_product
    on public.market_product_mappings (product_id, market_account_id);

comment on index public.ix_market_product_mappings_product is
  'Suporta o LEFT JOIN LATERAL de market_get_stock_products (202609010003) por product_id — sem isso, cada produto do catalogo forcava um Seq Scan completo de market_product_mappings (nested loop O(produtos x mappings), causa do timeout 57014 ao continuar inventario). Aditivo: nao substitui ix_market_product_mappings_lookup, que continua servindo a busca por source_system/external_product_code/external_ean.';

commit;
