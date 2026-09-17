-- GiroMicro Market
-- Reposicao Inteligente / Configuracoes da Reposicao
-- Migration: conecta normal_list_limit ao batch e protege faixas funcionais
-- Data: 2026-09-17
--
-- Escopo:
-- - migrations anteriores permanecem imutaveis;
-- - nenhum dado existente e ajustado silenciosamente;
-- - normal_list_limit passa a limitar a selecao normal por loja;
-- - candidatos critical podem furar o limite normal, respeitando teto absoluto 200;
-- - demais regras, scores, formulas e parametros internos permanecem inalterados.
--
-- Observacao de seguranca:
-- A migration altera a definicao ATUAL de market_run_replenishment_batch de forma
-- cirurgica. Se os dois pontos esperados do TOP 200 nao existirem, ela falha e
-- faz rollback em vez de substituir uma versao inesperada da funcao.

begin;

-- 1) Preflight dos dados atuais: nunca corrigir configuracao silenciosamente.
do $$
begin
    if exists (
        select 1
        from public.market_replenishment_settings
        where normal_list_limit not between 20 and 200
           or coverage_target_days not between 3 and 30
           or acceleration_threshold_pct not between 10 and 100
           or essential_no_sale_days not between 3 and 30
    ) then
        raise exception
            'REPLENISHMENT_SETTINGS_OUT_OF_SAFE_RANGE: existem configuracoes fora das novas faixas seguras; revise os dados antes de aplicar esta migration.';
    end if;
end
$$;

-- 2) Protecoes persistentes no banco.
alter table public.market_replenishment_settings
    drop constraint if exists market_replenishment_settings_normal_list_limit_ck,
    drop constraint if exists market_replenishment_settings_coverage_target_days_ck,
    drop constraint if exists market_replenishment_settings_acceleration_threshold_ck,
    drop constraint if exists market_replenishment_settings_essential_no_sale_days_ck;

alter table public.market_replenishment_settings
    add constraint market_replenishment_settings_normal_list_limit_ck
        check (normal_list_limit between 20 and 200),
    add constraint market_replenishment_settings_coverage_target_days_ck
        check (coverage_target_days between 3 and 30),
    add constraint market_replenishment_settings_acceleration_threshold_ck
        check (acceleration_threshold_pct between 10 and 100),
    add constraint market_replenishment_settings_essential_no_sale_days_ck
        check (essential_no_sale_days between 3 and 30);

-- 3) Conecta normal_list_limit ao batch.
--
-- Regra:
--   - rn <= normal_list_limit: selecao normal;
--   - critical fora do corte normal tambem entra;
--   - rn <= 200 continua sendo o teto tecnico absoluto;
--   - a mesma condicao e usada para persistencia e contadores do run.
do $migration$
declare
    v_function_def text;
    v_insert_marker constant text := 'where ts.rn <= 200;';
    v_count_marker constant text := 'where rn <= 200;';
    v_insert_replacement constant text :=
        'where ts.rn <= 200' || E'\n'
        || '              and (' || E'\n'
        || '                    ts.rn <= v_settings.normal_list_limit' || E'\n'
        || '                    or ts.priority_level = ''critical''' || E'\n'
        || '                  );';
    v_count_replacement constant text :=
        'where rn <= 200' || E'\n'
        || '              and (' || E'\n'
        || '                    rn <= v_settings.normal_list_limit' || E'\n'
        || '                    or priority_level = ''critical''' || E'\n'
        || '                  );';
begin
    select pg_get_functiondef(
        'public.market_run_replenishment_batch(uuid,date,text)'::regprocedure
    )
    into v_function_def;

    if v_function_def is null then
        raise exception
            'REPLENISHMENT_BATCH_NOT_FOUND: market_run_replenishment_batch(uuid,date,text) nao encontrada.';
    end if;

    -- Deve existir exatamente um ponto de persistencia e um ponto de contagem
    -- com o TOP 200 da versao homologada. Qualquer divergencia aborta a migration.
    if strpos(v_function_def, v_insert_marker) = 0
       or strpos(
            substr(
                v_function_def,
                strpos(v_function_def, v_insert_marker) + length(v_insert_marker)
            ),
            v_insert_marker
          ) > 0 then
        raise exception
            'REPLENISHMENT_BATCH_UNEXPECTED_SHAPE: marcador de persistencia TOP 200 ausente ou duplicado.';
    end if;

    if strpos(v_function_def, v_count_marker) = 0
       or strpos(
            substr(
                v_function_def,
                strpos(v_function_def, v_count_marker) + length(v_count_marker)
            ),
            v_count_marker
          ) > 0 then
        raise exception
            'REPLENISHMENT_BATCH_UNEXPECTED_SHAPE: marcador de contagem TOP 200 ausente ou duplicado.';
    end if;

    v_function_def := replace(
        v_function_def,
        v_insert_marker,
        v_insert_replacement
    );

    v_function_def := replace(
        v_function_def,
        v_count_marker,
        v_count_replacement
    );

    execute v_function_def;
end
$migration$;

comment on function public.market_run_replenishment_batch(uuid, date, text) is
'Executa o batch da Reposicao Inteligente para um Market/reference_date. A selecao normal respeita market_replenishment_settings.normal_list_limit (20..200); candidatos critical podem ultrapassar esse limite normal, mas o teto tecnico absoluto permanece 200 por loja. Demais regras e algoritmo v1 permanecem inalterados.';

commit;
