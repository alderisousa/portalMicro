-- Encerramento preserva fatos; snapshots e eventos usam a mesma transacao.
begin;

alter table public.market_replenishment_orders
 add column closed_at timestamptz,
 add column closed_by uuid references auth.users(id) on delete restrict,
 add column closure_reason text,
 add column closure_snapshot jsonb,
 drop constraint market_replenishment_orders_status_check,
 add constraint market_replenishment_orders_status_check check(status in ('draft','approved','in_progress','completed','cancelled','closed')),
 drop constraint market_replenishment_orders_started_check,
 add constraint market_replenishment_orders_started_check check(
   status='closed' or (status in ('draft','approved','cancelled') and started_at is null)
   or (status in ('in_progress','completed') and started_at is not null)),
 drop constraint market_replenishment_orders_completed_check,
 add constraint market_replenishment_orders_completed_check check(
   status='closed' or (status='completed' and completed_at is not null)
   or (status not in ('completed','closed') and completed_at is null)),
 add constraint market_replenishment_orders_closed_check check(
   (status='closed' and closed_at is not null and closed_by is not null
    and closure_snapshot is not null and jsonb_typeof(closure_snapshot)='object')
   or (status<>'closed' and closed_at is null and closed_by is null and closure_reason is null and closure_snapshot is null));

alter table public.market_replenishment_order_events
 drop constraint market_replenishment_order_events_from_status_check,
 drop constraint market_replenishment_order_events_to_status_check,
 add constraint market_replenishment_order_events_from_status_check check(from_status in ('draft','approved','in_progress','completed','cancelled','closed')),
 add constraint market_replenishment_order_events_to_status_check check(to_status in ('draft','approved','in_progress','completed','cancelled','closed')),
 drop constraint market_replenishment_order_events_event_type_check,
 add constraint market_replenishment_order_events_event_type_check check(event_type in (
 'ORDER_CREATED','ORDER_APPROVED','ORDER_REOPENED','ORDER_CANCELLED','ORDER_SUPERSEDED',
 'WAREHOUSE_SEPARATION_STARTED','WAREHOUSE_QUANTITY_CONFIRMED','WAREHOUSE_SEPARATION_COMPLETED',
 'PURCHASE_STARTED','PURCHASE_QUANTITY_CONFIRMED','PURCHASE_COMPLETED','ORDER_COMPLETED',
 'PURCHASE_DECLARATION_CHANGED','PURCHASE_NF_LINKED','PURCHASE_CORRECTED','SUPPLY_EXECUTED',
 'ORDER_STORE_RELEASED','ORDER_CLOSED','SUPPLY_BATCH_EXECUTED'));

-- Guards abrangem inclusive escritas internas/diretas. Conferem OLD e NEW
-- para impedir deslocar fatos de uma ordem fechada para outra ordem.
create function public.market_replenishment_guard_closed_internal()
returns trigger language plpgsql security definer set search_path=public as $$
declare j jsonb; v_order uuid; v_account uuid; v_status text;
begin
 for j in select x from unnest(array[
   case when tg_op<>'INSERT' then to_jsonb(old) end,
   case when tg_op<>'DELETE' then to_jsonb(new) end]) x where x is not null
 loop
  v_account:=(j->>'market_account_id')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||v_account::text,0));
  if tg_table_name='market_replenishment_orders' then v_order:=(j->>'id')::uuid;
  elsif tg_table_name='market_replenishment_order_allocations' then
   select order_id into v_order from market_replenishment_order_items where id=(j->>'order_item_id')::uuid and market_account_id=v_account;
  else v_order:=coalesce(j->>'order_id',j->>'replenishment_order_id')::uuid;
  end if;
  select status into v_status from market_replenishment_orders where id=v_order and market_account_id=v_account for update;
  if v_status='closed' then raise exception 'REPLENISHMENT_ORDER_CLOSED'; end if;
 end loop;
 if tg_op='DELETE' then return old; end if;
 return new;
