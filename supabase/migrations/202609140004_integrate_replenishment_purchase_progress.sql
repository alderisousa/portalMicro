-- Aplicacao manual. Aquisicao confirma purchase; NF/estoque permanecem separados.
-- Nao reprocessa dados existentes: reenviar a declaracao pela RPC com versao atual
-- e um novo request_id aplica somente o progresso ainda nao confirmado.
begin;

create or replace function public.market_set_replenishment_purchased(
  p_market_account_id uuid,p_order_id uuid,p_changes jsonb,p_request_id uuid
) returns void language plpgsql security definer set search_path=public as $$
declare
  v_order public.market_replenishment_orders;
  v_declaration public.market_replenishment_purchase_declarations;
  v_line public.market_replenishment_operation_lines;
  v_change jsonb;
  v_quantity numeric;
  v_confirmed numeric;
  v_remaining numeric;
  v_delta numeric;
  v_ordinal integer := 1;
  v_metadata jsonb := jsonb_build_object('changes',p_changes);
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
  select * into v_order from public.market_replenishment_orders
    where id=p_order_id and market_account_id=p_market_account_id for update;
  if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
  -- Replay precede o guard de status, inclusive quando a chamada concluiu a ordem.
  if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'PURCHASE_DECLARATION_CHANGED',v_metadata) then return; end if;
  if v_order.status not in ('approved','in_progress') then raise exception 'REPLENISHMENT_PURCHASE_NOT_APPROVED'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 500 then raise exception 'REPLENISHMENT_PURCHASE_INVALID_INPUT'; end if;
  if (select count(*)<>count(distinct value->>'declarationId') from jsonb_array_elements(p_changes)) then raise exception 'REPLENISHMENT_PURCHASE_INVALID_INPUT'; end if;

  -- Ordinal 1 continua sendo a ancora do replay. Falhas revertem todos os eventos.
  perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_DECLARATION_CHANGED',p_request_id,null,null,null,null,v_metadata,1);
  for v_change in select value from jsonb_array_elements(p_changes) loop
    select * into v_declaration from public.market_replenishment_purchase_declarations
      where id=(v_change->>'declarationId')::uuid and market_account_id=p_market_account_id
        and order_id=p_order_id and approval_revision=v_order.approval_revision for update;
    if not found then raise exception 'REPLENISHMENT_PURCHASE_DECLARATION_NOT_FOUND'; end if;
    if (v_change->>'version')::integer is distinct from v_declaration.purchase_version then raise exception 'REPLENISHMENT_PURCHASE_VERSION_CONFLICT'; end if;
    -- Preserva o bloqueio documental; progresso positivo sozinho nao bloqueia complemento.
    if exists (select 1 from public.market_replenishment_purchase_nf_links where purchase_declaration_id=v_declaration.id) then raise exception 'REPLENISHMENT_PURCHASE_NF_LOCKED'; end if;
    if not (v_change ? 'quantity') or jsonb_typeof(v_change->'quantity') not in ('number','null') then raise exception 'REPLENISHMENT_PURCHASE_INVALID_QUANTITY'; end if;
    v_quantity := (v_change->>'quantity')::numeric;
    if v_quantity is not null and (v_quantity<=0 or v_quantity<>trunc(v_quantity) or v_quantity::text in ('NaN','Infinity','-Infinity') or v_quantity>=100000000000000) then raise exception 'REPLENISHMENT_PURCHASE_INVALID_QUANTITY'; end if;

    perform l.id from public.market_replenishment_operation_lines l
      join public.market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id
      join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
      where l.order_id=p_order_id and l.market_account_id=p_market_account_id
        and l.approval_revision=v_order.approval_revision and l.operation_type='purchase'
        and i.product_id=v_declaration.product_id order by l.id for update of l;
    if not found then raise exception 'REPLENISHMENT_PURCHASE_OPERATION_NOT_FOUND'; end if;
    select coalesce(sum(l.confirmed_quantity),0) into v_confirmed
      from public.market_replenishment_operation_lines l
      join public.market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id
      join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
      where l.order_id=p_order_id and l.market_account_id=p_market_account_id
        and l.approval_revision=v_order.approval_revision and l.operation_type='purchase'
        and i.product_id=v_declaration.product_id;
    if coalesce(v_quantity,0)<v_confirmed then raise exception 'REPLENISHMENT_PURCHASE_BELOW_CONFIRMED'; end if;
    if v_order.status='approved' then
      if v_quantity is null then raise exception 'REPLENISHMENT_PURCHASE_NOT_MARKED'; end if;
      update public.market_replenishment_orders set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now() where id=p_order_id;
      v_order.status := 'in_progress';
    end if;
    update public.market_replenishment_purchase_declarations
      set purchased_quantity=v_quantity,purchase_version=purchase_version+1,updated_at=now() where id=v_declaration.id;

    if v_quantity is not null then
      if not exists (select 1 from public.market_replenishment_order_events
        where market_account_id=p_market_account_id and order_id=p_order_id
          and approval_revision=v_order.approval_revision and event_type='PURCHASE_STARTED') then
        v_ordinal := v_ordinal+1;
        perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_STARTED',p_request_id,null,null,null,null,'{}',v_ordinal);
      end if;
      v_remaining := greatest(0,v_quantity-v_confirmed);
      for v_line in
        select l.* from public.market_replenishment_operation_lines l
        join public.market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where l.order_id=p_order_id and l.market_account_id=p_market_account_id
          and l.approval_revision=v_order.approval_revision and l.operation_type='purchase'
          and i.product_id=v_declaration.product_id order by l.id
      loop
        v_delta := least(v_remaining,v_line.target_quantity-v_line.confirmed_quantity);
        update public.market_replenishment_operation_lines
          set started_at=coalesce(started_at,now()),started_by=coalesce(started_by,auth.uid()),
            confirmed_quantity=confirmed_quantity+v_delta,
            completed_at=case when confirmed_quantity+v_delta=target_quantity then coalesce(completed_at,now()) else null end,
            completed_by=case when confirmed_quantity+v_delta=target_quantity then coalesce(completed_by,auth.uid()) else null end,
            updated_at=now()
          where id=v_line.id;
        if v_delta>0 then
          v_ordinal := v_ordinal+1;
          insert into public.market_replenishment_order_events(
            market_account_id,order_id,event_type,approval_revision,operation_line_id,
            request_id,request_ordinal,quantity_delta,metadata,actor_kind
          ) values (p_market_account_id,p_order_id,'PURCHASE_QUANTITY_CONFIRMED',v_order.approval_revision,v_line.id,
            p_request_id,v_ordinal,v_delta,jsonb_build_object('declarationId',v_declaration.id),'service');
          v_remaining := v_remaining-v_delta;
        end if;
      end loop;
    end if;
  end loop;

  if exists (select 1 from public.market_replenishment_operation_lines
      where market_account_id=p_market_account_id and order_id=p_order_id
        and approval_revision=v_order.approval_revision and operation_type='purchase')
    and not exists (select 1 from public.market_replenishment_operation_lines
      where market_account_id=p_market_account_id and order_id=p_order_id
        and approval_revision=v_order.approval_revision and operation_type='purchase' and confirmed_quantity<target_quantity)
    and not exists (select 1 from public.market_replenishment_order_events
      where market_account_id=p_market_account_id and order_id=p_order_id
        and approval_revision=v_order.approval_revision and event_type='PURCHASE_COMPLETED') then
    v_ordinal := v_ordinal+1;
    perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_COMPLETED',p_request_id,null,null,null,null,'{}',v_ordinal);
  end if;
  perform public.market_complete_replenishment_order_internal(p_market_account_id,p_order_id,p_request_id);
