-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: corrige suggested_quantity para nullable
-- Data: 2026-09-10
--
-- Contexto:
-- 202609100003_add_market_replenishment_candidates.sql JÁ FOI APLICADA na
-- homologação e não pode mais ser editada (só pode ser corrigida por uma
-- migration nova, posterior). A homologação revelou que market_store_products
-- está vazia em todas as lojas e market_stock_balance ainda é parcial: quando
-- current_stock é desconhecido (sem histórico de estoque), suggested_quantity
-- não pode ser calculada sem inventar um número — precisa ficar NULL, não 0
-- nem qualquer valor "seguro" arbitrário. A coluna era NOT NULL default 0, o
-- que impede gravar essa ausência. Esta migration corrige apenas essa coluna.

begin;

alter table public.market_replenishment_candidates
    alter column suggested_quantity drop not null;

-- O check abaixo já tolerava NULL na prática (um CHECK só falha quando a
-- expressão avalia para FALSE; com operando NULL ela avalia para NULL, que
-- Postgres trata como "satisfaz a constraint"). Ainda assim é reescrito de
-- forma explícita para documentar a intenção e evitar ambiguidade para quem
-- ler o schema depois.
alter table public.market_replenishment_candidates
    drop constraint market_replenishment_candidates_suggested_quantity_check;

alter table public.market_replenishment_candidates
    add constraint market_replenishment_candidates_suggested_quantity_check
    check (suggested_quantity is null or suggested_quantity >= 0);

comment on column public.market_replenishment_candidates.suggested_quantity is
'Quantidade sugerida para reposição da loja. NULL quando current_stock é desconhecido (sem histórico de estoque): o batch nunca inventa uma sugestão física sem saldo conhecido, mesmo que alguma regra tenha disparado. Não representa quantidade ajustada, comprada, separada ou enviada.';

commit;