end;
$$;

do $$ declare t text; begin
 foreach t in array array['market_replenishment_orders','market_replenishment_order_items',
 'market_replenishment_order_allocations','market_replenishment_operation_lines',
 'market_replenishment_purchase_declarations','market_replenishment_purchase_nf_links',
 'market_replenishment_receipt_allocations','market_replenishment_supply_executions',
 'market_replenishment_order_store_releases'] loop
  execute format('create trigger trg_00_replenishment_closed before insert or update or delete on public.%I for each row execute function public.market_replenishment_guard_closed_internal()',t);
 end loop;
end $$;

-- A fila homologada e a unica autoridade de ready_to_supply. Quantidades
-- desconhecidas permanecem NULL; contagens de categorias podem se sobrepor
-- quando uma allocation tem parcelas em diferentes etapas.
create function public.market_get_replenishment_closure_preview(p_market_account_id uuid,p_order_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o market_replenishment_orders; v_details jsonb; v_summary jsonb; v_reference date;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 select * into o from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id;
 if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
 if o.status='closed' then return o.closure_snapshot; end if;
 if o.status not in ('approved','in_progress') then raise exception 'REPLENISHMENT_CLOSURE_ORDER_INVALID'; end if;
 select reference_date into v_reference from market_replenishment_runs where id=o.run_id and market_account_id=p_market_account_id;
 with facts as (
  select n.*,p.name product_name,s.name store_name,
   coalesce(l.confirmed_quantity,0) purchased,
   coalesce((select sum(ra.quantity) from market_replenishment_receipt_allocations ra
    where ra.market_account_id=p_market_account_id and ra.allocation_id=n.allocation_id),0) received,
   coalesce(q.remaining,0) ready_quantity,q.source_store_id
  from market_replenishment_physical_needs_internal(p_market_account_id) n
  join market_products p on p.id=n.product_id and p.market_account_id=p_market_account_id
  join market_stores s on s.id=n.store_id and s.market_account_id=p_market_account_id
  left join market_replenishment_operation_lines l on l.allocation_id=n.allocation_id
   and l.approval_revision=n.revision and l.operation_type='purchase'
  left join market_replenishment_supply_queue_internal(p_market_account_id) q on q.allocation_id=n.allocation_id
  where n.order_id=p_order_id and (n.target is null or n.target>0)
 ), quantities as (
  select *,case when target is null then null else greatest(0,target-delivered) end pending,
   least(remaining,greatest(0,purchased-received)) awaiting from facts
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'allocationId',allocation_id,'productId',product_id,'productName',product_name,
  'storeId',store_id,'storeName',store_name,'targetQuantity',target,
  'deliveredQuantity',delivered,'remainingQuantity',pending,
  'purchasedQuantity',purchased,'receivedQuantity',received,
  'processedQuantity',delivered,'readyToSupplyQuantity',ready_quantity,
  'awaitingReceiptQuantity',awaiting,
  'stillToBuyQuantity',case when target is null then null else greatest(0,pending-ready_quantity-awaiting) end,
  'sourceStoreId',source_store_id,'quantityUnknown',target is null,
  'status',case when target is not null and pending=0 then 'processed' else 'pending' end
 ) order by product_name,store_name,allocation_id),'[]') into v_details from quantities;
 select jsonb_build_object('totalNeeds',count(*),
  'processed',count(*) filter(where x->>'status'='processed'),
  'readyToSupply',count(*) filter(where (x->>'readyToSupplyQuantity')::numeric>0),
  'awaitingReceipt',count(*) filter(where (x->>'awaitingReceiptQuantity')::numeric>0),
  'stillToBuy',count(*) filter(where (x->>'stillToBuyQuantity')::numeric>0 or (x->>'quantityUnknown')::boolean),
  'unknownQuantityNeeds',count(*) filter(where (x->>'quantityUnknown')::boolean),
  'processedUnits',coalesce(sum((x->>'processedQuantity')::numeric),0),
  'readyToSupplyUnits',coalesce(sum((x->>'readyToSupplyQuantity')::numeric),0),
  'awaitingReceiptUnits',coalesce(sum((x->>'awaitingReceiptQuantity')::numeric),0),
  'stillToBuyKnownUnits',coalesce(sum((x->>'stillToBuyQuantity')::numeric),0))
 into v_summary from jsonb_array_elements(v_details) x;
 return jsonb_build_object('schemaVersion',1,'orderId',o.id,'createdAt',o.created_at,
  'runId',o.run_id,'referenceDate',v_reference,'summary',v_summary,'needs',v_details,
  'purchases',market_get_replenishment_purchasing(p_market_account_id,p_order_id));
