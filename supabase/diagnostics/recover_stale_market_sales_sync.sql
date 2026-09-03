-- Somente diagnóstico. Substitua o UUID após revisar o primeiro SELECT.
-- Este SELECT funciona também antes da migration 0004.
select id,market_account_id,integration_id,status,period_start,period_end,
       started_at,heartbeat_at,finished_at,
       coalesce(heartbeat_at,started_at) < clock_timestamp()-interval '30 minutes' as is_stale
from public.market_sales_sync_runs
where status='running'
order by started_at;

-- Requer a migration 0004. NÃO executar sem substituir e conferir o ID exato acima.
-- begin;
-- update public.market_sales_sync_runs
-- set status='failed',finished_at=clock_timestamp(),heartbeat_at=null,
--     error_code='STALE_RUN',error_message='Execucao stale encerrada manualmente apos diagnostico.'
-- where id='00000000-0000-0000-0000-000000000000'::uuid
--   and status='running'
--   and coalesce(heartbeat_at,started_at)<clock_timestamp()-public.market_sales_sync_stale_after()
-- returning id,market_account_id,integration_id,status,last_completed_day,next_day,finished_at,error_code;
-- commit;
