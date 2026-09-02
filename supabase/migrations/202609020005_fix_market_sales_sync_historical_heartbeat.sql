-- GiroMicro Market - Sprint 4C.2A: corrige exclusivamente heartbeats
-- historicos artificiais criados pelo DEFAULT da migration 004.
begin;

update public.market_sales_sync_runs
set heartbeat_at = null
where finished_at is not null
  and heartbeat_at is not null
  and heartbeat_at > finished_at;

-- Heartbeat representa atividade real. Novos runs sao inicializados
-- explicitamente por public.market_begin_sales_sync.
alter table public.market_sales_sync_runs
    alter column heartbeat_at drop default;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.market_sales_sync_runs'::regclass
          and conname = 'market_sales_sync_runs_running_heartbeat_check'
    ) then
        alter table public.market_sales_sync_runs
            add constraint market_sales_sync_runs_running_heartbeat_check
            check (status <> 'running' or heartbeat_at is not null);
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid = 'public.market_sales_sync_runs'::regclass
          and conname = 'market_sales_sync_runs_finished_heartbeat_check'
    ) then
        alter table public.market_sales_sync_runs
            add constraint market_sales_sync_runs_finished_heartbeat_check
            check (finished_at is null or heartbeat_at is null or finished_at >= heartbeat_at);
    end if;
end;
$$;

commit;