end;
$$;

create function public.market_close_replenishment_order(
 p_market_account_id uuid,p_order_id uuid,p_request_id uuid,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o market_replenishment_orders; v_snapshot jsonb; v_meta jsonb:=jsonb_build_object('reason',p_reason);
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
 select * into o from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
 if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
 if market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'ORDER_CLOSED',v_meta) then
  return o.closure_snapshot;
 end if;
 if o.status='closed' then return o.closure_snapshot; end if;
 if o.status not in ('approved','in_progress') then raise exception 'REPLENISHMENT_CLOSURE_ORDER_INVALID'; end if;
 -- Mesma ordem de serializacao dos fluxos de recebimento/abastecimento.
 perform 1 from market_stores where market_account_id=p_market_account_id and store_type='warehouse' order by id for update;
 v_snapshot:=market_get_replenishment_closure_preview(p_market_account_id,p_order_id)
  ||jsonb_build_object('closedAt',now(),'closedBy',auth.uid(),'closureReason',p_reason);
 perform market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_CLOSED',p_request_id,o.status,'closed',p_reason,null,v_meta);
 update market_replenishment_orders set status='closed',closed_at=now(),closed_by=auth.uid(),closure_reason=p_reason,
  closure_snapshot=v_snapshot,updated_at=now(),updated_by=auth.uid() where id=o.id;
 return v_snapshot;
end;
$$;

