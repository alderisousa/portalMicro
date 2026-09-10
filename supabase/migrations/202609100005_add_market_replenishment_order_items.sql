-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: market_replenishment_order_items
-- Data: 2026-09-10
--
-- Objetivo:
-- Representar cada produto consolidado dentro de uma lista operacional de reposição.
-- Uma linha agrupa a necessidade das lojas para o mesmo produto.
--
-- Conceito:
-- - total_suggested_quantity: soma das necessidades sugeridas das lojas.
-- - warehouse_stock_snapshot: saldo do Galpão no momento da criação da lista.
-- - suggested_purchase_quantity: quanto o sistema entende que precisa ser comprado
--   após considerar o saldo disponível no Galpão.
-- - adjusted_purchase_quantity: ajuste humano antes da compra.
-- - purchased_quantity: quantidade efetivamente comprada.
-- - warehouse_surplus_quantity: excedente efetivamente destinado ao Galpão.
--
-- Observação:
-- O rateio por loja não fica nesta tabela.
-- Ele será armazenado em market_replenishment_order_allocations.

begin;

create table if not exists public.market_replenishment_order_items (
    id uuid primary key default gen_random_uuid(),

    order_id uuid not null,

    market_account_id uuid not null
        references public.market_accounts(id)
        on delete cascade,

    product_id uuid not null,

    status text not null default 'pending',

    -- Necessidade consolidada das lojas, conforme sugestões do batch.
    total_suggested_quantity numeric(18,4) not null default 0,

    -- Estoque disponível no Galpão no momento da criação da lista.
    warehouse_stock_snapshot numeric(18,4) null,

    -- Quantidade que o algoritmo sugere comprar após considerar o Galpão.
    suggested_purchase_quantity numeric(18,4) not null default 0,

    -- Ajuste humano da quantidade de compra.
    -- NULL significa que o operador ainda não alterou a sugestão.
    adjusted_purchase_quantity numeric(18,4) null,

    -- Quantidade efetivamente comprada.
    purchased_quantity numeric(18,4) not null default 0,

    -- Excedente efetivamente destinado/permanecido no Galpão.
    -- Não representa simples projeção; deve ser preenchido conforme a execução real.
    warehouse_surplus_quantity numeric(18,4) not null default 0,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    constraint market_replenishment_order_items_unique
        unique (order_id, product_id),

    constraint market_replenishment_order_items_status_check
        check (
            status in (
                'pending',
                'partial',
                'fulfilled',
                'cancelled'
            )
        ),

    constraint market_replenishment_order_items_total_suggested_check
        check (total_suggested_quantity >= 0),

    constraint market_replenishment_order_items_warehouse_stock_check
        check (
            warehouse_stock_snapshot is null
            or warehouse_stock_snapshot >= 0
        ),

    constraint market_replenishment_order_items_suggested_purchase_check
        check (suggested_purchase_quantity >= 0),

    constraint market_replenishment_order_items_adjusted_purchase_check
        check (
            adjusted_purchase_quantity is null
            or adjusted_purchase_quantity >= 0
        ),

    constraint market_replenishment_order_items_purchased_check
        check (purchased_quantity >= 0),

    constraint market_replenishment_order_items_surplus_check
        check (warehouse_surplus_quantity >= 0),

    -- Necessário como alvo de FK composta a partir de
    -- market_replenishment_order_allocations.order_item_id.
    unique (id, market_account_id),

    -- FKs compostas: garantem que a lista e o produto pertencem ao mesmo
    -- Market do registro.
    foreign key (order_id, market_account_id)
        references public.market_replenishment_orders(id, market_account_id)
        on delete cascade,

    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
        on delete restrict
);

comment on table public.market_replenishment_order_items is
'Produtos consolidados de uma lista operacional de reposição/compra do GiroMicro Market.';

comment on column public.market_replenishment_order_items.total_suggested_quantity is
'Soma das quantidades sugeridas para as lojas participantes da lista.';

comment on column public.market_replenishment_order_items.warehouse_stock_snapshot is
'Saldo do Galpão/CD capturado no momento da criação da lista. NULL quando não houver Galpão aplicável.';

comment on column public.market_replenishment_order_items.suggested_purchase_quantity is
'Quantidade sugerida para compra após considerar a necessidade consolidada e o estoque disponível no Galpão.';

comment on column public.market_replenishment_order_items.adjusted_purchase_quantity is
'Quantidade de compra ajustada pelo operador. NULL indica que a sugestão original permanece sem alteração explícita.';

comment on column public.market_replenishment_order_items.purchased_quantity is
'Quantidade efetivamente adquirida no processo de compra.';

comment on column public.market_replenishment_order_items.warehouse_surplus_quantity is
'Quantidade excedente efetivamente destinada ou mantida no Galpão após o atendimento das lojas.';

comment on column public.market_replenishment_order_items.status is
'Estado consolidado do produto na lista: pending, partial, fulfilled ou cancelled.';

-- Consulta dos itens de uma lista operacional.
create index if not exists idx_market_replenishment_order_items_order
    on public.market_replenishment_order_items (
        order_id,
        status
    );

-- Consulta por produto ao longo das listas do Market.
create index if not exists idx_market_replenishment_order_items_product
    on public.market_replenishment_order_items (
        market_account_id,
        product_id,
        created_at desc
    );

alter table public.market_replenishment_order_items enable row level security;

-- Somente leitura por enquanto, mesma justificativa de
-- market_replenishment_orders. Isolamento por Market reutilizando
-- market_is_member.
create policy market_replenishment_order_items_select
on public.market_replenishment_order_items for select
to authenticated
using (public.market_is_member(market_account_id));

commit;
