-- GiroMicro Market - Sprint 4C.2A (proposta nao aplicada): exclusao mutua
-- robusta para sincronizacoes de vendas por conta e integracao.
begin;

alter table public.market_sales_sync_runs
    add column heartbeat_at timestamptz null default now();

comment on column public.market_sales_sync_runs.heartbeat_at is
    'Ultimo sinal de atividade do backend. Runs running sem heartbeat recente podem ser recuperados apos 30 minutos.';

-- Nao escolhe arbitrariamente qual execucao preservar. Caso o banco ja esteja
-- em um estado ambiguo, a migration falha e exige saneamento manual auditavel.
do $$
begin
    if exists (
        select 1
        from public.market_sales_sync_runs
        where status = 'running'
        group by market_account_id, integration_id
        having count(*) > 1
    ) then
        raise exception 'SYNC_CONCURRENCY_MIGRATION_BLOCKED: existem runs running duplicados para conta e integracao.';
    end if;
end;
$$;

create unique index ux_market_sales_sync_runs_one_running
    on public.market_sales_sync_runs (market_account_id, integration_id)
    where status = 'running';

create function public.market_begin_sales_sync(
    p_market_account_id uuid,
    p_integration_id uuid,
    p_period_start date,
    p_period_end date,
    p_requested_by uuid
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_now timestamptz;
    v_stale_after constant interval := interval '30 minutes';
    v_running_id uuid;
    v_last_activity_at timestamptz;
    v_new_run_id uuid;
begin
    if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
        raise exception 'SYNC_INVALID_PERIOD: periodo de sincronizacao invalido.';
    end if;

    -- Serializa somente tentativas da mesma conta + integracao durante toda a
    -- transacao; pares distintos permanecem independentes.
    perform pg_advisory_xact_lock(hashtextextended(
        'market-sales-sync:' || p_market_account_id::text || ':' || p_integration_id::text,
        0
    ));
    v_now := clock_timestamp();

    if not exists (
        select 1
        from public.market_integrations i
        join public.market_accounts a
          on a.id = i.market_account_id
         and a.status in ('pilot','active')
        where i.id = p_integration_id
          and i.market_account_id = p_market_account_id
          and i.status = 'active'
    ) then
        raise exception 'SYNC_INTEGRATION_UNAVAILABLE: integracao inexistente, inativa ou pertencente a outra conta.';
    end if;

    select r.id, coalesce(r.heartbeat_at, r.started_at)
      into v_running_id, v_last_activity_at
    from public.market_sales_sync_runs r
    where r.market_account_id = p_market_account_id
      and r.integration_id = p_integration_id
      and r.status = 'running'
    for update;

    if found and v_last_activity_at > v_now - v_stale_after then
        raise exception 'SYNC_ALREADY_RUNNING: ja existe uma sincronizacao ativa para esta integracao.';
    end if;

    if found then
        update public.market_sales_sync_runs
        set status = 'failed',
            error_message = 'Execucao encerrada automaticamente por ausencia de heartbeat.',
            finished_at = v_now
        where id = v_running_id
          and market_account_id = p_market_account_id
          and status = 'running';
    end if;

    insert into public.market_sales_sync_runs (
        market_account_id, integration_id, period_start, period_end,
        status, requested_by, heartbeat_at
    ) values (
        p_market_account_id, p_integration_id, p_period_start, p_period_end,
        'running', p_requested_by, v_now
    )
    returning id into v_new_run_id;

    return v_new_run_id;
end;
$$;

revoke all on function public.market_begin_sales_sync(uuid,uuid,date,date,uuid)
    from public, anon, authenticated;
grant execute on function public.market_begin_sales_sync(uuid,uuid,date,date,uuid)
    to service_role;

comment on function public.market_begin_sales_sync(uuid,uuid,date,date,uuid) is
    'Adquire atomicamente um run de sync por conta e integracao. Rejeita run recente e substitui run sem heartbeat ha mais de 30 minutos, preservando sua auditoria.';

commit;
