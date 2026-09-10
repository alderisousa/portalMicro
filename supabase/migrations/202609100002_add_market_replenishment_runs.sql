-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: market_replenishment_runs
-- Data: 2026-09-10
--
-- Objetivo:
-- Registrar cada execução do batch de reposição sem materializar todos os produtos analisados.
-- O run mantém auditoria, versão do algoritmo, contadores consolidados e permite reprocessamento.
-- Apenas um run concluído pode ser marcado como efetivo por Market/data de referência.

begin;

create table if not exists public.market_replenishment_runs (
    id uuid primary key default gen_random_uuid(),

    market_account_id uuid not null
        references public.market_accounts(id)
        on delete cascade,

    reference_date date not null,

    algorithm_version text not null,

    status text not null default 'running',

    run_source text not null default 'scheduled',

    is_effective boolean not null default false,

    started_at timestamptz not null default now(),
    finished_at timestamptz null,

    stores_processed integer not null default 0,

    products_analyzed integer not null default 0,
    products_triggered integer not null default 0,
    products_selected integer not null default 0,
    triggered_over_limit_count integer not null default 0,

    critical_count integer not null default 0,
    high_count integer not null default 0,
    medium_count integer not null default 0,
    low_count integer not null default 0,

    error_code text null,
    error_message text null,

    created_at timestamptz not null default now(),

    constraint market_replenishment_runs_status_check
        check (status in ('running', 'completed', 'failed')),

    constraint market_replenishment_runs_source_check
        check (run_source in ('scheduled', 'manual')),

    constraint market_replenishment_runs_finished_at_check
        check (
            (status = 'running' and finished_at is null)
            or
            (status in ('completed', 'failed') and finished_at is not null)
        ),

    constraint market_replenishment_runs_effective_check
        check (
            is_effective = false
            or status = 'completed'
        ),

    constraint market_replenishment_runs_stores_processed_check
        check (stores_processed >= 0),

    constraint market_replenishment_runs_products_analyzed_check
        check (products_analyzed >= 0),

    constraint market_replenishment_runs_products_triggered_check
        check (products_triggered >= 0),

    constraint market_replenishment_runs_products_selected_check
        check (products_selected >= 0),

    constraint market_replenishment_runs_triggered_over_limit_check
        check (triggered_over_limit_count >= 0),

    constraint market_replenishment_runs_critical_count_check
        check (critical_count >= 0),

    constraint market_replenishment_runs_high_count_check
        check (high_count >= 0),

    constraint market_replenishment_runs_medium_count_check
        check (medium_count >= 0),

    constraint market_replenishment_runs_low_count_check
        check (low_count >= 0),

    constraint market_replenishment_runs_selected_distribution_check
        check (
            products_selected
            =
            critical_count + high_count + medium_count + low_count
        ),

    constraint market_replenishment_runs_triggered_selected_check
        check (products_triggered >= products_selected),

    constraint market_replenishment_runs_over_limit_consistency_check
        check (
            triggered_over_limit_count
            =
            products_triggered - products_selected
        ),

    -- Necessário como alvo de FK composta (id, market_account_id) a partir de
    -- market_replenishment_candidates e market_replenishment_orders, no
    -- mesmo padrão de market_stores/market_products/market_purchases.
    unique (id, market_account_id)
);

comment on table public.market_replenishment_runs is
'Cabeçalho/auditoria das execuções do batch de Reposição Inteligente do GiroMicro Market.';

comment on column public.market_replenishment_runs.reference_date is
'Data de referência utilizada pelo batch, normalmente associada às vendas consolidadas até D-1.';

comment on column public.market_replenishment_runs.algorithm_version is
'Versão da inteligência de reposição usada no cálculo, permitindo auditoria histórica.';

comment on column public.market_replenishment_runs.run_source is
'Origem da execução: scheduled para batch automático ou manual para reprocessamento explícito.';

comment on column public.market_replenishment_runs.is_effective is
'Indica qual execução concluída é a versão efetiva para o Market e a data de referência.';

comment on column public.market_replenishment_runs.products_analyzed is
'Quantidade total de combinações loja/produto efetivamente avaliadas pelo batch.';

comment on column public.market_replenishment_runs.products_triggered is
'Quantidade de produtos que dispararam ao menos uma regra de reposição.';

comment on column public.market_replenishment_runs.products_selected is
'Quantidade de candidatos persistidos após classificação, ranking e aplicação do teto operacional.';

comment on column public.market_replenishment_runs.triggered_over_limit_count is
'Quantidade de produtos relevantes que dispararam regras, mas ficaram fora do teto operacional persistido.';

-- Histórico e lookup do run efetivo.
create index if not exists idx_market_replenishment_runs_market_reference
    on public.market_replenishment_runs (
        market_account_id,
        reference_date desc,
        started_at desc
    );

create index if not exists idx_market_replenishment_runs_status
    on public.market_replenishment_runs (
        market_account_id,
        status,
        started_at desc
    );

-- Permite múltiplos reprocessamentos, mas somente um run efetivo
-- por Market/data de referência.
create unique index if not exists uq_market_replenishment_runs_effective
    on public.market_replenishment_runs (
        market_account_id,
        reference_date
    )
    where is_effective = true;

alter table public.market_replenishment_runs enable row level security;

-- Somente leitura por enquanto: o run é gerado pelo batch (RPC/serviço, a ser
-- implementado depois). Isolamento garantido por market_is_member, reutilizando
-- o helper existente; nenhuma policy de escrita direta é criada aqui para não
-- antecipar o modelo de autorização do batch/RPC.
create policy market_replenishment_runs_select
on public.market_replenishment_runs for select
to authenticated
using (public.market_is_member(market_account_id));

commit;
