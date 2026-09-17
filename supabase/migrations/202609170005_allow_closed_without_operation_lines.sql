-- GiroMicro Market
-- Migration 202609170005
-- Ajusta a consistencia de lifecycle para tratar CLOSED como estado terminal/historico.
--
-- Esta versao substitui a tentativa anterior da 005, que abortou antes de aplicar
-- qualquer alteracao por falha na propria validacao de formato.
--
-- Escopo: somente market_replenishment_lifecycle_consistency_internal().

begin;

do $migration$
declare
    v_def text;
    v_compact text;
begin
    select pg_get_functiondef(
        'public.market_replenishment_lifecycle_consistency_internal()'::regprocedure
    )
    into v_def;

    if v_def is null then
        raise exception 'REPLENISHMENT_LIFECYCLE_CONSISTENCY_NOT_FOUND';
    end if;

    -- Normaliza apenas para validar a forma publicada.
    v_compact := regexp_replace(v_def, '\s+', '', 'g');

    if position(
        'v_order.statusin(''draft'',''cancelled'')'
        in v_compact
    ) = 0 then
        raise exception 'REPLENISHMENT_LIFECYCLE_CONSISTENCY_UNEXPECTED';
    end if;

    -- Altera somente a condicao conhecida na funcao original.
    v_def := regexp_replace(
        v_def,
        'v_order\.status\s+in\s*\(\s*''draft''\s*,\s*''cancelled''\s*\)',
        'v_order.status in (''draft'',''cancelled'',''closed'')',
        'i'
    );

    -- Confirma que a substituicao realmente ocorreu antes do EXECUTE.
    if position(
        'v_order.statusin(''draft'',''cancelled'',''closed'')'
        in regexp_replace(v_def, '\s+', '', 'g')
    ) = 0 then
        raise exception 'REPLENISHMENT_LIFECYCLE_CONSISTENCY_PATCH_FAILED';
    end if;

    execute v_def;
end
$migration$;

comment on function public.market_replenishment_lifecycle_consistency_internal() is
'Valida consistencia operacional de ordens ativas/operacionais. DRAFT, CANCELLED e CLOSED nao exigem operation_lines; CLOSED pode representar inclusive um DRAFT substituido antes da aprovacao.';

commit;
