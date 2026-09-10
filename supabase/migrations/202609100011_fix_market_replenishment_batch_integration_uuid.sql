-- GiroMicro Market
-- Reposição Inteligente / Lista de Compras
-- Migration: corrige erro de runtime em market_run_replenishment_batch
--            (min(uuid) nao existe)
-- Data: 2026-09-10
--
-- Contexto:
-- 202609100010_update_market_replenishment_batch_rpc.sql JÁ FOI APLICADA no
-- Supabase de homologação e é imutável a partir de agora. A execução real
-- falhou com:
--   ERROR 42883: function min(uuid) does not exist
-- no trecho:
--   select count(*), min(i.id)
--   from public.market_integrations i
--   where i.market_account_id = p_market_account_id
--     and i.provider = 'accesys'
--     and i.status = 'active';
--
-- Causa: PostgreSQL não possui agregado MIN/MAX embutido para o tipo uuid
-- (apenas para tipos numéricos, texto, datas/horas e alguns outros com
-- agregado registrado). market_integrations.id é uuid, então min(i.id) nunca
-- existiu como função válida — o batch nunca chegou a rodar de verdade.
--
-- Correção: troca de min(i.id) por (array_agg(i.id order by i.id))[1], que é
-- compatível com qualquer tipo (inclusive uuid) e não exige cast para texto.
-- Este é o MESMO padrão já usado no projeto para o mesmo problema, em
-- public.market_get_synced_commercial_dashboard
-- (202609030002_select_market_dashboard_sales_source.sql):
--   select count(*)::integer, (array_agg(i.id order by i.id))[1]
--   into v_active_integration_count, v_integration_id
--   from public.market_integrations i where ...
-- A regra de negócio (0 integrações -> fonte legada; 1 -> fonte sincronizada;
-- >1 -> REPLENISHMENT_INTEGRATION_AMBIGUOUS) e todo o restante da função são
-- idênticos à versão aplicada em 202609100010; nenhuma outra linha muda.

begin;