-- A operacao recebe o conjunto confirmado no preview. Qualquer mudanca na
-- fila aborta, inclusive desaparecimento de item por insuficiencia de saldo.
create function public.market_get_replenishment_supply_batch_preview(p_market_account_id uuid,p_order_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_items jsonb; v_stores jsonb;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 if not exists(select 1 from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id
  and status in ('approved','in_progress','completed')) then raise exception 'REPLENISHMENT_SUPPLY_ORDER_INVALID'; end if;
 v_items:=market_get_replenishment_store_supply(p_market_account_id,p_order_id,null);
 select coalesce(jsonb_agg(s),'[]') into v_stores from (
  select x->>'storeId' "storeId",x->>'storeName' "storeName",count(*) "allocationCount",
   sum((x->>'remainingQuantity')::numeric) "totalUnits"
  from jsonb_array_elements(v_items) x group by x->>'storeId',x->>'storeName' order by x->>'storeId'
 ) s;
 return jsonb_build_object('orderId',p_order_id,'items',v_items,'stores',v_stores,
  'storeCount',jsonb_array_length(v_stores),'allocationCount',jsonb_array_length(v_items),
  'productCount',(select count(distinct x->>'productId') from jsonb_array_elements(v_items) x),
  'totalUnits',(select coalesce(sum((x->>'remainingQuantity')::numeric),0) from jsonb_array_elements(v_items) x));
end;
$$;

create function public.market_execute_replenishment_supply_batch(
 p_market_account_id uuid,p_order_id uuid,p_items jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_current jsonb; v_expected jsonb; v_result jsonb:='[]'; v_item jsonb; e market_replenishment_order_events;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 if p_request_id is null then raise exception 'REPLENISHMENT_ORDER_REQUEST_REQUIRED'; end if;
 if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)=0 then raise exception 'REPLENISHMENT_SUPPLY_BATCH_INVALID_INPUT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
 select * into e from market_replenishment_order_events where market_account_id=p_market_account_id and request_id=p_request_id and request_ordinal=1;
 if found then
  if e.order_id<>p_order_id or e.event_type<>'SUPPLY_BATCH_EXECUTED' or e.actor_user_id is distinct from auth.uid()
   or e.metadata->'items' is distinct from p_items then raise exception 'REPLENISHMENT_ORDER_REQUEST_CONFLICT'; end if;
  return e.metadata->'result';
 end if;
 perform 1 from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
 perform 1 from market_stores where market_account_id=p_market_account_id and store_type='warehouse' order by id for update;
 v_current:=market_get_replenishment_supply_batch_preview(p_market_account_id,p_order_id)->'items';
 -- Comparacao de identidade/quantidade; nomes e saldos exibidos nao sao contrato.
 select jsonb_agg(jsonb_build_array(x->>'allocationId',x->>'operationLineId',x->>'sourceStoreId',x->'remainingQuantity') order by x->>'allocationId')
 into v_expected from jsonb_array_elements(p_items) x;
 if v_expected is distinct from (select jsonb_agg(jsonb_build_array(x->>'allocationId',x->>'operationLineId',x->>'sourceStoreId',x->'remainingQuantity') order by x->>'allocationId') from jsonb_array_elements(v_current) x)
 then raise exception 'REPLENISHMENT_SUPPLY_BATCH_CONFLICT: atualize o preview'; end if;
 -- A mesma ordem da projecao evita trocar o Galpao escolhido quando ha
 -- varias origens. A execucao individual continua permitindo qualquer ordem.
 for v_item in select j.value from jsonb_array_elements(v_current) j
  join market_replenishment_physical_needs_internal(p_market_account_id) n on n.allocation_id=(j.value->>'allocationId')::uuid
  order by n.product_id,n.born,n.order_id,n.allocation_id loop
  v_result:=v_result||jsonb_build_array(market_execute_replenishment_store_supply(p_market_account_id,p_order_id,
   (v_item->>'allocationId')::uuid,(v_item->>'operationLineId')::uuid,(v_item->>'sourceStoreId')::uuid,
   (v_item->>'remainingQuantity')::numeric,gen_random_uuid()));
 end loop;
 perform market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'SUPPLY_BATCH_EXECUTED',p_request_id,null,null,null,null,
  jsonb_build_object('items',p_items,'result',v_result));
 return v_result;
end;
$$;

create function public.market_replenishment_reliable_sales_date_internal(p_account uuid)
returns date language plpgsql stable set search_path=public as $$
declare v_integration uuid; v_count integer; v_date date;
begin
 select count(*),(array_agg(id order by id))[1] into v_count,v_integration
 from market_integrations where market_account_id=p_account and provider='accesys' and status='active';
 if v_count>1 then raise exception 'REPLENISHMENT_INTEGRATION_AMBIGUOUS'; end if;
 if v_count=1 then
  -- Cada dia e persistido atomicamente com seu checkpoint. Mesmo um run
  -- interrompido pode comprovar dias anteriores, mas nunca seu period_end.
  -- Runs com vendas rejeitadas nao comprovam consolidacao integral.
  select max(last_completed_day) into v_date from market_sales_sync_runs
  where market_account_id=p_account and integration_id=v_integration and status in ('completed','failed','running')
   and skipped_orders=0 and completed_days>0 and completed_days<=total_days
   and total_days=period_end-period_start+1 and last_completed_day=period_start+completed_days-1
   and (status<>'completed' or (finished_at is not null and completed_days=total_days))
   and last_completed_day<current_date;
 else
  -- Mesma fonte legada aceita pelo batch. O periodo declarado da importacao
  -- finalizada e a evidencia; a maior data de uma venda isolada nao prova
  -- que o dia foi consolidado. Importacoes sem periodo nao autorizam fechar.
  select max(period_end) into v_date from market_sales_imports
  where market_account_id=p_account and status in ('completed','completed_with_pending')
   and period_start is not null and period_end>=period_start and period_end<current_date;
 end if;
 if v_date is null then raise exception 'REPLENISHMENT_RELIABLE_SALES_DATE_UNAVAILABLE'; end if;
 return v_date;
