begin;

-- Execucao real e imutavel de um abastecimento completo Galpao -> Loja.
-- Allocations e operation lines continuam sendo o planejamento/meta.
create table public.market_replenishment_supply_executions (
  id uuid primary key default gen_random_uuid(),
  market_account_id uuid not null,
  replenishment_order_id uuid not null,
  allocation_id uuid not null,
  warehouse_operation_line_id uuid not null,
  source_store_id uuid not null,
  destination_store_id uuid not null,
  product_id uuid not null,
  quantity numeric(18,4) not null check (quantity > 0 and quantity = trunc(quantity)),
  request_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (market_account_id, request_id),
  unique (id, market_account_id),
  foreign key (replenishment_order_id, market_account_id) references public.market_replenishment_orders(id, market_account_id) on delete restrict,
  foreign key (allocation_id, market_account_id) references public.market_replenishment_order_allocations(id, market_account_id) on delete restrict,
  foreign key (warehouse_operation_line_id, market_account_id, replenishment_order_id) references public.market_replenishment_operation_lines(id, market_account_id, order_id) on delete restrict,
  foreign key (source_store_id, market_account_id) references public.market_stores(id, market_account_id) on delete restrict,
  foreign key (destination_store_id, market_account_id) references public.market_stores(id, market_account_id) on delete restrict,
  foreign key (product_id, market_account_id) references public.market_products(id, market_account_id) on delete restrict,
  check (source_store_id <> destination_store_id)
);
create index on public.market_replenishment_supply_executions(market_account_id, allocation_id, created_at);
alter table public.market_replenishment_supply_executions enable row level security;
revoke all on public.market_replenishment_supply_executions from public,anon,authenticated;

create or replace function public.market_replenishment_supply_result(p_execution uuid,p_account uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'executionId', e.id, 'newWarehouseBalance', coalesce((select sum(case when m.direction='IN' then m.quantity else -m.quantity end) from public.market_stock_movements m where m.market_account_id=e.market_account_id and m.market_store_id=e.source_store_id and m.product_id=e.product_id),0),
    'executedQuantity', e.quantity, 'allocationId', e.allocation_id, 'confirmedQuantity', l.confirmed_quantity,
    'targetQuantity', l.target_quantity
  ) from public.market_replenishment_supply_executions e
  join public.market_replenishment_operation_lines l on l.id=e.warehouse_operation_line_id and l.market_account_id=e.market_account_id
  where e.id=p_execution and e.market_account_id=p_account;
$$;

