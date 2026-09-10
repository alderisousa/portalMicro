-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: parâmetros globais por Market e overrides por loja
-- Data: 2026-09-10
--
-- Observação importante:
-- Esta migration cria a estrutura, constraints e índices da configuração.
-- As policies de RLS devem reutilizar exatamente o padrão de autorização já existente
-- no GiroMicro Market. Não são criadas aqui para evitar inventar helpers/policies.

begin;

create table if not exists public.market_replenishment_settings (
    id uuid primary key default gen_random_uuid(),

    market_account_id uuid not null
        references public.market_accounts(id) on delete cascade,

    -- NULL = configuração padrão do Market.
    -- Preenchido = override específico da loja.
    -- Mantido nullable: FK composta com market_stores(id, market_account_id)
    -- abaixo não é verificada quando store_id é NULL (MATCH SIMPLE), então a
    -- FK direta para market_accounts acima continua obrigatória para validar
    -- o registro padrão do Market.
    store_id uuid null,

    -- Limite exibido na lista operacional normal.
    -- O teto interno da lista completa (inicialmente 200) pertence ao algoritmo,
    -- não à parametrização da loja.
    normal_list_limit integer not null default 100,

    -- Meta de cobertura de estoque da loja, em dias.
    coverage_target_days numeric(6,2) not null default 7.00,

    -- Estratégia de cálculo da demanda diária de referência.
    -- weighted = combinação M7/M14/M30 usando os pesos abaixo.
    demand_method text not null default 'weighted',

    weight_m7 numeric(5,4) not null default 0.5000,
    weight_m14 numeric(5,4) not null default 0.3000,
    weight_m30 numeric(5,4) not null default 0.2000,

    -- Percentual acima da referência necessário para sinalizar aceleração.
    -- Ex.: 30.00 = 30%.
    acceleration_threshold_pct numeric(7,2) not null default 30.00,

    -- Produto essencial sem venda por esta quantidade de dias entra em avaliação
    -- específica para não ser tratado como "sem necessidade" apenas por ausência de giro.
    essential_no_sale_days integer not null default 7,

    is_active boolean not null default true,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    created_by uuid null references auth.users(id) on delete set null,
    updated_by uuid null references auth.users(id) on delete set null,

    constraint market_replenishment_settings_normal_list_limit_ck
        check (normal_list_limit > 0),

    constraint market_replenishment_settings_coverage_target_days_ck
        check (coverage_target_days > 0),

    constraint market_replenishment_settings_demand_method_ck
        check (demand_method in ('weighted', 'm7', 'm14', 'm30')),

    constraint market_replenishment_settings_weight_m7_ck
        check (weight_m7 >= 0 and weight_m7 <= 1),

    constraint market_replenishment_settings_weight_m14_ck
        check (weight_m14 >= 0 and weight_m14 <= 1),

    constraint market_replenishment_settings_weight_m30_ck
        check (weight_m30 >= 0 and weight_m30 <= 1),

    constraint market_replenishment_settings_weight_sum_ck
        check (
            demand_method <> 'weighted'
            or abs((weight_m7 + weight_m14 + weight_m30) - 1.0000) <= 0.0001
        ),

    constraint market_replenishment_settings_acceleration_threshold_ck
        check (acceleration_threshold_pct >= 0),

    constraint market_replenishment_settings_essential_no_sale_days_ck
        check (essential_no_sale_days > 0),

    -- Garante que a loja do override pertence ao mesmo Market do registro,
    -- seguindo o padrão de FK composta já usado em market_store_products,
    -- market_purchases etc. (market_stores possui unique (id, market_account_id)).
    foreign key (store_id, market_account_id)
        references public.market_stores(id, market_account_id) on delete cascade
);

-- Uma única configuração padrão por Market.
create unique index if not exists ux_market_replenishment_settings_market_default
    on public.market_replenishment_settings (market_account_id)
    where store_id is null;

-- Uma única configuração específica por Market + Loja.
create unique index if not exists ux_market_replenishment_settings_market_store
    on public.market_replenishment_settings (market_account_id, store_id)
    where store_id is not null;

-- Apoia busca dos overrides ativos por Market.
create index if not exists ix_market_replenishment_settings_market_active
    on public.market_replenishment_settings (market_account_id, is_active);

-- Apoia resolução rápida da configuração de uma loja.
create index if not exists ix_market_replenishment_settings_store
    on public.market_replenishment_settings (store_id)
    where store_id is not null;

comment on table public.market_replenishment_settings is
    'Parâmetros da Reposição Inteligente do GiroMicro Market. store_id NULL representa o padrão do Market; preenchido representa override por loja.';

comment on column public.market_replenishment_settings.normal_list_limit is
    'Quantidade máxima exibida na lista operacional normal da loja. O teto da lista completa pertence ao algoritmo.';

comment on column public.market_replenishment_settings.coverage_target_days is
    'Meta de cobertura de estoque em dias.';

comment on column public.market_replenishment_settings.demand_method is
    'Método da demanda diária de referência: weighted, m7, m14 ou m30.';

comment on column public.market_replenishment_settings.acceleration_threshold_pct is
    'Percentual mínimo de aceleração de vendas para disparar o sinal correspondente.';

comment on column public.market_replenishment_settings.essential_no_sale_days is
    'Quantidade de dias sem venda usada pela regra de produto essencial sem venda recente.';

-- A tabela participa do mesmo modelo RLS das demais tabelas Market,
-- reutilizando os helpers já existentes (market_is_member, market_has_role,
-- market_can_access_store) validados em 202608310001_create_market_multitenant_core.sql.
alter table public.market_replenishment_settings enable row level security;

create policy market_replenishment_settings_select
on public.market_replenishment_settings for select
to authenticated
using (
    public.market_is_member(market_account_id)
    and (store_id is null or public.market_can_access_store(store_id))
);

-- Configuração é administrativa, seguindo o mesmo alçada usada para
-- market_stores/market_external_store_mappings (owner/admin/manager).
create policy market_replenishment_settings_write
on public.market_replenishment_settings for all
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
    and (store_id is null or public.market_can_access_store(store_id))
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
    and (store_id is null or public.market_can_access_store(store_id))
);

commit;