create or replace function public.market_run_replenishment_batch(
    p_market_account_id uuid,
    p_reference_date date,
    p_run_source text default 'manual'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_algorithm_version constant text := 'v1';
    v_sales_lookback_days_floor constant integer := 90;
    v_sales_lookback_days integer;
    v_max_essential_no_sale_days integer;

    v_run_id uuid;
    v_integration_count integer;
    v_integration_id uuid;
    v_use_synced boolean;

    v_store record;
    v_settings record;

    v_store_analyzed integer;
    v_store_triggered integer;
    v_store_selected integer;
    v_store_critical integer;
    v_store_high integer;
    v_store_medium integer;
    v_store_low integer;

    v_stores_processed integer := 0;
    v_products_analyzed integer := 0;
    v_products_triggered integer := 0;
    v_products_selected integer := 0;
    v_critical_count integer := 0;
    v_high_count integer := 0;
    v_medium_count integer := 0;
    v_low_count integer := 0;

    v_error_message text;
    v_error_code text;
begin
    if p_market_account_id is null or p_reference_date is null then
        raise exception 'REPLENISHMENT_INVALID_INPUT: market_account_id e reference_date sao obrigatorios.';
    end if;

    if p_reference_date > current_date then
        raise exception 'REPLENISHMENT_INVALID_INPUT: reference_date nao pode ser no futuro.';
    end if;

    if p_run_source is null or p_run_source not in ('scheduled', 'manual') then
        raise exception 'REPLENISHMENT_INVALID_RUN_SOURCE: run_source deve ser scheduled ou manual.';
    end if;

    -- Checagem explícita de autorização somente quando há um usuário autenticado
    -- (chamada feita através do app, com JWT). Um caller sem usuário autenticado
    -- só alcança esta função porque o EXECUTE foi concedido a service_role (ver
    -- grants em 202609100008) — ou seja, é um scheduler/serviço de confiança,
    -- e não deve ser bloqueado por uma checagem de papel que não faz sentido sem
    -- um auth.uid(). Isso satisfaz "nao quebrar execucao futura por
    -- scheduler/service role" sem abrir a checagem de papel para qualquer
    -- usuario autenticado que simplesmente informe run_source='scheduled'.
    if auth.uid() is not null then
        if p_run_source <> 'manual' then
            raise exception 'REPLENISHMENT_INVALID_RUN_SOURCE: usuarios autenticados devem executar com run_source = manual.';
        end if;
        if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
            raise exception 'REPLENISHMENT_PERMISSION_DENIED: perfil sem autorizacao para executar o batch de reposicao.';
        end if;
    end if;

    if not exists (
        select 1 from public.market_accounts a
        where a.id = p_market_account_id and a.status in ('pilot','active')
    ) then
        raise exception 'REPLENISHMENT_ACCOUNT_UNAVAILABLE: conta Market indisponivel.';
    end if;

    -- Serializa reprocessamentos concorrentes do mesmo Market/reference_date
    -- (mesmo padrao de market_begin_sales_sync, market_import_purchase_staging etc.).
    perform pg_advisory_xact_lock(hashtextextended(
        'market-replenishment-batch:' || p_market_account_id::text || ':' || p_reference_date::text, 0));

    -- Fonte comercial: mesma regra de selecao de market_get_commercial_dashboard.
    -- Mais de uma integracao Accesys ativa e uma ambiguidade explicita (nao
    -- escolhemos uma arbitrariamente). min(uuid) nao existe no Postgres; usa-se
    -- (array_agg(...order by...))[1], o mesmo padrao ja usado em
    -- market_get_synced_commercial_dashboard para o mesmo caso.
    select count(*), (array_agg(i.id order by i.id))[1]
    into v_integration_count, v_integration_id
    from public.market_integrations i
    where i.market_account_id = p_market_account_id
      and i.provider = 'accesys'
      and i.status = 'active';

    if v_integration_count > 1 then
        raise exception 'REPLENISHMENT_INTEGRATION_AMBIGUOUS: mais de uma integracao Accesys ativa para o Market.';
    end if;

    v_use_synced := v_integration_count = 1;

    insert into public.market_replenishment_runs (
        market_account_id, reference_date, algorithm_version, status, run_source, started_at
    ) values (
        p_market_account_id, p_reference_date, v_algorithm_version, 'running', p_run_source, now()
    )
    returning id into v_run_id;

    begin
        -- Lookback de vendas: no minimo greatest(90, maior essential_no_sale_days
        -- efetivo entre as lojas operacionais). Resolve override por loja quando
        -- existe, senao o padrao do Market (mesma precedencia usada no loop mais
        -- abaixo); lojas sem nenhuma configuracao ativa contribuem NULL aqui (sao
        -- ignoradas pelo max) e falham explicitamente mais adiante, no loop, com
        -- REPLENISHMENT_SETTINGS_MISSING — este pre-calculo nao substitui aquela
        -- validacao por loja. Isso garante que a janela consultada seja sempre
        -- suficiente para qualquer essential_no_sale_days configurado, tornando a
        -- regra ESSENTIAL_NO_RECENT_SALES exata (nunca um teto artificial).
        select max(coalesce(override.essential_no_sale_days, default_cfg.essential_no_sale_days))
        into v_max_essential_no_sale_days
        from public.market_stores s
        left join public.market_replenishment_settings override
          on override.market_account_id = p_market_account_id
         and override.store_id = s.id
         and override.is_active = true
        left join public.market_replenishment_settings default_cfg
          on default_cfg.market_account_id = p_market_account_id
         and default_cfg.store_id is null
         and default_cfg.is_active = true
        where s.market_account_id = p_market_account_id
          and s.status = 'active'
          and s.store_type = 'store';

        v_sales_lookback_days := greatest(v_sales_lookback_days_floor, coalesce(v_max_essential_no_sale_days, v_sales_lookback_days_floor));

        -- =========================================================
        -- Pre-computo, uma unica vez por run: vendas diarias (fonte resolvida
        -- acima) e saldo consolidado do(s) Galpao(oes), reaproveitados por
        -- todas as lojas do loop abaixo.
        -- =========================================================
        drop table if exists tmp_replenishment_sales;
        drop table if exists tmp_replenishment_warehouse_stock;

        if v_use_synced then
            create temporary table tmp_replenishment_sales on commit drop as
            select
                s.market_store_id as store_id,
                i.product_id as product_id,
                s.sold_at::date as sale_date,
                sum(i.quantity) as quantity
            from public.market_sales s
            join public.market_sale_items i
              on i.sale_id = s.id and i.market_account_id = s.market_account_id
            join public.market_stores st
              on st.id = s.market_store_id and st.market_account_id = s.market_account_id
            where s.market_account_id = p_market_account_id
              and s.source_type = 'api'
              and s.source_system = 'accesys'
              and s.integration_id = v_integration_id
              and st.store_type = 'store'
              and st.status = 'active'
              and i.product_id is not null
              and s.sold_at::date between p_reference_date - (v_sales_lookback_days - 1) and p_reference_date
            group by s.market_store_id, i.product_id, s.sold_at::date;
        else
            create temporary table tmp_replenishment_sales on commit drop as
            select
                r.market_store_id as store_id,
                r.product_id as product_id,
                r.sale_date::date as sale_date,
                sum(r.quantity) as quantity
            from public.market_sales_import_rows r
            join public.market_sales_imports imp
              on imp.id = r.import_id and imp.market_account_id = r.market_account_id
            join public.market_stores st
              on st.id = r.market_store_id and st.market_account_id = r.market_account_id
            where r.market_account_id = p_market_account_id
              and imp.status in ('completed', 'completed_with_pending')
              and st.store_type = 'store'
              and st.status = 'active'
              and r.product_id is not null
              and r.sale_date is not null
              and r.sale_date::date between p_reference_date - (v_sales_lookback_days - 1) and p_reference_date
            group by r.market_store_id, r.product_id, r.sale_date::date;
        end if;

        create temporary table tmp_replenishment_warehouse_stock on commit drop as
        select b.product_id, sum(b.quantity_on_hand) as warehouse_stock
        from public.market_stock_balance b
        join public.market_stores st
          on st.id = b.market_store_id and st.market_account_id = b.market_account_id
        where b.market_account_id = p_market_account_id
          and st.store_type = 'warehouse'
        group by b.product_id;

        -- =========================================================
        -- Loop por loja operacional (store_type = 'store', status = 'active').
        -- Galpao NAO entra neste loop: nunca recebe candidate.
        -- =========================================================
        for v_store in
            select s.id as store_id
            from public.market_stores s
            where s.market_account_id = p_market_account_id
              and s.status = 'active'
              and s.store_type = 'store'
            order by s.id
        loop
            v_stores_processed := v_stores_processed + 1;

            -- Configuracao efetiva: override da loja sobrescreve o padrao do
            -- Market; se a loja nao tiver override, usa o padrao; somente
            -- configuracoes ativas contam. Sem nenhuma das duas, falha
            -- explicita e rastreavel (nao ha ausencia silenciosa).
            select rs.* into v_settings
            from public.market_replenishment_settings rs
            where rs.market_account_id = p_market_account_id
              and rs.store_id = v_store.store_id
              and rs.is_active = true
            limit 1;

            if not found then
                select rs.* into v_settings
                from public.market_replenishment_settings rs
                where rs.market_account_id = p_market_account_id
                  and rs.store_id is null
                  and rs.is_active = true
                limit 1;
            end if;

            if not found then
                raise exception 'REPLENISHMENT_SETTINGS_MISSING: nenhuma configuracao ativa (override da loja % ou padrao do Market) foi encontrada.', v_store.store_id;
            end if;

            -- Universo de produtos da loja: produtos conhecidos/vendidos por ela,
            -- resolvidos via a mesma fonte de vendas ja usada para
            -- tmp_replenishment_sales (product_id ja vem mapeado por
            -- market_sale_items/market_sales_import_rows; nao ha resolucao de
            -- mapeamento nova aqui). market_store_products NAO e mais o universo
            -- obrigatorio: na homologacao ela esta vazia em todas as lojas, e
            -- depender dela faria o batch nunca analisar nenhum produto.
            select count(*)
            into v_store_analyzed
            from (
                select distinct ts.product_id
                from tmp_replenishment_sales ts
                where ts.store_id = v_store.store_id
            ) known
            join public.market_products p
              on p.id = known.product_id
             and p.market_account_id = p_market_account_id
             and p.status = 'active';

            drop table if exists tmp_store_scored;

            create temporary table tmp_store_scored on commit drop as
            with elig as (
                -- market_store_products passa a ser configuracao OPCIONAL por
                -- produto/loja (LEFT JOIN): ausencia de row nao exclui o produto
                -- da analise, apenas significa minimum_stock desconhecido (NULL,
                -- nao 0 — 0 seria uma afirmacao falsa de "minimo configurado e
                -- zero") e is_essential = false. Uma row inativa (status <>
                -- 'active') e tratada da mesma forma que ausencia de row.
                select
                    p.id as product_id,
                    sp.minimum_stock,
                    coalesce(sp.is_essential, false) as is_essential
                from (
                    select distinct ts.product_id
                    from tmp_replenishment_sales ts
                    where ts.store_id = v_store.store_id
                ) known
                join public.market_products p
                  on p.id = known.product_id
                 and p.market_account_id = p_market_account_id
                 and p.status = 'active'
                left join public.market_store_products sp
                  on sp.market_store_id = v_store.store_id
                 and sp.product_id = p.id
                 and sp.market_account_id = p_market_account_id
                 and sp.status = 'active'
            ),
            sales_agg as (
                select
                    ts.product_id,
                    -- greatest(0, ...) e defesa contra uma eventual linha com
                    -- quantity negativa (nao ha check >= 0 em
                    -- market_sales_import_rows.quantity): garante que
                    -- avg_daily_m7/m14/m30 nunca fique negativo, satisfazendo
                    -- sempre o check constraint da tabela de candidatos.
                    greatest(0, sum(ts.quantity) filter (where ts.sale_date >= p_reference_date - 6)) as sum_m7,
                    greatest(0, sum(ts.quantity) filter (where ts.sale_date >= p_reference_date - 13)) as sum_m14,
                    greatest(0, sum(ts.quantity) filter (where ts.sale_date >= p_reference_date - 29)) as sum_m30,
                    max(ts.sale_date) as last_sale_date
                from tmp_replenishment_sales ts
                where ts.store_id = v_store.store_id
                group by ts.product_id
            ),
            balance as (
                select b.product_id, b.quantity_on_hand
                from public.market_stock_balance b
                where b.market_account_id = p_market_account_id
                  and b.market_store_id = v_store.store_id
            ),
            computed as (
                select
                    e.product_id,
                    e.minimum_stock,
                    e.is_essential,
                    bal.quantity_on_hand as current_stock,
                    -- Saldo utilizavel para os CALCULOS operacionais (coverage_days,
                    -- suggested_quantity) apenas: nunca negativo. current_stock acima
                    -- permanece o saldo real, inclusive negativo, para o snapshot
                    -- persistido em market_replenishment_candidates.
                    greatest(coalesce(bal.quantity_on_hand, 0), 0) as usable_stock,
                    coalesce(sa.sum_m7, 0) / 7.0 as avg_daily_m7,
                    coalesce(sa.sum_m14, 0) / 14.0 as avg_daily_m14,
                    coalesce(sa.sum_m30, 0) / 30.0 as avg_daily_m30,
                    sa.last_sale_date,
                    case when sa.last_sale_date is null then null
                         else (p_reference_date - sa.last_sale_date) end as days_since_last_sale,
                    ws.warehouse_stock
                from elig e
                left join sales_agg sa on sa.product_id = e.product_id
                left join balance bal on bal.product_id = e.product_id
                left join tmp_replenishment_warehouse_stock ws on ws.product_id = e.product_id
            ),
            demand as (
                select
                    c.*,
                    case v_settings.demand_method
                        when 'm7' then c.avg_daily_m7
                        when 'm14' then c.avg_daily_m14
                        when 'm30' then c.avg_daily_m30
                        else
                            v_settings.weight_m7 * c.avg_daily_m7
                            + v_settings.weight_m14 * c.avg_daily_m14
                            + v_settings.weight_m30 * c.avg_daily_m30
                    end as reference_daily_demand
                from computed c
            ),
            scored as (
                select
                    d.*,
                    -- Gate por current_stock is not null preservado: sem historico de
                    -- estoque, coverage_days continua NULL (nao vira 0 por acaso do
                    -- clamp). Quando current_stock e conhecido (inclusive negativo),
                    -- usable_stock (nunca negativo) evita coverage_days negativo, que
                    -- violaria o check coverage_days >= 0 de market_replenishment_candidates.
                    case when d.reference_daily_demand > 0 and d.current_stock is not null
                         then d.usable_stock / d.reference_daily_demand
                         else null end as coverage_days,
                    case when d.avg_daily_m30 > 0
                         then ((d.avg_daily_m7 - d.avg_daily_m30) / d.avg_daily_m30) * 100
                         else null end as acceleration_pct
                from demand d
            ),
            flagged as (
                select
                    s.*,
                    (s.current_stock is not null and s.current_stock = 0) as f_stockout,
                    (
                        s.is_essential
                        and s.current_stock is not null
                        and s.minimum_stock is not null
                        and s.current_stock < s.minimum_stock
                    ) as f_essential_below_min,
                    (
                        s.coverage_days is not null
                        and s.coverage_days < v_settings.coverage_target_days
                    ) as f_low_coverage,
                    (
                        -- Evita tratar um pico isolado dentro da janela M7 como
                        -- tendencia: exige aceleracao acima do limiar efetivo E
                        -- corroboracao na janela intermediaria M14 (tambem acima
                        -- da referencia de longo prazo M30), aproveitando as tres
                        -- janelas em vez de decidir com uma unica media.
                        s.avg_daily_m30 > 0
                        and s.acceleration_pct is not null
                        and s.acceleration_pct >= v_settings.acceleration_threshold_pct
                        and s.avg_daily_m14 >= s.avg_daily_m30
                    ) as f_sales_acceleration,
                    (
                        s.is_essential
                        and (
                            s.days_since_last_sale is null
                            or s.days_since_last_sale >= v_settings.essential_no_sale_days
                        )
                    ) as f_essential_no_recent_sales
                from scored s
            ),
            reasoned as (
                select
                    f.*,
                    array_remove(array[
                        case when f.f_stockout then 'STOCKOUT' end,
                        case when f.f_essential_below_min then 'ESSENTIAL_BELOW_MINIMUM' end,
                        case when f.f_low_coverage then 'LOW_COVERAGE' end,
                        case when f.f_sales_acceleration then 'SALES_ACCELERATION' end,
                        case when f.f_essential_no_recent_sales then 'ESSENTIAL_NO_RECENT_SALES' end
                    ], null) as trigger_reasons
                from flagged f
            ),
            triggered as (
                select
                    r.*,
                    (
                        -- Pesos fixos do algoritmo (v1), nao configuraveis pelo cliente.
                        (case when r.f_stockout then 50 else 0 end)
                        + (case when r.f_essential_below_min then 35 else 0 end)
                        + (case when r.f_low_coverage then 25 else 0 end)
                        + (case when r.f_sales_acceleration then 20 else 0 end)
                        + (case when r.f_essential_no_recent_sales then 15 else 0 end)
                        -- Agravantes (+10 cada, simples e documentados):
                        -- saldo <= 50% do minimo; cobertura <= 50% da meta;
                        -- aceleracao >= 2x o limiar efetivo; mais de 2 regras.
                        + (case when r.current_stock is not null and r.minimum_stock is not null
                                     and r.minimum_stock > 0 and r.current_stock <= r.minimum_stock * 0.5
                                then 10 else 0 end)
                        + (case when r.coverage_days is not null
                                     and r.coverage_days <= v_settings.coverage_target_days * 0.5
                                then 10 else 0 end)
                        + (case when r.acceleration_pct is not null
                                     and r.acceleration_pct >= v_settings.acceleration_threshold_pct * 2
                                then 10 else 0 end)
                        + (case when cardinality(r.trigger_reasons) > 2 then 10 else 0 end)
                    ) as priority_score
                from reasoned r
                where cardinality(r.trigger_reasons) > 0
            ),
            leveled as (
                select
                    t.*,
                    case
                        when t.priority_score >= 70 then 'critical'
                        when t.priority_score >= 45 then 'high'
                        when t.priority_score >= 25 then 'medium'
                        else 'low'
                    end as priority_level,
                    -- Quantidade sugerida: cobre a meta de dias de cobertura usando a
                    -- demanda de referencia, sem nunca sugerir abaixo do minimo
                    -- configurado (quando aplicavel), e nunca negativa. Usa
                    -- usable_stock (saldo utilizavel, nunca negativo) em vez do
                    -- current_stock bruto: um saldo negativo real nao deve inflar a
                    -- sugestao alem do necessario para sair de "nada disponivel" ate
                    -- a meta. Quando current_stock e NULL (sem historico de estoque
                    -- conhecido), suggested_quantity fica NULL: nunca inventamos uma
                    -- sugestao fisica sem saldo conhecido, mesmo que alguma regra
                    -- (ex.: SALES_ACCELERATION ou ESSENTIAL_NO_RECENT_SALES) tenha
                    -- disparado. A coluna e nullable desde 202609100009.
                    case when t.current_stock is null then null
                         else greatest(
                             0,
                             greatest(
                                 v_settings.coverage_target_days * t.reference_daily_demand,
                                 coalesce(t.minimum_stock, 0)
                             ) - t.usable_stock
                         ) end as suggested_quantity
                from triggered t
            )
            select
                l.*,
                row_number() over (
                    order by
                        l.priority_score desc,
                        l.coverage_days asc nulls last,
                        l.current_stock asc nulls last,
                        l.product_id asc
                ) as rn
            from leveled l;

            select count(*) into v_store_triggered from tmp_store_scored;

            insert into public.market_replenishment_candidates (
                run_id, market_account_id, store_id, product_id, reference_date,
                current_stock, minimum_stock, is_essential,
                avg_daily_m7, avg_daily_m14, avg_daily_m30, reference_daily_demand,
                coverage_days, acceleration_pct, days_since_last_sale,
                trigger_reasons, priority_score, priority_level, rank_position,
                suggested_quantity, warehouse_stock
            )
            select
                v_run_id, p_market_account_id, v_store.store_id, ts.product_id, p_reference_date,
                ts.current_stock, ts.minimum_stock, ts.is_essential,
                ts.avg_daily_m7, ts.avg_daily_m14, ts.avg_daily_m30, ts.reference_daily_demand,
                ts.coverage_days, ts.acceleration_pct, ts.days_since_last_sale,
                ts.trigger_reasons, ts.priority_score, ts.priority_level, ts.rn,
                ts.suggested_quantity, ts.warehouse_stock
            from tmp_store_scored ts
            where ts.rn <= 200;

            get diagnostics v_store_selected = row_count;

            select
                count(*) filter (where priority_level = 'critical'),
                count(*) filter (where priority_level = 'high'),
                count(*) filter (where priority_level = 'medium'),
                count(*) filter (where priority_level = 'low')
            into v_store_critical, v_store_high, v_store_medium, v_store_low
            from tmp_store_scored
            where rn <= 200;

            drop table tmp_store_scored;

            v_products_analyzed := v_products_analyzed + v_store_analyzed;
            v_products_triggered := v_products_triggered + v_store_triggered;
            v_products_selected := v_products_selected + v_store_selected;
            v_critical_count := v_critical_count + coalesce(v_store_critical, 0);
            v_high_count := v_high_count + coalesce(v_store_high, 0);
            v_medium_count := v_medium_count + coalesce(v_store_medium, 0);
            v_low_count := v_low_count + coalesce(v_store_low, 0);
        end loop;

        update public.market_replenishment_runs
        set status = 'completed',
            finished_at = now(),
            stores_processed = v_stores_processed,
            products_analyzed = v_products_analyzed,
            products_triggered = v_products_triggered,
            products_selected = v_products_selected,
            triggered_over_limit_count = v_products_triggered - v_products_selected,
            critical_count = v_critical_count,
            high_count = v_high_count,
            medium_count = v_medium_count,
            low_count = v_low_count
        where id = v_run_id;

        -- Promove o novo run efetivo somente apos sucesso completo, desmarcando
        -- o anterior da mesma reference_date na mesma transacao (nunca ha dois
        -- runs efetivos simultaneos: primeiro desmarca, depois marca).
        update public.market_replenishment_runs
        set is_effective = false
        where market_account_id = p_market_account_id
          and reference_date = p_reference_date
          and is_effective = true
          and id <> v_run_id;

        update public.market_replenishment_runs
        set is_effective = true
        where id = v_run_id;

    exception
        when others then
            v_error_message := sqlerrm;
            v_error_code := coalesce(nullif(btrim(split_part(v_error_message, ':', 1)), ''), 'REPLENISHMENT_UNKNOWN_ERROR');

            -- Nao propaga o erro: um RAISE aqui reverteria, junto com o resto
            -- da transacao, o proprio registro de falha que estamos gravando
            -- agora. O contrato desta funcao e: erros de processamento viram
            -- run.status = 'failed' com error_code/error_message rastreaveis,
            -- e a funcao retorna normalmente o id do run.
            update public.market_replenishment_runs
            set status = 'failed',
                finished_at = now(),
                error_code = v_error_code,
                error_message = v_error_message
            where id = v_run_id;
    end;

    return v_run_id;
end;
$$;

comment on function public.market_run_replenishment_batch(uuid, date, text) is
'Executa o batch da Reposicao Inteligente para um Market/reference_date: analisa lojas operacionais e produtos conhecidos/vendidos por elas (via tmp_replenishment_sales; market_store_products e configuracao opcional), calcula as 5 regras funcionais, persiste o TOP 200 por loja em market_replenishment_candidates e promove o run concluido a is_effective. suggested_quantity fica NULL quando current_stock e desconhecido. algorithm_version fixa em v1.';

commit;