end;
$$;

-- Vinculo documental continua disponivel apos conclusao comercial.
create or replace function public.market_link_replenishment_purchase_nf(
  p_market_account_id uuid,p_order_id uuid,p_declaration_id uuid,p_purchase_item_id uuid,p_quantity numeric,p_request_id uuid
) returns void language plpgsql security definer set search_path=public as $$
declare v_declaration public.market_replenishment_purchase_declarations; v_item public.market_purchase_items;
  v_metadata jsonb := jsonb_build_object('declarationId',p_declaration_id,'purchaseItemId',p_purchase_item_id,'quantity',p_quantity);
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
  perform 1 from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id and status in ('in_progress','completed') for update;
  if not found then raise exception 'REPLENISHMENT_PURCHASE_NOT_APPROVED'; end if;
  if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'PURCHASE_NF_LINKED',v_metadata) then return; end if;
  select * into v_declaration from public.market_replenishment_purchase_declarations where id=p_declaration_id and order_id=p_order_id and market_account_id=p_market_account_id for update;
  if not found or v_declaration.purchased_quantity is null then raise exception 'REPLENISHMENT_PURCHASE_NOT_MARKED'; end if;
  select i.* into v_item from public.market_purchase_items i
    join public.market_purchases p on p.id=i.market_purchase_id and p.market_account_id=i.market_account_id
    join public.market_stores s on s.id=p.destination_store_id and s.market_account_id=p.market_account_id
    where i.id=p_purchase_item_id and i.market_account_id=p_market_account_id and i.market_product_id=v_declaration.product_id
      and s.store_type='warehouse' and public.market_can_access_store(s.id) and p.invoice_key is not null and btrim(p.invoice_key)<>'' and p.status not in ('cancelled','failed')
      and i.reconciliation_status in ('matched_auto','matched_manual','mapped') and i.stock_unit is not null and i.stock_entry_status not in ('ignored','blocked') and i.stock_quantity>0 for update of i;
  if not found then raise exception 'REPLENISHMENT_PURCHASE_NF_INVALID'; end if;
  if p_quantity is null or p_quantity<=0 or p_quantity::text in ('NaN','Infinity','-Infinity')
    or p_quantity+coalesce((select sum(quantity) from public.market_replenishment_purchase_nf_links where purchase_declaration_id=p_declaration_id),0)>v_declaration.purchased_quantity
    or p_quantity+coalesce((select sum(quantity) from public.market_replenishment_purchase_nf_links where purchase_item_id=p_purchase_item_id and market_account_id=p_market_account_id),0)>v_item.stock_quantity then raise exception 'REPLENISHMENT_PURCHASE_NF_EXCEEDED'; end if;
  insert into public.market_replenishment_purchase_nf_links(market_account_id,order_id,purchase_declaration_id,purchase_item_id,quantity,created_by)
    values(p_market_account_id,p_order_id,p_declaration_id,p_purchase_item_id,p_quantity,auth.uid());
  perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_NF_LINKED',p_request_id,null,null,null,null,v_metadata);