end;
$$;

create function public.market_close_and_create_replenishment_order(
 p_market_account_id uuid,p_order_id uuid,p_request_id uuid,p_reason text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare o market_replenishment_orders; e market_replenishment_order_events;
 v_date date; v_run uuid; v_new uuid; v_result jsonb; v_snapshot jsonb; r market_replenishment_runs;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 if p_request_id is null then raise exception 'REPLENISHMENT_ORDER_REQUEST_REQUIRED'; end if;
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
 select * into e from market_replenishment_order_events where market_account_id=p_market_account_id and request_id=p_request_id and request_ordinal=1;
 if found then
  if e.order_id<>p_order_id or e.event_type<>'ORDER_CLOSED' or e.actor_user_id is distinct from auth.uid()
   or e.metadata->>'action' is distinct from 'close_and_create' or e.reason is distinct from p_reason
   then raise exception 'REPLENISHMENT_ORDER_REQUEST_CONFLICT'; end if;
  return e.metadata->'result';
 end if;
 select * into o from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
 if not found or o.status not in ('approved','in_progress') then raise exception 'REPLENISHMENT_CLOSURE_ORDER_INVALID'; end if;
 if exists(select 1 from market_replenishment_orders where market_account_id=p_market_account_id and id<>p_order_id
  and status in ('draft','approved','in_progress')) then raise exception 'REPLENISHMENT_ORDER_ACTIVE_CONFLICT'; end if;
 v_date:=market_replenishment_reliable_sales_date_internal(p_market_account_id);
 perform 1 from market_stores where market_account_id=p_market_account_id and store_type='warehouse' order by id for update;
 v_snapshot:=market_get_replenishment_closure_preview(p_market_account_id,p_order_id)
  ||jsonb_build_object('closedAt',now(),'closedBy',auth.uid(),'closureReason',p_reason);
 -- Batch homologado captura estoque atual e gera outro run, sem alterar formulas.
 v_run:=market_run_replenishment_batch(p_market_account_id,v_date,'manual');
 select * into r from market_replenishment_runs where id=v_run and market_account_id=p_market_account_id;
 if not found or r.status<>'completed' or not r.is_effective then raise exception 'REPLENISHMENT_FRESH_ANALYSIS_FAILED'; end if;
 -- Sem candidatos, preserva integralmente a ordem antiga. O erro de dominio
 -- desfaz tambem o run e sua promocao: nunca existe um fechamento pela metade.
 if not exists(select 1 from market_replenishment_candidates where run_id=v_run and market_account_id=p_market_account_id
  and priority_level in ('critical','high','medium')) then raise exception 'REPLENISHMENT_ORDER_NO_CANDIDATES'; end if;
 update market_replenishment_orders set status='closed',closed_at=now(),closed_by=auth.uid(),closure_reason=p_reason,
  closure_snapshot=v_snapshot,updated_at=now(),updated_by=auth.uid() where id=o.id;
 v_new:=market_materialize_replenishment_order_draft_internal(p_market_account_id,v_run);
 v_result:=jsonb_build_object('closedOrderId',p_order_id,'newRunId',v_run,'newOrderId',v_new,
  'referenceDate',v_date,'analysisTimestamp',r.started_at);
 perform market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_CLOSED',p_request_id,o.status,'closed',p_reason,v_new,
  jsonb_build_object('action','close_and_create','result',v_result));
 return v_result;
