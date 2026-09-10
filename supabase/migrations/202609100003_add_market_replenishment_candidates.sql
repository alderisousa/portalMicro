-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: market_replenishment_candidates
-- Data: 2026-09-10
--
-- Objetivo:
-- Persistir somente os candidatos prioritários selecionados pelo batch de reposição.
-- A tabela guarda o snapshot necessário para explicar a sugestão daquele run,
-- sem materializar todos os produtos analisados.
--
-- Regras funcionais atualmente previstas:
--   STOCKOUT
--   ESSENTIAL_BELOW_MINIMUM
--   LOW_COVERAGE
--   SALES_ACCELERATION
--   ESSENTIAL_NO_RECENT_SALES
--
-- Observações:
-- - Galpão/warehouse não possui lista própria nesta V1.
-- - warehouse_stock representa apenas o saldo disponível no Galpão no momento do batch.
-- - Ajustes humanos, compra efetiva, separação, envio e recebimento pertencem
--   à futura entidade operacional da lista/reposição.

begin;

create table if not exists public.market_replenishment_candidates (
    id uuid primary key default gen_random_uuid(),

    run_id uuid not null,

    market_account_id uuid not null
        references public.market_accounts(id)
        on delete cascade,

    store_id uuid not null,

    product_id uuid not null,

    reference_date date not null,

    -- Snapshot de estoque/configuração no momento do batch.
    -- NULL = sem histórico de estoque (nenhuma linha em market_stock_balance
    -- para a loja/produto); nunca deve ser confundido com saldo conhecido
    -- igual a zero (Regra STOCKOUT). Corrigido para nullable durante a
    -- implementação do batch (202609100008): a coluna ainda não havia sido
    -- aplicada no Supabase.
    current_stock numeric(18,4) null,
    minimum_stock numeric(18,4) null,
    is_essential boolean not null default false,

    -- Médias diárias por janela.
    avg_daily_m7 numeric(18,6) null,
    avg_daily_m14 numeric(18,6) null,
    avg_daily_m30 numeric(18,6) null,

    -- Demanda de referência escolhida pelo método configurado da loja/Market.
    reference_daily_demand numeric(18,6) null,

    -- Cobertura estimada em dias.
    coverage_days numeric(18,4) null,

    -- Percentual de aceleração apurado pelo algoritmo.
    acceleration_pct numeric(12,4) null,

    -- Quantidade de dias desde a última venda conhecida.
    days_since_last_sale integer null,

    -- Motivos que fizeram o produto entrar entre os candidatos.
    trigger_reasons text[] not null default '{}'::text[],

    -- Priorização calculada pela versão do algoritmo registrada no run.
    priority_score integer not null,
    priority_level text not null,
    rank_position integer not null,

    -- Quantidade sugerida pela inteligência para esta loja.
    suggested_quantity numeric(18,4) not null default 0,

    -- Snapshot do saldo do Galpão/CD do Market, quando existente.
    -- NULL significa que não houve Galpão aplicável/identificado no cálculo.
    warehouse_stock numeric(18,4) null,

    calculated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),

    constraint market_replenishment_candidates_unique
        unique (run_id, store_id, product_id),

    constraint market_replenishment_candidates_priority_score_check
        check (priority_score >= 0),

    constraint market_replenishment_candidates_priority_level_check
        check (priority_level in ('critical', 'high', 'medium', 'low')),

    constraint market_replenishment_candidates_rank_position_check
        check (rank_position > 0),

    constraint market_replenishment_candidates_suggested_quantity_check
        check (suggested_quantity >= 0),

    constraint market_replenishment_candidates_minimum_stock_check
        check (minimum_stock is null or minimum_stock >= 0),

    constraint market_replenishment_candidates_avg_m7_check
        check (avg_daily_m7 is null or avg_daily_m7 >= 0),

    constraint market_replenishment_candidates_avg_m14_check
        check (avg_daily_m14 is null or avg_daily_m14 >= 0),

    constraint market_replenishment_candidates_avg_m30_check
        check (avg_daily_m30 is null or avg_daily_m30 >= 0),

    constraint market_replenishment_candidates_reference_demand_check
        check (
            reference_daily_demand is null
            or reference_daily_demand >= 0
        ),

    constraint market_replenishment_candidates_coverage_days_check
        check (
            coverage_days is null
            or coverage_days >= 0
        ),

    constraint market_replenishment_candidates_days_since_last_sale_check
        check (
            days_since_last_sale is null
            or days_since_last_sale >= 0
        ),

    constraint market_replenishment_candidates_trigger_reasons_check
        check (cardinality(trigger_reasons) > 0),

    constraint market_replenishment_candidates_trigger_reasons_values_check
        check (
            trigger_reasons <@ array[
                'STOCKOUT',
                'ESSENTIAL_BELOW_MINIMUM',
                'LOW_COVERAGE',
                'SALES_ACCELERATION',
                'ESSENTIAL_NO_RECENT_SALES'
            ]::text[]
        ),

    -- Necessário como alvo de FK composta a partir de
    -- market_replenishment_order_allocations.candidate_id.
    unique (id, market_account_id),

    -- FKs compostas: garantem que run/loja/produto pertencem ao mesmo Market
    -- do registro, no padrão já usado em market_purchase_items,
    -- market_transfer_items e market_sales_import_rows.
    foreign key (run_id, market_account_id)
        references public.market_replenishment_runs(id, market_account_id)
        on delete cascade,

    foreign key (store_id, market_account_id)
        references public.market_stores(id, market_account_id)
        on delete cascade,

    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
        on delete cascade
);

