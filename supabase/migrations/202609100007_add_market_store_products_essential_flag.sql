-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: flag de produto essencial por loja
-- Data: 2026-09-10
--
-- Contexto:
-- O batch de Reposição Inteligente (regras ESSENTIAL_BELOW_MINIMUM e
-- ESSENTIAL_NO_RECENT_SALES) depende de um indicador "produto essencial para
-- a loja", que ainda NÃO existe no schema real do GiroMicro Market (não há
-- nenhuma coluna/flag equivalente em market_products nem em
-- market_store_products). Esta migration adiciona apenas esse campo,
-- diretamente em market_store_products — a mesma tabela que já guarda
-- minimum_stock por loja/produto e já possui RLS/policies cobrindo todas as
-- suas colunas via "for all" — sem alterar nenhuma migration histórica.

begin;

alter table public.market_store_products
    add column if not exists is_essential boolean not null default false;

comment on column public.market_store_products.is_essential is
    'Indica se o produto é essencial para a loja (nunca deve faltar). Usado pela Reposição Inteligente (regras ESSENTIAL_BELOW_MINIMUM e ESSENTIAL_NO_RECENT_SALES) e disponível para qualquer outra funcionalidade que precise desse indicador.';

commit;
