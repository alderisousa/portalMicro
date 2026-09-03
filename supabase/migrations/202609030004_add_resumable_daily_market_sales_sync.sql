-- GiroMicro Market: execução de vendas resumível, com checkpoint diário.
begin;

alter table public.market_sales_sync_runs
    add column source text not null default 'admin' check (source in ('admin','market','scheduled')),
    add column next_day date null,
    add column last_completed_day date null,
    add column total_days integer not null default 1,
    add column completed_days integer not null default 0,
    add column orders_unchanged integer not null default 0 check (orders_unchanged >= 0),
    add column error_code text null;

update public.market_sales_sync_runs
set total_days = period_end - period_start + 1,
    completed_days = case when status in ('completed','partial') then period_end - period_start + 1 else 0 end,
    last_completed_day = case when status in ('completed','partial') then period_end else null end,
    next_day = case when status in ('running','failed') then period_start else null end,
    heartbeat_at = case when status = 'running' then heartbeat_at else null end;

-- Runs legados nao possuíam checkpoint diario. Completed/partial representam o
-- periodo todo; failed/running retomam conservadoramente desde period_start.

alter table public.market_sales_sync_runs
    add constraint market_sales_sync_runs_daily_checkpoint_check check (
        total_days = period_end - period_start + 1
        and completed_days >= 0
        and completed_days <= total_days
        and (
            (completed_days = 0 and last_completed_day is null)
            or (completed_days > 0 and last_completed_day = period_start + completed_days - 1)
        )
        and (
            (status = 'running'
                and heartbeat_at is not null and finished_at is null
                and completed_days < total_days
                and next_day = period_start + completed_days)
            or (status in ('completed','partial')
                and heartbeat_at is null and finished_at is not null
                and completed_days = total_days
                and last_completed_day = period_end and next_day is null)
            or (status = 'failed'
                and heartbeat_at is null and finished_at is not null
                and (
                    (completed_days < total_days and next_day = period_start + completed_days)
                    or (completed_days = total_days and next_day is null)
                ))
        )
    );

create index ix_market_sales_sync_runs_resume
    on public.market_sales_sync_runs (market_account_id, integration_id, status, next_day)
    where status = 'running';

create or replace function public.market_sales_sync_stale_after()
returns interval language sql immutable set search_path = public
as $$ select interval '30 minutes' $$;

drop function public.market_begin_sales_sync(uuid,uuid,date,date,uuid);

create or replace function public.market_begin_sales_sync(
    p_market_account_id uuid,
    p_integration_id uuid,
    p_period_start date,
    p_period_end date,
    p_requested_by uuid,
    p_source text default 'admin'
)
returns uuid language plpgsql security invoker set search_path = public
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_running public.market_sales_sync_runs%rowtype;
    v_id uuid;
begin
    if p_period_start is null or p_period_end is null or p_period_start > p_period_end
       or p_period_end - p_period_start + 1 > 31
       or p_source is null or p_source not in ('admin','market','scheduled') then
        raise exception 'SYNC_INVALID_PERIOD';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(
        'market-sales-sync:' || p_market_account_id::text || ':' || p_integration_id::text, 0));
    if not exists (select 1 from public.market_integrations i join public.market_accounts a
      on a.id=i.market_account_id and a.status in ('pilot','active')
      where i.id=p_integration_id and i.market_account_id=p_market_account_id
        and i.provider='accesys' and i.status='active') then
      raise exception 'SYNC_INTEGRATION_UNAVAILABLE';
    end if;
    select * into v_running from public.market_sales_sync_runs
      where market_account_id=p_market_account_id and integration_id=p_integration_id and status='running'
      for update;
    if found and coalesce(v_running.heartbeat_at,v_running.started_at) > v_now-public.market_sales_sync_stale_after() then
      raise exception 'SYNC_ALREADY_RUNNING';
    elsif found then
      update public.market_sales_sync_runs set status='failed', finished_at=v_now, heartbeat_at=null,
        error_code='STALE_RUN', error_message='Execucao encerrada automaticamente por ausencia de heartbeat.'
      where id=v_running.id;
    end if;
    insert into public.market_sales_sync_runs (
      market_account_id,integration_id,period_start,period_end,status,source,requested_by,
      heartbeat_at,next_day,total_days,completed_days
    ) values (
      p_market_account_id,p_integration_id,p_period_start,p_period_end,'running',p_source,p_requested_by,
      v_now,p_period_start,p_period_end-p_period_start+1,0
    ) returning id into v_id;
    return v_id;
