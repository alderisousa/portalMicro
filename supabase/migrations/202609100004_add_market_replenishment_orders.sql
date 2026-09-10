-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: market_replenishment_orders
-- Data: 2026-09-10
--
-- Objetivo:
-- Criar o cabeçalho operacional da lista consolidada de reposição/compra.
-- A lista nasce a partir de um run efetivo do batch e evolui por revisão,
-- aprovação, compra, separação, despacho e conclusão.
--
-- Fluxo conceitual:
-- draft -> approved -> purchasing -> separating -> dispatched -> completed
--                  \-> separating -> dispatched -> completed
-- Qualquer lista não concluída pode ser cancelada por regra da aplicação.
--
-- Observação:
-- Nesta migration não é criada máquina de estados via trigger.
-- As transições válidas serão controladas por RPC/serviço da aplicação,
-- preservando flexibilidade e auditabilidade.

begin;

create table if not exists public.market_replenishment_orders (
    id uuid primary key default gen_random_uuid(),

    market_account_id uuid not null
        references public.market_accounts(id)
        on delete cascade,

    run_id uuid not null,

    status text not null default 'draft',

    created_at timestamptz not null default now(),
    created_by uuid null references auth.users(id) on delete set null,

    updated_at timestamptz not null default now(),
    updated_by uuid null references auth.users(id) on delete set null,

    approved_at timestamptz null,
    approved_by uuid null references auth.users(id) on delete set null,

    completed_at timestamptz null,
    completed_by uuid null references auth.users(id) on delete set null,

    cancelled_at timestamptz null,
    cancelled_by uuid null references auth.users(id) on delete set null,

    cancellation_reason text null,

    constraint market_replenishment_orders_status_check
        check (
            status in (
                'draft',
                'approved',
                'purchasing',
                'separating',
                'dispatched',
                'completed',
                'cancelled'
            )
        ),

    constraint market_replenishment_orders_approval_check
        check (
            (status = 'draft' and approved_at is null)
            or
            (status <> 'draft')
        ),

    constraint market_replenishment_orders_completed_check
        check (
            (status = 'completed' and completed_at is not null)
            or
            (status <> 'completed' and completed_at is null)
        ),

    constraint market_replenishment_orders_cancelled_check
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

    -- Necessário como alvo de FK composta a partir de
    -- market_replenishment_order_items.order_id.
    unique (id, market_account_id),

    -- Garante que o run pertence ao mesmo Market do registro (padrão de FK
    -- composta usado nas demais tabelas Market). on delete restrict é
    -- preservado: um run referenciado por uma lista operacional não pode
    -- ser removido isoladamente.
    foreign key (run_id, market_account_id)
        references public.market_replenishment_runs(id, market_account_id)
        on delete restrict
);

comment on table public.market_replenishment_orders is
'Cabeçalho operacional da lista consolidada de reposição/compra gerada a partir do batch de Reposição Inteligente.';

comment on column public.market_replenishment_orders.run_id is
'Run do batch que originou a lista operacional.';

comment on column public.market_replenishment_orders.status is
'Estado operacional da lista: draft, approved, purchasing, separating, dispatched, completed ou cancelled.';

comment on column public.market_replenishment_orders.approved_at is
'Momento em que o operador confirmou a lista e suas quantidades operacionais.';

comment on column public.market_replenishment_orders.completed_at is
'Momento de encerramento da lista após atendimento das alocações ativas.';

comment on column public.market_replenishment_orders.cancellation_reason is
'Motivo obrigatório quando a lista for cancelada.';

-- Histórico/consulta por Market.
create index if not exists idx_market_replenishment_orders_market_created
    on public.market_replenishment_orders (
        market_account_id,
        created_at desc
    );

-- Consulta rápida da lista relacionada a um run.
create index if not exists idx_market_replenishment_orders_run
    on public.market_replenishment_orders (
        run_id,
        status
    );

-- Evita mais de uma lista operacional ativa por run.
-- Uma lista cancelada pode ser recriada posteriormente a partir do mesmo run,
-- se a aplicação decidir permitir esse fluxo.
create unique index if not exists uq_market_replenishment_orders_active_run
    on public.market_replenishment_orders (run_id)
    where status <> 'cancelled';

alter table public.market_replenishment_orders enable row level security;

-- Somente leitura por enquanto: conforme o comentário no topo do arquivo, as
-- transições de estado (draft -> approved -> ... ) serão controladas por
-- RPC/serviço da aplicação, ainda não implementado. Isolamento por Market
-- reutilizando market_is_member.
create policy market_replenishment_orders_select
on public.market_replenishment_orders for select
to authenticated
using (public.market_is_member(market_account_id));

commit;