end;
$$;

-- Transicoes legadas mantidas; apenas closed foi acrescentado.
create or replace function public.market_replenishment_guard_order_internal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || new.market_account_id::text, 0));
    if tg_op='INSERT' then
        if new.status <> 'draft' or new.approval_revision <> 0 then raise exception 'REPLENISHMENT_ORDER_INVALID_TRANSITION'; end if;
        return new;
    end if;
    if (new.id,new.market_account_id,new.run_id) is distinct from (old.id,old.market_account_id,old.run_id) then
        raise exception 'REPLENISHMENT_ORDER_SOURCE_IMMUTABLE';
    end if;
    if old.started_at is not null and new.started_at is distinct from old.started_at then raise exception 'REPLENISHMENT_ORDER_START_IMMUTABLE'; end if;
    if new.approval_revision <> old.approval_revision and not (old.status='draft' and new.status='approved' and new.approval_revision=old.approval_revision+1) then
        raise exception 'REPLENISHMENT_ORDER_INVALID_REVISION';
    end if;
    if new.status <> old.status then
        if not ((old.status='draft' and new.status in ('approved','cancelled'))
            or (old.status='approved' and new.status in ('draft','in_progress','cancelled'))
            or (old.status in ('approved','in_progress') and new.status='closed')
            or (old.status='in_progress' and new.status='completed')
            or (old.status='completed' and new.status='in_progress' and public.market_replenishment_correction_internal(old.market_account_id,old.id,null,null))) then
            raise exception 'REPLENISHMENT_ORDER_INVALID_TRANSITION';
        end if;
        if new.status in ('draft','cancelled') and public.market_replenishment_has_started_internal(old.market_account_id,old.id) then
            raise exception 'REPLENISHMENT_ORDER_ALREADY_STARTED';
        end if;
        if new.status='approved' and new.approval_revision <> old.approval_revision+1 then raise exception 'REPLENISHMENT_ORDER_INVALID_REVISION'; end if;
    end if;
    return new;
end;
$$;

create or replace function public.market_generate_replenishment_order_draft(p_market_account_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
    v_order uuid;
    v_run uuid;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text, 0));

    select o.id into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.status in ('draft', 'approved', 'in_progress')
    order by o.created_at, o.id
    limit 1
    for update;
    if found then
        return v_order;
    end if;

    select r.id into v_run
    from public.market_replenishment_runs r
    where r.market_account_id = p_market_account_id
      and r.status = 'completed'
      and r.is_effective = true
    order by r.reference_date desc, r.started_at desc, r.id desc
    limit 1;
    if not found then
        raise exception 'REPLENISHMENT_ORDER_EFFECTIVE_RUN_NOT_FOUND';
    end if;

    select o.id into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.run_id = v_run
      and o.status <> 'cancelled'
    order by o.created_at, o.id
    limit 1
    for update;
    if found then
        if exists(select 1 from market_replenishment_orders where id=v_order and status='closed') then
            raise exception 'REPLENISHMENT_FRESH_ANALYSIS_REQUIRED';
        end if;
        return v_order;
    end if;

    return public.market_materialize_replenishment_order_draft_internal(p_market_account_id, v_run);
end;
$$;

-- Mantem o contrato legado integralmente e adiciona somente a leitura frozen.
alter function public.market_get_replenishment_order_history(uuid,uuid,uuid)
 rename to market_replenishment_order_history_legacy_internal;