end;
$$;

create function public.market_apply_sales_sync_day(
    p_run_id uuid, p_market_account_id uuid, p_integration_id uuid,
    p_day date, p_pages_read integer, p_orders jsonb
)
returns jsonb language plpgsql security invoker set search_path = public
as $$
declare
    v_run public.market_sales_sync_runs%rowtype;
    v_entry jsonb; v_result jsonb; v_now timestamptz := clock_timestamp();
    v_read integer := 0; v_inserted integer := 0; v_updated integer := 0;
    v_items integer := 0; v_payments integer := 0; v_skipped integer := 0;
    v_code text; v_message text;
begin
    if p_day is null or p_pages_read < 1 or jsonb_typeof(p_orders) <> 'array' then
      raise exception 'SYNC_INVALID_DAY_PAYLOAD';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('market-sales-run:'||p_run_id::text,0));
    select * into v_run from public.market_sales_sync_runs where id=p_run_id
      and market_account_id=p_market_account_id and integration_id=p_integration_id for update;
    if not found or v_run.status<>'running' then raise exception 'SYNC_RUN_NOT_RUNNING'; end if;
    if v_run.next_day<>p_day then raise exception 'SYNC_UNEXPECTED_DAY'; end if;

    for v_entry in select value from jsonb_array_elements(p_orders) loop
      v_read := v_read + 1;
      if coalesce((v_entry->>'valid')::boolean,false)=false then
        v_skipped:=v_skipped+1;
        v_code:=coalesce(nullif(v_entry->>'errorCode',''),'ORDER_MAPPING_FAILED');
        v_message:=case when v_code='STORE_MAPPING_NOT_FOUND' then 'Loja externa sem mapeamento configurado.' else 'Pedido rejeitado durante a normalizacao.' end;
        insert into public.market_sales_sync_errors
          (market_account_id,sync_run_id,external_order_id,external_store_id,error_code,error_message)
        values (p_market_account_id,p_run_id,nullif(v_entry->>'externalOrderId',''),
          nullif(v_entry->>'externalStoreId',''),v_code,v_message);
        continue;
      end if;
      begin
        v_result:=public.market_upsert_external_sale(p_market_account_id,p_integration_id,
          (v_entry->>'storeExternalRefId')::uuid,v_entry->'sale',v_entry->'items',v_entry->'payments');
        if (v_result->>'inserted')::boolean then v_inserted:=v_inserted+1; else v_updated:=v_updated+1; end if;
        v_items:=v_items+(v_result->>'itemsProcessed')::integer;
        v_payments:=v_payments+(v_result->>'paymentsProcessed')::integer;
      exception when sqlstate 'P0001' then
        get stacked diagnostics v_message = message_text;
        -- market_upsert_external_sale usa P0001 tanto para rejeicoes funcionais
        -- explicitamente prefixadas quanto para falhas inesperadas. Somente os
        -- prefixos de dominio existentes sao isolados por venda; todo o resto e
        -- relancado para desfazer vendas e checkpoint deste dia.
        if v_message like 'SYNC_INVALID_PAYLOAD:%'
           or v_message like 'SYNC_INVALID_SALE:%'
           or v_message like 'SYNC_AMBIGUOUS_TIMEZONE:%'
           or v_message like 'SYNC_INVALID_ITEM:%'
           or v_message like 'SYNC_DUPLICATE_ITEM:%'
           or v_message like 'SYNC_INVALID_PAYMENT:%'
           or v_message like 'SYNC_DUPLICATE_PAYMENT:%'
           or v_message like 'SYNC_STORE_MAPPING_NOT_FOUND:%' then
          v_skipped:=v_skipped+1;
          insert into public.market_sales_sync_errors
            (market_account_id,sync_run_id,external_order_id,external_store_id,error_code,error_message)
          values (p_market_account_id,p_run_id,nullif(v_entry->>'externalOrderId',''),
            nullif(v_entry->>'externalStoreId',''),'SALE_VALIDATION_FAILED','Pedido rejeitado por validacao funcional durante a persistencia.');
        else
          raise;
        end if;
      end;
    end loop;

    update public.market_sales_sync_runs set
      pages_read=pages_read+p_pages_read,orders_read=orders_read+v_read,
      orders_inserted=orders_inserted+v_inserted,orders_updated=orders_updated+v_updated,
      items_processed=items_processed+v_items,payments_processed=payments_processed+v_payments,
      skipped_orders=skipped_orders+v_skipped,completed_days=completed_days+1,
      last_completed_day=p_day,next_day=case when p_day<period_end then p_day+1 else null end,
      status=case when p_day=period_end and skipped_orders+v_skipped>0 then 'partial'
                  when p_day=period_end then 'completed' else 'running' end,
      heartbeat_at=case when p_day=period_end then null else v_now end,
      finished_at=case when p_day=period_end then v_now else null end,
      error_code=null,error_message=null
    where id=p_run_id;
    return jsonb_build_object('day',p_day,'completed',true);