end;
$$;


-- Warehouse tambem tenta concluir; transferencias e quantidades preservadas.
create or replace function public.market_execute_replenishment_store_supply(
  p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,p_warehouse_operation_line_id uuid,p_source_store_id uuid,p_quantity numeric,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path=public as $$
declare v_order public.market_replenishment_orders; v_line public.market_replenishment_operation_lines; v_allocation public.market_replenishment_order_allocations; v_product uuid; v_destination uuid; v_balance numeric; v_execution public.market_replenishment_supply_executions; v_sum numeric; v_confirmed numeric;
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  if p_request_id is null then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_REQUIRED'; end if;
  if p_quantity is null or p_quantity<=0 or p_quantity<>trunc(p_quantity) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'REPLENISHMENT_SUPPLY_INVALID_QUANTITY'; end if;
  -- Mesma ordem de locks de purchase/conclusao; serializa tambem replay concorrente.
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
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
  perform public.market_complete_replenishment_order_internal(p_market_account_id,p_order_id,p_request_id);
  return public.market_replenishment_supply_result(v_execution.id,p_market_account_id);
exception when unique_violation then
  select * into v_execution from public.market_replenishment_supply_executions where market_account_id=p_market_account_id and request_id=p_request_id;
  if found then return public.market_replenishment_supply_result(v_execution.id,p_market_account_id); end if;
  raise;
end;
$$;


commit;
