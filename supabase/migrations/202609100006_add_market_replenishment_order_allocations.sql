-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: market_replenishment_order_allocations
-- Data: 2026-09-10
--
-- Objetivo:
-- Registrar o rateio de cada produto consolidado da lista operacional entre as lojas.
-- Esta tabela preserva a origem da necessidade e acompanha a execução física:
-- sugestão -> ajuste -> alocação/separação -> despacho -> recebimento.
--
-- Conceito:
-- - candidate_id mantém rastreabilidade para o candidato do batch que originou a necessidade.
-- - suggested_quantity é a quantidade original sugerida para a loja.
-- - adjusted_quantity é a revisão humana antes da aprovação.
-- - allocated_quantity é a quantidade efetivamente reservada/separada para a loja.
-- - dispatched_quantity é a quantidade efetivamente enviada.
-- - received_quantity é a quantidade confirmada no recebimento da loja.
--
-- Observação:
-- O Galpão não aparece como destino nesta tabela. Ele é origem de disponibilidade
-- e destino de eventual excedente, tratado no item consolidado e nos movimentos de estoque.

begin;

create table if not exists public.market_replenishment_order_allocations (
    id uuid primary key default gen_random_uuid(),

    order_item_id uuid not null,

    market_account_id uuid not null
        references public.market_accounts(id)
        on delete cascade,

    store_id uuid not null,

    candidate_id uuid null,

    status text not null default 'pending',

    suggested_quantity numeric(18,4) not null default 0,

    -- NULL significa que o operador manteve a sugestão original.
    adjusted_quantity numeric(18,4) null,

    allocated_quantity numeric(18,4) not null default 0,

    dispatched_quantity numeric(18,4) not null default 0,

    received_quantity numeric(18,4) not null default 0,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),

    allocated_at timestamptz null,
    dispatched_at timestamptz null,
    received_at timestamptz null,
    cancelled_at timestamptz null,

    cancellation_reason text null,

    constraint market_replenishment_order_allocations_unique
        unique (order_item_id, store_id),

    constraint market_replenishment_order_allocations_status_check
        check (
            status in (
                'pending',
                'allocated',
                'dispatched',
                'received',
                'cancelled'
            )
        ),

    constraint market_replenishment_order_allocations_suggested_check
        check (suggested_quantity >= 0),

    constraint market_replenishment_order_allocations_adjusted_check
        check (
            adjusted_quantity is null
            or adjusted_quantity >= 0
        ),

    constraint market_replenishment_order_allocations_allocated_check
        check (allocated_quantity >= 0),

    constraint market_replenishment_order_allocations_dispatched_check
        check (dispatched_quantity >= 0),

    constraint market_replenishment_order_allocations_received_check
        check (received_quantity >= 0),

    constraint market_replenishment_order_allocations_received_not_over_dispatched_check
        check (received_quantity <= dispatched_quantity),

    constraint market_replenishment_order_allocations_dispatched_not_over_allocated_check
        check (dispatched_quantity <= allocated_quantity),

    constraint market_replenishment_order_allocations_allocated_status_check
        check (
            (status in ('allocated', 'dispatched', 'received') and allocated_at is not null)
            or
            (status in ('pending', 'cancelled'))
        ),

    constraint market_replenishment_order_allocations_dispatched_status_check
        check (
            (status in ('dispatched', 'received') and dispatched_at is not null)
            or
            (status in ('pending', 'allocated', 'cancelled'))
        ),

    constraint market_replenishment_order_allocations_received_status_check
        check (
            (status = 'received' and received_at is not null)
            or
            (status <> 'received' and received_at is null)
        ),

    constraint market_replenishment_order_allocations_cancelled_check
        check (
            (
                status = 'cancelled'
                and cancelled_at is not null
                and cancellation_reason is not null
                and btrim(cancellation_reason) <> ''
            )
            or
            (
                status <> 'cancelled'
                and cancelled_at is null
                and cancellation_reason is null
            )
        ),

    -- FKs compostas: garantem que o item consolidado, a loja e o candidato de
    -- origem pertencem ao mesmo Market do registro. candidate_id permanece
    -- nullable: a FK composta não é verificada quando candidate_id é NULL
    -- (MATCH SIMPLE), o que é aceitável pois market_account_id já é validado
    -- via order_item_id, que é not null.
    foreign key (order_item_id, market_account_id)
        references public.market_replenishment_order_items(id, market_account_id)
        on delete cascade,

    foreign key (store_id, market_account_id)
        references public.market_stores(id, market_account_id)
        on delete restrict,

    -- "on delete set null (candidate_id)" (sintaxe de coluna específica,
    -- disponível desde o PostgreSQL 15) limita o SET NULL à própria coluna.
    -- Sem a lista de colunas, o Postgres zeraria também market_account_id
    -- por ser parte da mesma FK composta, violando o not null da coluna.
    foreign key (candidate_id, market_account_id)
        references public.market_replenishment_candidates(id, market_account_id)
        on delete set null (candidate_id)
);

comment on table public.market_replenishment_order_allocations is
'Rateio por loja dos produtos consolidados de uma lista operacional de reposição.';

comment on column public.market_replenishment_order_allocations.candidate_id is
'Candidato do batch que originou a necessidade desta loja. Mantém rastreabilidade mesmo após criação da lista operacional.';

comment on column public.market_replenishment_order_allocations.suggested_quantity is
'Quantidade originalmente sugerida pelo batch para a loja.';

comment on column public.market_replenishment_order_allocations.adjusted_quantity is
'Quantidade revisada pelo operador. NULL indica manutenção explícita da sugestão original.';

comment on column public.market_replenishment_order_allocations.allocated_quantity is
'Quantidade efetivamente reservada/separada para atendimento da loja.';

comment on column public.market_replenishment_order_allocations.dispatched_quantity is
'Quantidade efetivamente despachada para a loja.';

comment on column public.market_replenishment_order_allocations.received_quantity is
'Quantidade confirmada como recebida pela loja.';

comment on column public.market_replenishment_order_allocations.status is
'Estado do atendimento da loja: pending, allocated, dispatched, received ou cancelled.';

-- Consulta das lojas/rateios de um produto consolidado.
create index if not exists idx_market_replenishment_allocations_order_item
    on public.market_replenishment_order_allocations (
        order_item_id,
        status,
        store_id
    );

-- Consulta operacional por loja.
create index if not exists idx_market_replenishment_allocations_store
    on public.market_replenishment_order_allocations (
        market_account_id,
        store_id,
        status,
        created_at desc
    );

-- Rastreabilidade candidato -> execução operacional.
create index if not exists idx_market_replenishment_allocations_candidate
    on public.market_replenishment_order_allocations (candidate_id)
    where candidate_id is not null;

alter table public.market_replenishment_order_allocations enable row level security;

-- Somente leitura por enquanto, mesma justificativa de
-- market_replenishment_orders. Isolamento por Market e por loja reutilizando
-- market_is_member/market_can_access_store.
create policy market_replenishment_order_allocations_select
on public.market_replenishment_order_allocations for select
to authenticated
using (
    public.market_is_member(market_account_id)
    and public.market_can_access_store(store_id)
);

commit;