end;
$$;

create function public.market_resume_sales_sync(
  p_run_id uuid,p_market_account_id uuid,p_integration_id uuid
) returns date language plpgsql security invoker set search_path=public
as $$
declare v_run public.market_sales_sync_runs%rowtype; v_now timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'market-sales-sync:'||p_market_account_id::text||':'||p_integration_id::text,0));
  select * into v_run from public.market_sales_sync_runs where id=p_run_id
    and market_account_id=p_market_account_id and integration_id=p_integration_id for update;
  if not found or v_run.status not in ('running','failed') or v_run.next_day is null then raise exception 'SYNC_RUN_NOT_RESUMABLE'; end if;
  if v_run.status='failed' and exists (select 1 from public.market_sales_sync_runs r
    where r.market_account_id=p_market_account_id and r.integration_id=p_integration_id
      and r.status='running' and r.id<>p_run_id) then raise exception 'SYNC_ALREADY_RUNNING'; end if;
  update public.market_sales_sync_runs set status='running',heartbeat_at=v_now,finished_at=null,
    error_code=null,error_message=null where id=p_run_id;
  return v_run.next_day;
end;
$$;

create function public.market_reconcile_stale_sales_sync(p_market_account_id uuid)
returns void language plpgsql security invoker set search_path=public
as $$
declare v_run record;
begin
  for v_run in
    select id,integration_id from public.market_sales_sync_runs
    where market_account_id=p_market_account_id and status='running'
      and coalesce(heartbeat_at,started_at)<clock_timestamp()-public.market_sales_sync_stale_after()
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'market-sales-sync:'||p_market_account_id::text||':'||v_run.integration_id::text,0));
    update public.market_sales_sync_runs set status='failed',finished_at=clock_timestamp(),heartbeat_at=null,
      error_code='STALE_RUN',error_message='Execucao encerrada automaticamente por ausencia de heartbeat.'
    where id=v_run.id and market_account_id=p_market_account_id and integration_id=v_run.integration_id
      and status='running'
      and coalesce(heartbeat_at,started_at)<clock_timestamp()-public.market_sales_sync_stale_after();
  end loop;
end;
$$;

revoke all on function public.market_sales_sync_stale_after() from public,anon,authenticated;
revoke all on function public.market_begin_sales_sync(uuid,uuid,date,date,uuid,text) from public,anon,authenticated;
revoke all on function public.market_apply_sales_sync_day(uuid,uuid,uuid,date,integer,jsonb) from public,anon,authenticated;
revoke all on function public.market_resume_sales_sync(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.market_reconcile_stale_sales_sync(uuid) from public,anon,authenticated;
grant execute on function public.market_sales_sync_stale_after() to service_role;
grant execute on function public.market_begin_sales_sync(uuid,uuid,date,date,uuid,text) to service_role;
grant execute on function public.market_apply_sales_sync_day(uuid,uuid,uuid,date,integer,jsonb) to service_role;
grant execute on function public.market_resume_sales_sync(uuid,uuid,uuid) to service_role;
grant execute on function public.market_reconcile_stale_sales_sync(uuid) to service_role;

commit;