comment on table public.market_replenishment_candidates is
'Candidatos prioritários persistidos pelo batch de Reposição Inteligente. Guarda o snapshot necessário para explicar e ordenar a sugestão por loja.';

comment on column public.market_replenishment_candidates.run_id is
'Execução do batch que gerou o candidato.';

comment on column public.market_replenishment_candidates.reference_date is
'Data de referência do cálculo herdada conceitualmente do run.';

comment on column public.market_replenishment_candidates.current_stock is
'Saldo da loja no momento do batch, a partir de market_stock_balance. NULL = sem histórico de estoque (nenhum movimento registrado); zero é um saldo real conhecido. Nunca tratar NULL como zero.';

comment on column public.market_replenishment_candidates.minimum_stock is
'Estoque mínimo configurado para o produto naquela loja, quando aplicável.';

comment on column public.market_replenishment_candidates.is_essential is
'Snapshot do indicador de produto essencial para a loja.';

comment on column public.market_replenishment_candidates.reference_daily_demand is
'Demanda diária de referência calculada conforme demand_method e parâmetros efetivos da loja/Market.';

comment on column public.market_replenishment_candidates.trigger_reasons is
'Lista das regras funcionais disparadas para o produto naquele batch.';

comment on column public.market_replenishment_candidates.priority_score is
'Pontuação interna calculada pelo algoritmo versionado; usada para ordenação fina.';

comment on column public.market_replenishment_candidates.priority_level is
'Classificação operacional: critical, high, medium ou low.';

comment on column public.market_replenishment_candidates.rank_position is
'Posição final do candidato no ranking da loja para aquele run.';

comment on column public.market_replenishment_candidates.suggested_quantity is
'Quantidade sugerida para reposição da loja. Não representa quantidade ajustada, comprada, separada ou enviada.';

comment on column public.market_replenishment_candidates.warehouse_stock is
'Saldo do Galpão/CD do Market no momento do batch, usado como referência para consolidação e decisão de compra. O Galpão não recebe lista própria nesta V1.';

-- Lista normal/completa por loja:
-- o frontend/RPC consulta por Market + run + loja e ordena por rank_position.
create index if not exists idx_market_replenishment_candidates_store_rank
    on public.market_replenishment_candidates (
        market_account_id,
        run_id,
        store_id,
        rank_position
    );

-- Filtros por classificação/prioridade.
create index if not exists idx_market_replenishment_candidates_priority
    on public.market_replenishment_candidates (
        run_id,
        store_id,
        priority_level,
        rank_position
    );

-- Consolidação do Market:
-- permite agrupar rapidamente o mesmo produto entre várias lojas do mesmo run.
create index if not exists idx_market_replenishment_candidates_product
    on public.market_replenishment_candidates (
        run_id,
        product_id,
        store_id
    );

alter table public.market_replenishment_candidates enable row level security;

-- Somente leitura por enquanto (candidato é gerado pelo batch). Isolamento
-- por Market e por loja reutilizando market_is_member/market_can_access_store.
create policy market_replenishment_candidates_select
on public.market_replenishment_candidates for select
to authenticated
using (
    public.market_is_member(market_account_id)
    and public.market_can_access_store(store_id)
);

commit;