revoke all on function public.market_replenishment_order_history_legacy_internal(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.market_get_replenishment_order_history(
 p_market_account_id uuid,p_order_id uuid default null,p_store_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_legacy jsonb; v_closed jsonb;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 v_legacy:=market_replenishment_order_history_legacy_internal(p_market_account_id,p_order_id,p_store_id);
 if p_order_id is not null then
  select coalesce(jsonb_agg(n||jsonb_build_object('orderStatus','closed','closedAt',o.closed_at,
   'closedBy',o.closed_by,'closureReason',o.closure_reason) order by n->>'productName',n->>'storeName',n->>'allocationId'),'[]')
  into v_closed from market_replenishment_orders o cross join lateral jsonb_array_elements(o.closure_snapshot->'needs') n
  where o.id=p_order_id and o.market_account_id=p_market_account_id and o.status='closed'
   and (p_store_id is null or (n->>'storeId')::uuid=p_store_id) and market_can_access_store((n->>'storeId')::uuid);
 else
  select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'status','closed','createdAt',o.created_at,
   'approvedAt',o.approved_at,'completedAt',o.completed_at,'closedAt',o.closed_at,'closedBy',o.closed_by,
   'closureReason',o.closure_reason,'referenceDate',o.closure_snapshot->'referenceDate',
   'totalItems',s.total,'processedItems',s.processed,'pendingItems',s.total-s.processed,
   'situation',case when s.total=s.processed then 'closed' else 'closed_with_pending' end)
   order by o.closed_at desc,o.id),'[]') into v_closed
  from market_replenishment_orders o join lateral (
   select count(*) total,count(*) filter(where n->>'status'='processed') processed
   from jsonb_array_elements(o.closure_snapshot->'needs') n
   where (p_store_id is null or (n->>'storeId')::uuid=p_store_id) and market_can_access_store((n->>'storeId')::uuid)
  ) s on s.total>0
  where o.market_account_id=p_market_account_id and o.status='closed';
 end if;
 return v_legacy||v_closed;
end;
$$;

-- Eventos continuam append-only; depois do encerramento so o proprio evento
-- final da transacao de fechamento pode ser anexado (close+create).
create or replace function public.market_replenishment_guard_event_internal()
returns trigger language plpgsql security definer set search_path=public as $$
declare o market_replenishment_orders;
begin
 if tg_op<>'INSERT' then raise exception 'REPLENISHMENT_EVENT_APPEND_ONLY'; end if;
 select * into o from market_replenishment_orders where id=new.order_id and market_account_id=new.market_account_id for update;
 if o.status='closed' and (new.event_type<>'ORDER_CLOSED' or o.closed_at is distinct from now()
  or o.closed_by is distinct from auth.uid() or exists(select 1 from market_replenishment_order_events where order_id=o.id and event_type='ORDER_CLOSED'))
 then raise exception 'REPLENISHMENT_ORDER_CLOSED'; end if;
 new.occurred_at:=now();new.actor_user_id:=auth.uid();new.actor_kind:=case when auth.uid() is null then 'service' else 'user' end;
 return new;
end;
$$;

revoke all on function public.market_replenishment_guard_closed_internal(),
 public.market_replenishment_reliable_sales_date_internal(uuid) from public,anon,authenticated,service_role;
revoke all on function public.market_get_replenishment_closure_preview(uuid,uuid),
 public.market_close_replenishment_order(uuid,uuid,uuid,text),
 public.market_close_and_create_replenishment_order(uuid,uuid,uuid,text),
 public.market_get_replenishment_supply_batch_preview(uuid,uuid),
 public.market_execute_replenishment_supply_batch(uuid,uuid,jsonb,uuid),
 public.market_get_replenishment_order_history(uuid,uuid,uuid) from public,anon,service_role;
grant execute on function public.market_get_replenishment_closure_preview(uuid,uuid),
 public.market_close_replenishment_order(uuid,uuid,uuid,text),
 public.market_close_and_create_replenishment_order(uuid,uuid,uuid,text),
 public.market_get_replenishment_supply_batch_preview(uuid,uuid),
 public.market_execute_replenishment_supply_batch(uuid,uuid,jsonb,uuid),
 public.market_get_replenishment_order_history(uuid,uuid,uuid) to authenticated;

commit;