create function public.market_get_replenishment_store_supply(
  p_market_account_id uuid,p_order_id uuid,p_store_id uuid
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  if not exists (select 1 from public.market_stores s where s.id=p_store_id and s.market_account_id=p_market_account_id and s.store_type='store' and public.market_can_access_store(s.id)) then raise exception 'REPLENISHMENT_STORE_INVALID'; end if;
  with warehouses as (
    select s.id,s.name from public.market_stores s where s.market_account_id=p_market_account_id and s.store_type='warehouse' and s.status='active' and public.market_can_access_store(s.id)
  ), rows as (
    select l.id line_id,l.allocation_id,i.product_id,pr.name product_name,s.id store_id,s.name store_name,l.target_quantity,l.confirmed_quantity,w.id source_store_id,w.name source_store_name,
      greatest(0,l.target_quantity-l.confirmed_quantity) remaining_quantity,
      greatest(0,coalesce((select sum(case when m.direction='IN' then m.quantity else -m.quantity end) from public.market_stock_movements m where m.market_account_id=p_market_account_id and m.market_store_id=w.id and m.product_id=i.product_id),0)) warehouse_balance,
      coalesce((select sum(e.quantity) from public.market_replenishment_supply_executions e where e.market_account_id=p_market_account_id and e.allocation_id=l.allocation_id and e.source_store_id=w.id),0) executed_quantity
    from public.market_replenishment_operation_lines l
    join public.market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    join public.market_products pr on pr.id=i.product_id and pr.market_account_id=i.market_account_id
    join public.market_stores s on s.id=a.store_id and s.market_account_id=a.market_account_id
    cross join warehouses w
    join public.market_replenishment_orders o on o.id=l.order_id and o.market_account_id=l.market_account_id and o.approval_revision=l.approval_revision
    where l.order_id=p_order_id and l.market_account_id=p_market_account_id and l.operation_type='warehouse' and s.id=p_store_id and o.status in ('approved','in_progress') and a.status<>'cancelled' and i.status<>'cancelled'
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',r.line_id||':'||r.source_store_id,'operationLineId',r.line_id,'allocationId',r.allocation_id,'productId',r.product_id,'productName',r.product_name,'storeId',r.store_id,'storeName',r.store_name,'sourceStoreId',r.source_store_id,'sourceStoreName',r.source_store_name,'targetQuantity',r.target_quantity,'confirmedQuantity',r.confirmed_quantity,'remainingQuantity',r.remaining_quantity,'warehouseBalance',r.warehouse_balance,'executedQuantity',r.executed_quantity,'suggestedQuantity',least(r.remaining_quantity,r.warehouse_balance)) order by r.product_name,r.source_store_name,r.line_id),'[]'::jsonb) into v_result from rows r;
  return v_result;
end;
$$;

create function public.market_execute_replenishment_store_supply(
  p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,p_warehouse_operation_line_id uuid,p_source_store_id uuid,p_quantity numeric,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order public.market_replenishment_orders; v_line public.market_replenishment_operation_lines; v_allocation public.market_replenishment_order_allocations; v_product uuid; v_destination uuid; v_balance numeric; v_execution public.market_replenishment_supply_executions; v_sum numeric; v_confirmed numeric;
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  if p_request_id is null then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_REQUIRED'; end if;
  if p_quantity is null or p_quantity<=0 or p_quantity<>trunc(p_quantity) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'REPLENISHMENT_SUPPLY_INVALID_QUANTITY'; end if;
  select * into v_execution from public.market_replenishment_supply_executions where market_account_id=p_market_account_id and request_id=p_request_id;
  if found then
    if v_execution.replenishment_order_id<>p_order_id or v_execution.allocation_id<>p_allocation_id or v_execution.warehouse_operation_line_id<>p_warehouse_operation_line_id or v_execution.source_store_id<>p_source_store_id or v_execution.quantity<>p_quantity then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_CONFLICT'; end if;
    return public.market_replenishment_supply_result(v_execution.id,p_market_account_id);
  end if;
  select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
  if not found or v_order.status not in ('approved','in_progress') then raise exception 'REPLENISHMENT_SUPPLY_ORDER_INVALID'; end if;
  select * into v_allocation from public.market_replenishment_order_allocations where id=p_allocation_id and market_account_id=p_market_account_id and store_id is not null for update;
  if not found then raise exception 'REPLENISHMENT_SUPPLY_ALLOCATION_INVALID'; end if;
  select * into v_line from public.market_replenishment_operation_lines where id=p_warehouse_operation_line_id and market_account_id=p_market_account_id and order_id=p_order_id and allocation_id=p_allocation_id and operation_type='warehouse' and approval_revision=v_order.approval_revision for update;
  if not found then raise exception 'REPLENISHMENT_SUPPLY_OPERATION_INVALID'; end if;
  select i.product_id,a.store_id into v_product,v_destination from public.market_replenishment_order_items i join public.market_replenishment_order_allocations a on a.order_item_id=i.id and a.market_account_id=i.market_account_id where a.id=p_allocation_id and i.market_account_id=p_market_account_id and i.order_id=p_order_id and a.status<>'cancelled' and i.status<>'cancelled';
  if not found or not exists(select 1 from public.market_stores s where s.id=v_destination and s.market_account_id=p_market_account_id and s.store_type='store' and public.market_can_access_store(s.id)) then raise exception 'REPLENISHMENT_SUPPLY_DESTINATION_INVALID'; end if;
  if not exists(select 1 from public.market_stores s where s.id=p_source_store_id and s.market_account_id=p_market_account_id and s.store_type='warehouse' and s.status='active' and public.market_can_access_store(s.id)) then raise exception 'REPLENISHMENT_SUPPLY_SOURCE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-supply:'||p_market_account_id::text||':'||p_source_store_id::text||':'||v_product::text,0));
  perform 1 from public.market_stores where id=p_source_store_id and market_account_id=p_market_account_id for update;
  select coalesce(sum(case when m.direction='IN' then m.quantity else -m.quantity end),0) into v_balance from public.market_stock_movements m where m.market_account_id=p_market_account_id and m.market_store_id=p_source_store_id and m.product_id=v_product;
  if p_quantity>greatest(v_balance,0) then raise exception 'REPLENISHMENT_SUPPLY_INSUFFICIENT_STOCK: saldo atual %',greatest(v_balance,0); end if;
  if v_order.status='approved' then
    update public.market_replenishment_orders set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now() where id=p_order_id;
  end if;
  insert into public.market_replenishment_supply_executions(market_account_id,replenishment_order_id,allocation_id,warehouse_operation_line_id,source_store_id,destination_store_id,product_id,quantity,request_id,created_by) values(p_market_account_id,p_order_id,p_allocation_id,p_warehouse_operation_line_id,p_source_store_id,v_destination,v_product,p_quantity,p_request_id,auth.uid()) returning * into v_execution;
  insert into public.market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id) values(p_market_account_id,p_source_store_id,v_product,'TRANSFER_OUT','OUT',p_quantity,'REPLENISHMENT_SUPPLY',v_execution.id,v_execution.id),(p_market_account_id,v_destination,v_product,'TRANSFER_IN','IN',p_quantity,'REPLENISHMENT_SUPPLY',v_execution.id,v_execution.id);
  select coalesce(sum(e.quantity),0) into v_sum from public.market_replenishment_supply_executions e where e.market_account_id=p_market_account_id and e.allocation_id=p_allocation_id;
  v_confirmed:=least(v_line.target_quantity,v_sum);
  update public.market_replenishment_operation_lines set started_at=coalesce(started_at,now()),started_by=coalesce(started_by,auth.uid()),confirmed_quantity=v_confirmed,completed_at=case when v_confirmed=v_line.target_quantity then now() else null end,completed_by=case when v_confirmed=v_line.target_quantity then auth.uid() else null end where id=v_line.id;
  insert into public.market_replenishment_order_events(market_account_id,order_id,event_type,approval_revision,operation_line_id,request_id,quantity_delta,metadata,actor_kind)
    values(p_market_account_id,p_order_id,'WAREHOUSE_QUANTITY_CONFIRMED',v_order.approval_revision,v_line.id,p_request_id,p_quantity,jsonb_build_object('executionId',v_execution.id),'service');
  return public.market_replenishment_supply_result(v_execution.id,p_market_account_id);
exception when unique_violation then
  select * into v_execution from public.market_replenishment_supply_executions where market_account_id=p_market_account_id and request_id=p_request_id;
  if found then return public.market_replenishment_supply_result(v_execution.id,p_market_account_id); end if;
  raise;
end;
$$;

revoke all on function public.market_get_replenishment_store_supply(uuid,uuid,uuid),public.market_execute_replenishment_store_supply(uuid,uuid,uuid,uuid,uuid,numeric,uuid) from public,anon;
grant execute on function public.market_get_replenishment_store_supply(uuid,uuid,uuid),public.market_execute_replenishment_store_supply(uuid,uuid,uuid,uuid,uuid,numeric,uuid) to authenticated;
commit;
