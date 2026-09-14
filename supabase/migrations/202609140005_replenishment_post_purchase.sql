-- Aplicacao manual. 003/004 permanecem imutaveis.
begin;

-- Um link pode cobrir varias lojas; esta decomposicao conserva sua origem documental.
create table public.market_replenishment_receipt_allocations (
  id uuid primary key default gen_random_uuid(),
  market_account_id uuid not null,
  order_id uuid not null,
  allocation_id uuid not null,
  nf_link_id uuid not null references public.market_replenishment_purchase_nf_links(id) on delete restrict,
  quantity numeric(18,4) not null check(quantity>0),
  created_at timestamptz not null default now(),
  unique(nf_link_id,allocation_id),
  foreign key (allocation_id,market_account_id) references public.market_replenishment_order_allocations(id,market_account_id),
  foreign key (order_id,market_account_id) references public.market_replenishment_orders(id,market_account_id)
);
alter table public.market_replenishment_receipt_allocations enable row level security;
revoke all on public.market_replenishment_receipt_allocations from public,anon,authenticated,service_role;
create index on public.market_replenishment_receipt_allocations(market_account_id,allocation_id);
alter table public.market_replenishment_supply_executions alter column warehouse_operation_line_id drop not null;

alter table public.market_replenishment_order_events drop constraint market_replenishment_order_events_event_type_check;
alter table public.market_replenishment_order_events add constraint market_replenishment_order_events_event_type_check check(event_type in (
 'ORDER_CREATED','ORDER_APPROVED','ORDER_REOPENED','ORDER_CANCELLED','ORDER_SUPERSEDED',
 'WAREHOUSE_SEPARATION_STARTED','WAREHOUSE_QUANTITY_CONFIRMED','WAREHOUSE_SEPARATION_COMPLETED',
 'PURCHASE_STARTED','PURCHASE_QUANTITY_CONFIRMED','PURCHASE_COMPLETED','ORDER_COMPLETED',
 'PURCHASE_DECLARATION_CHANGED','PURCHASE_NF_LINKED','PURCHASE_CORRECTED','SUPPLY_EXECUTED'));

create function public.market_replenishment_approval_time_internal(p_account uuid,p_order uuid,p_revision integer)
returns timestamptz language sql stable set search_path=public as $$
 select min(occurred_at) from market_replenishment_order_events where market_account_id=p_account
   and order_id=p_order and approval_revision=p_revision and event_type='ORDER_APPROVED';
$$;

-- Evidencia de recebimento: nunca saldo e nunca documento apenas importado.
create function public.market_replenishment_received_items_internal(p_account uuid,p_product uuid)
returns table(item_id uuid,warehouse_id uuid,quantity numeric,received_at timestamptz)
language sql stable set search_path=public as $$
 select i.id,p.destination_store_id,i.stock_quantity,min(m.occurred_at)
 from market_purchase_items i join market_purchases p on p.id=i.market_purchase_id and p.market_account_id=i.market_account_id
 join market_stores s on s.id=p.destination_store_id and s.market_account_id=p.market_account_id
 join market_stock_movements m on m.market_account_id=i.market_account_id and m.market_store_id=s.id
   and m.product_id=i.market_product_id and m.movement_type='PURCHASE' and m.direction='IN'
   and m.reference_type='PURCHASE' and m.reference_id=p.id and m.reference_item_id=i.id and m.quantity=i.stock_quantity
 where i.market_account_id=p_account and i.market_product_id=p_product and s.store_type='warehouse'
   and i.stock_entry_status='received' and p.status in ('receiving','completed')
   and nullif(btrim(p.invoice_key),'') is not null and i.stock_quantity>0 and i.stock_unit is not null
   and i.reconciliation_status in ('matched_auto','matched_manual','mapped')
 group by i.id,p.destination_store_id,i.stock_quantity;
$$;

-- Reconciliacao global por produto para nao permitir que uma chamada de ordem nova fure FIFO.
create function public.market_reconcile_replenishment_receipts_internal(p_account uuid,p_products uuid[])
returns void language plpgsql security definer set search_path=public as $$
declare v_product uuid; n record; r record; v_need numeric; v_available numeric; v_take numeric;
 v_link uuid; v_existing numeric; v_request uuid; v_applied numeric;
begin
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_account::text,0));
 for v_product in select distinct x from unnest(p_products) x order by x loop
  for n in
   select l.*,d.id declaration_id,d.purchased_quantity,
     public.market_replenishment_approval_time_internal(p_account,l.order_id,l.approval_revision) born
   from market_replenishment_operation_lines l
   join market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id
   join market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
   join market_replenishment_orders o on o.id=l.order_id and o.market_account_id=l.market_account_id and o.approval_revision=l.approval_revision
   join market_replenishment_purchase_declarations d on d.order_id=o.id and d.market_account_id=o.market_account_id
     and d.approval_revision=l.approval_revision and d.product_id=i.product_id
   where l.market_account_id=p_account and i.product_id=v_product and l.operation_type='purchase'
     and o.status in ('approved','in_progress','completed') and i.status<>'cancelled' and a.status<>'cancelled'
     and not exists(select 1 from market_replenishment_candidates c where c.id=a.candidate_id and c.priority_level='low') and l.confirmed_quantity>0
     and coalesce((select sum(x.quantity) from market_replenishment_receipt_allocations x where x.allocation_id=a.id),0)<l.target_quantity
   order by born,l.order_id,l.allocation_id
  loop
   -- Falta de prova da aprovacao nao autoriza consumo de estoque antigo.
   if n.born is null or n.confirmed_quantity<n.target_quantity then exit; end if;
   v_need:=n.target_quantity-coalesce((select sum(x.quantity) from market_replenishment_receipt_allocations x where x.allocation_id=n.allocation_id),0);
   -- Inclui links documentais antigos desta declaracao ainda nao decompostos por loja.
   select coalesce(sum(greatest(0,evidence.quantity-coalesce((select sum(x.quantity) from market_replenishment_purchase_nf_links x where x.purchase_item_id=evidence.item_id),0))
     +coalesce((select sum(greatest(0,x.quantity-coalesce((select sum(z.quantity) from market_replenishment_receipt_allocations z where z.nf_link_id=x.id),0)))
       from market_replenishment_purchase_nf_links x where x.purchase_item_id=evidence.item_id and x.purchase_declaration_id=n.declaration_id),0)),0)
   into v_available from public.market_replenishment_received_items_internal(p_account,v_product) evidence where evidence.received_at>=n.born;
   if v_available<v_need then exit; end if;
   v_request:=gen_random_uuid(); v_applied:=0;
   for r in select * from public.market_replenishment_received_items_internal(p_account,v_product) where received_at>=n.born order by received_at,item_id loop
    exit when v_need<=0;
    perform 1 from market_purchase_items where id=r.item_id for update;
    select id,quantity into v_link,v_existing from market_replenishment_purchase_nf_links
      where purchase_declaration_id=n.declaration_id and purchase_item_id=r.item_id for update;
    v_take:=least(v_need,greatest(0,coalesce(v_existing,0)-coalesce((select sum(quantity) from market_replenishment_receipt_allocations where nf_link_id=v_link),0)));
    if v_take>0 then
      insert into market_replenishment_receipt_allocations(market_account_id,order_id,allocation_id,nf_link_id,quantity)
      values(p_account,n.order_id,n.allocation_id,v_link,v_take)
      on conflict(nf_link_id,allocation_id) do update set quantity=market_replenishment_receipt_allocations.quantity+excluded.quantity;
      v_need:=v_need-v_take; v_applied:=v_applied+v_take;
    end if;
    v_take:=least(v_need,greatest(0,r.quantity-coalesce((select sum(quantity) from market_replenishment_purchase_nf_links where purchase_item_id=r.item_id),0)),
      greatest(0,n.purchased_quantity-coalesce((select sum(quantity) from market_replenishment_purchase_nf_links where purchase_declaration_id=n.declaration_id),0)));
    if v_take>0 then
      insert into market_replenishment_purchase_nf_links(market_account_id,order_id,purchase_declaration_id,purchase_item_id,quantity,created_by)
      values(p_account,n.order_id,n.declaration_id,r.item_id,v_take,auth.uid())
      on conflict(purchase_declaration_id,purchase_item_id) do update set quantity=market_replenishment_purchase_nf_links.quantity+excluded.quantity returning id into v_link;
      insert into market_replenishment_receipt_allocations(market_account_id,order_id,allocation_id,nf_link_id,quantity)
      values(p_account,n.order_id,n.allocation_id,v_link,v_take)
      on conflict(nf_link_id,allocation_id) do update set quantity=market_replenishment_receipt_allocations.quantity+excluded.quantity;
      v_need:=v_need-v_take; v_applied:=v_applied+v_take;
    end if;
   end loop;
   if v_need>0 then raise exception 'REPLENISHMENT_RECEIPT_ALLOCATION_CONFLICT'; end if;
   perform public.market_replenishment_emit_event_internal(p_account,n.order_id,'PURCHASE_NF_LINKED',v_request,null,null,null,null,
     jsonb_build_object('automatic',true,'allocationId',n.allocation_id,'quantity',v_applied));
  end loop;
 end loop;
end;
$$;

-- Correcoes sao autorizadas por um evento da mesma transacao; sem flag de sessao manipulavel.
create function public.market_replenishment_correction_internal(p_account uuid,p_order uuid,p_line uuid,p_quantity numeric)
returns boolean language sql stable set search_path=public as $$
 select exists(select 1 from market_replenishment_order_events e where e.market_account_id=p_account and e.order_id=p_order
   and e.event_type='PURCHASE_CORRECTED' and e.actor_user_id=auth.uid() and e.metadata->>'transaction'=txid_current()::text
   and (p_line is null or (e.metadata->'lineUpdates'->>p_line::text)::numeric=p_quantity));
$$;

-- Further function definitions below preserve the approved plan and physical history.

create function public.market_get_replenishment_delivery_history(p_market_account_id uuid,p_store_id uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'productName',p.name,'storeName',s.name,'sourceStoreName',w.name,'quantity',e.quantity) order by e.created_at desc,e.id),'[]') into result
 from market_replenishment_supply_executions e join market_products p on p.id=e.product_id and p.market_account_id=e.market_account_id
 join market_stores s on s.id=e.destination_store_id join market_stores w on w.id=e.source_store_id
 where e.market_account_id=p_market_account_id and (p_store_id is null or e.destination_store_id=p_store_id)
  and market_can_access_store(s.id) and market_can_access_store(w.id);
 return result;
end;
$$;
revoke all on function public.market_get_replenishment_delivery_history(uuid,uuid) from public,anon;
grant execute on function public.market_get_replenishment_delivery_history(uuid,uuid) to authenticated;

create or replace function public.market_get_replenishment_purchasing(p_market_account_id uuid,p_order_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 select coalesce(jsonb_agg(row_data order by born,id),'[]') into result from (
 select d.id,market_replenishment_approval_time_internal(p_market_account_id,o.id,o.approval_revision) born,
 jsonb_build_object('id',d.id,'orderId',o.id,'orderStatus',o.status,'productId',d.product_id,'productName',p.name,
   'targetQuantity',d.target_quantity,'purchasedQuantity',d.purchased_quantity,'version',d.purchase_version,
   'remainingToBuy',greatest(0,d.target_quantity-coalesce(d.purchased_quantity,0)),
   'awaitingQuantity',greatest(0,least(d.target_quantity,coalesce(d.purchased_quantity,0))-coalesce(s.received,0)),
   'receivedQuantity',coalesce(s.received,0),'coveredQuantity',coalesce(s.received,0),
   'committedQuantity',greatest(coalesce(s.committed,0),coalesce((select sum(quantity) from market_replenishment_purchase_nf_links where purchase_declaration_id=d.id),0)),
   'canCorrect',coalesce(d.purchased_quantity,0)>greatest(coalesce(s.committed,0),coalesce((select sum(quantity) from market_replenishment_purchase_nf_links where purchase_declaration_id=d.id),0))
      and not(o.status='completed' and exists(select 1 from market_replenishment_orders x where x.market_account_id=o.market_account_id and x.id<>o.id and x.status in ('draft','approved','in_progress'))),
   'linked',exists(select 1 from market_replenishment_purchase_nf_links where purchase_declaration_id=d.id),
   'stores',coalesce(s.stores,'[]'),'invoices','[]'::jsonb) row_data
 from market_replenishment_purchase_declarations d join market_replenishment_orders o on o.id=d.order_id and o.market_account_id=d.market_account_id and o.approval_revision=d.approval_revision
 join market_products p on p.id=d.product_id and p.market_account_id=d.market_account_id
 join lateral (
  select sum(q.received) received,sum(greatest(q.received,least(q.target,greatest(0,q.delivered-q.warehouse)))) committed,
    jsonb_agg(jsonb_build_object('allocationId',q.id,'storeId',q.store_id,'storeName',q.name,'targetQuantity',q.target,
      'purchasedQuantity',q.acquired,'receivedQuantity',q.received,'awaitingQuantity',greatest(0,q.acquired-q.received),
      'deliveredQuantity',q.delivered,'remainingPhysical',greatest(0,q.need-q.delivered)) order by q.id) stores
  from (select a.id,a.store_id,s.name,l.target_quantity target,l.confirmed_quantity acquired,a.warehouse_allocated_quantity warehouse,
    coalesce(a.adjusted_quantity,a.suggested_quantity) need,
    coalesce((select sum(quantity) from market_replenishment_receipt_allocations where allocation_id=a.id),0) received,
    coalesce((select sum(quantity) from market_replenishment_supply_executions where allocation_id=a.id),0) delivered
   from market_replenishment_operation_lines l join market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id
   join market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
   join market_stores s on s.id=a.store_id and s.market_account_id=a.market_account_id
   where l.order_id=o.id and l.approval_revision=o.approval_revision and l.operation_type='purchase' and i.product_id=d.product_id
     and i.status<>'cancelled' and a.status<>'cancelled' and market_can_access_store(s.id)
     and not exists(select 1 from market_replenishment_candidates c where c.id=a.candidate_id and c.priority_level='low')) q
 ) s on s.stores is not null
 where d.market_account_id=p_market_account_id and (p_order_id is null or o.id=p_order_id) and o.status in ('approved','in_progress','completed')
 ) data;
 return result;
end;
$$;

create or replace function public.market_get_replenishment_store_supply(p_market_account_id uuid,p_order_id uuid,p_store_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',q.allocation_id::text||':'||q.source_store_id::text,'orderId',q.order_id,
  'operationLineId',q.warehouse_line_id,'allocationId',q.allocation_id,'productId',q.product_id,'productName',p.name,
  'storeId',q.store_id,'storeName',s.name,'sourceStoreId',q.source_store_id,'sourceStoreName',w.name,
  'targetQuantity',q.target,'confirmedQuantity',q.delivered,'executedQuantity',q.delivered,'remainingQuantity',q.remaining,
  'warehouseBalance',q.balance,'suggestedQuantity',q.remaining) order by q.product_id,q.allocation_id),'[]') into result
 from market_replenishment_supply_queue_internal(p_market_account_id) q
 join market_products p on p.id=q.product_id and p.market_account_id=p_market_account_id
 join market_stores s on s.id=q.store_id join market_stores w on w.id=q.source_store_id
 where (p_order_id is null or q.order_id=p_order_id) and (p_store_id is null or q.store_id=p_store_id)
  and market_can_access_store(s.id) and market_can_access_store(w.id);
 return result;
end;
$$;

create or replace function public.market_execute_replenishment_store_supply(
 p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,p_warehouse_operation_line_id uuid,p_source_store_id uuid,p_quantity numeric,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e market_replenishment_supply_executions;o market_replenishment_orders; n record; w market_replenishment_operation_lines; v_balance numeric;v_delta numeric:=0;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 if p_request_id is null then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_REQUIRED'; end if;
 if p_quantity is null or p_quantity<=0 or p_quantity<>trunc(p_quantity) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'REPLENISHMENT_SUPPLY_INVALID_QUANTITY'; end if;
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
 select * into e from market_replenishment_supply_executions where market_account_id=p_market_account_id and request_id=p_request_id;
 if found then
  if (e.replenishment_order_id,e.allocation_id,e.warehouse_operation_line_id,e.source_store_id,e.quantity,e.created_by)
    is distinct from (p_order_id,p_allocation_id,p_warehouse_operation_line_id,p_source_store_id,p_quantity,auth.uid()) then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_CONFLICT'; end if;
  return market_replenishment_supply_result(e.id,p_market_account_id);
 end if;
 select * into o from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
 if not found or o.status not in ('approved','in_progress','completed') then raise exception 'REPLENISHMENT_SUPPLY_ORDER_INVALID'; end if;
 select * into n from market_replenishment_physical_needs_internal(p_market_account_id) where allocation_id=p_allocation_id and order_id=p_order_id;
 if not found or not market_can_access_store(n.store_id) then raise exception 'REPLENISHMENT_SUPPLY_DESTINATION_INVALID'; end if;
 if p_warehouse_operation_line_id is distinct from n.warehouse_line_id then raise exception 'REPLENISHMENT_SUPPLY_OPERATION_INVALID'; end if;
 if not exists(select 1 from market_stores where id=p_source_store_id and market_account_id=p_market_account_id and status='active' and store_type='warehouse' and market_can_access_store(id)) then raise exception 'REPLENISHMENT_SUPPLY_SOURCE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-supply:'||p_market_account_id::text||':'||p_source_store_id::text||':'||n.product_id::text,0));
 perform 1 from market_stores where id=p_source_store_id for update;
 if n.allocation_id is distinct from (select allocation_id from market_replenishment_physical_needs_internal(p_market_account_id) where product_id=n.product_id and remaining>0 order by born,order_id,allocation_id limit 1) then raise exception 'REPLENISHMENT_SUPPLY_FIFO_BLOCKED'; end if;
 if p_quantity<>n.remaining then raise exception 'REPLENISHMENT_SUPPLY_FULL_NEED_REQUIRED'; end if;
 select coalesce(sum(case when direction='IN' then quantity else -quantity end),0) into v_balance from market_stock_movements
   where market_account_id=p_market_account_id and market_store_id=p_source_store_id and product_id=n.product_id;
 if v_balance<p_quantity then raise exception 'REPLENISHMENT_SUPPLY_INSUFFICIENT_STOCK: saldo atual %',greatest(0,v_balance); end if;
 if o.status='approved' then
   update market_replenishment_orders set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now() where id=o.id;
 end if;
 insert into market_replenishment_supply_executions(market_account_id,replenishment_order_id,allocation_id,warehouse_operation_line_id,source_store_id,destination_store_id,product_id,quantity,request_id,created_by)
 values(p_market_account_id,o.id,n.allocation_id,n.warehouse_line_id,p_source_store_id,n.store_id,n.product_id,p_quantity,p_request_id,auth.uid()) returning * into e;
 insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id)
 values(p_market_account_id,p_source_store_id,n.product_id,'TRANSFER_OUT','OUT',p_quantity,'REPLENISHMENT_SUPPLY',e.id,e.id),
 (p_market_account_id,n.store_id,n.product_id,'TRANSFER_IN','IN',p_quantity,'REPLENISHMENT_SUPPLY',e.id,e.id);
 if n.warehouse_line_id is not null then
  select * into w from market_replenishment_operation_lines where id=n.warehouse_line_id for update;
  v_delta:=least(w.target_quantity,n.delivered+p_quantity)-w.confirmed_quantity;
  if v_delta>0 then
    update market_replenishment_operation_lines set confirmed_quantity=confirmed_quantity+v_delta,started_at=coalesce(started_at,now()),started_by=coalesce(started_by,auth.uid()),
      completed_at=case when confirmed_quantity+v_delta=target_quantity then now() else null end,completed_by=case when confirmed_quantity+v_delta=target_quantity then auth.uid() else null end where id=w.id;
  end if;
 end if;
 insert into market_replenishment_order_events(market_account_id,order_id,event_type,approval_revision,operation_line_id,request_id,quantity_delta,metadata,actor_kind)
 values(p_market_account_id,o.id,case when v_delta>0 then 'WAREHOUSE_QUANTITY_CONFIRMED' else 'SUPPLY_EXECUTED' end,o.approval_revision,n.warehouse_line_id,p_request_id,case when v_delta>0 then v_delta else p_quantity end,jsonb_build_object('executionId',e.id),'service');
 perform market_complete_replenishment_order_internal(p_market_account_id,o.id,p_request_id);
 return market_replenishment_supply_result(e.id,p_market_account_id);
end;
$$;

create or replace function public.market_replenishment_supply_result(p_execution uuid,p_account uuid)
returns jsonb language sql stable security definer set search_path=public as $$
 select jsonb_build_object('executionId',e.id,'newWarehouseBalance',coalesce((select sum(case when direction='IN' then quantity else -quantity end) from market_stock_movements where market_account_id=p_account and market_store_id=e.source_store_id and product_id=e.product_id),0),
  'executedQuantity',e.quantity,'allocationId',e.allocation_id,'confirmedQuantity',coalesce((select sum(quantity) from market_replenishment_supply_executions where allocation_id=e.allocation_id),0),'targetQuantity',coalesce(a.adjusted_quantity,a.suggested_quantity))
 from market_replenishment_supply_executions e join market_replenishment_order_allocations a on a.id=e.allocation_id and a.market_account_id=e.market_account_id where e.id=p_execution and e.market_account_id=p_account;
$$;

create or replace function public.market_set_replenishment_purchased(p_market_account_id uuid,p_order_id uuid,p_changes jsonb,p_request_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare o market_replenishment_orders; d market_replenishment_purchase_declarations; l record; c jsonb;
 q numeric; committed numeric; budget numeric; desired numeric; updates jsonb; ord integer:=1; products uuid[]:='{}'; corrected boolean:=false;
 meta jsonb:=jsonb_build_object('changes',p_changes);
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
 select * into o from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
 if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
 if market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'PURCHASE_DECLARATION_CHANGED',meta) then return; end if;
 if o.status not in ('approved','in_progress','completed') then raise exception 'REPLENISHMENT_PURCHASE_NOT_APPROVED'; end if;
 if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 500
   or (select count(*)<>count(distinct value->>'declarationId') from jsonb_array_elements(p_changes)) then raise exception 'REPLENISHMENT_PURCHASE_INVALID_INPUT'; end if;
 perform market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_DECLARATION_CHANGED',p_request_id,null,null,null,null,meta,ord);
 for c in select value from jsonb_array_elements(p_changes) loop
  select * into d from market_replenishment_purchase_declarations where id=(c->>'declarationId')::uuid
    and market_account_id=p_market_account_id and order_id=p_order_id and approval_revision=o.approval_revision for update;
  if not found then raise exception 'REPLENISHMENT_PURCHASE_DECLARATION_NOT_FOUND'; end if;
  if (c->>'version')::integer is distinct from d.purchase_version then raise exception 'REPLENISHMENT_PURCHASE_VERSION_CONFLICT'; end if;
  if not(c?'quantity') or jsonb_typeof(c->'quantity') not in ('number','null') then raise exception 'REPLENISHMENT_PURCHASE_INVALID_QUANTITY'; end if;
  q:=(c->>'quantity')::numeric;
  if q is not null and (q<=0 or q<>trunc(q) or q::text in ('NaN','Infinity','-Infinity') or q>=100000000000000) then raise exception 'REPLENISHMENT_PURCHASE_INVALID_QUANTITY'; end if;
  products:=array_append(products,d.product_id);updates:='{}';committed:=0;
  for l in select x.*,greatest(coalesce((select sum(r.quantity) from market_replenishment_receipt_allocations r where r.allocation_id=a.id),0),
      least(x.target_quantity,greatest(0,coalesce((select sum(e.quantity) from market_replenishment_supply_executions e where e.allocation_id=a.id),0)-a.warehouse_allocated_quantity))) floor
    from market_replenishment_operation_lines x join market_replenishment_order_allocations a on a.id=x.allocation_id
    join market_replenishment_order_items i on i.id=a.order_item_id
    where x.market_account_id=p_market_account_id and x.order_id=p_order_id and x.approval_revision=o.approval_revision
      and x.operation_type='purchase' and i.product_id=d.product_id
    order by market_replenishment_approval_time_internal(p_market_account_id,x.order_id,x.approval_revision),x.order_id,x.allocation_id for update of x loop
    committed:=committed+l.floor;
    updates:=jsonb_set(updates,array[l.id::text],to_jsonb(case when coalesce(q,0)>=coalesce(d.purchased_quantity,0) then greatest(l.floor,l.confirmed_quantity) else l.floor end));
  end loop;
  if updates='{}' then raise exception 'REPLENISHMENT_PURCHASE_OPERATION_NOT_FOUND'; end if;
  -- Links legados documentais tambem protegem a parcela ja comprometida.
  committed:=greatest(committed,coalesce((select sum(quantity) from market_replenishment_purchase_nf_links where purchase_declaration_id=d.id),0));
  if coalesce(q,0)<committed then raise exception 'REPLENISHMENT_PURCHASE_PHYSICALLY_COMMITTED'; end if;
  budget:=coalesce(q,0)-(select coalesce(sum(value::text::numeric),0) from jsonb_each(updates));
  for l in select x.* from market_replenishment_operation_lines x where updates?x.id::text
    order by market_replenishment_approval_time_internal(p_market_account_id,x.order_id,x.approval_revision),x.order_id,x.allocation_id loop
    desired:=least(l.target_quantity-(updates->>l.id::text)::numeric,budget);
    budget:=budget-desired; updates:=jsonb_set(updates,array[l.id::text],to_jsonb((updates->>l.id::text)::numeric+desired));
  end loop;
  if coalesce(q,0)<coalesce(d.purchased_quantity,0) then
    corrected:=true;ord:=ord+1;
    perform market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_CORRECTED',p_request_id,null,null,null,null,
      jsonb_build_object('transaction',txid_current()::text,'declarationId',d.id,'previousQuantity',d.purchased_quantity,'quantity',q,'lineUpdates',updates),ord);
  end if;
  if o.status='completed' and exists(select 1 from market_replenishment_operation_lines x where updates?x.id::text and (updates->>x.id::text)::numeric<x.target_quantity) then
    if exists(select 1 from market_replenishment_orders where market_account_id=p_market_account_id and id<>o.id and status in ('draft','approved','in_progress')) then raise exception 'REPLENISHMENT_CORRECTION_ACTIVE_ORDER'; end if;
    update market_replenishment_orders set status='in_progress',completed_at=null,completed_by=null,updated_at=now() where id=o.id;
    o.status:='in_progress';
  elsif o.status='approved' and q is not null then
    update market_replenishment_orders set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now() where id=o.id;
    o.status:='in_progress';
  end if;
  update market_replenishment_purchase_declarations set purchased_quantity=q,purchase_version=purchase_version+1,updated_at=now() where id=d.id;
  if q is not null and not exists(select 1 from market_replenishment_order_events where order_id=o.id and approval_revision=o.approval_revision and event_type='PURCHASE_STARTED') then
    ord:=ord+1;perform market_replenishment_emit_event_internal(p_market_account_id,o.id,'PURCHASE_STARTED',p_request_id,null,null,null,null,'{}',ord);
  end if;
  for l in select x.* from market_replenishment_operation_lines x where updates?x.id::text
    order by market_replenishment_approval_time_internal(p_market_account_id,x.order_id,x.approval_revision),x.order_id,x.allocation_id loop
    desired:=(updates->>l.id::text)::numeric;
    if desired<>l.confirmed_quantity then
      update market_replenishment_operation_lines set confirmed_quantity=desired,started_at=coalesce(started_at,now()),started_by=coalesce(started_by,auth.uid()),
        completed_at=case when desired=target_quantity then coalesce(completed_at,now()) else null end,
        completed_by=case when desired=target_quantity then coalesce(completed_by,auth.uid()) else null end where id=l.id;
      if desired>l.confirmed_quantity then
        ord:=ord+1;
        insert into market_replenishment_order_events(market_account_id,order_id,event_type,approval_revision,operation_line_id,request_id,request_ordinal,quantity_delta,metadata,actor_kind)
        values(p_market_account_id,o.id,'PURCHASE_QUANTITY_CONFIRMED',o.approval_revision,l.id,p_request_id,ord,desired-l.confirmed_quantity,jsonb_build_object('declarationId',d.id),'service');
      end if;
    end if;
  end loop;
 end loop;
 if not exists(select 1 from market_replenishment_operation_lines where order_id=o.id and approval_revision=o.approval_revision and operation_type='purchase' and confirmed_quantity<target_quantity)
   and not exists(select 1 from market_replenishment_order_events e where e.order_id=o.id and e.approval_revision=o.approval_revision and e.event_type='PURCHASE_COMPLETED'
     and e.sequence>coalesce((select max(sequence) from market_replenishment_order_events where order_id=o.id and event_type='PURCHASE_CORRECTED'),0)) then
   ord:=ord+1;perform market_replenishment_emit_event_internal(p_market_account_id,o.id,'PURCHASE_COMPLETED',p_request_id,null,null,null,null,'{}',ord);
 end if;
 perform market_complete_replenishment_order_internal(p_market_account_id,o.id,p_request_id);
 perform market_reconcile_replenishment_receipts_internal(p_market_account_id,products);
end;
$$;

-- Snapshot consultavel de necessidades fisicas, inclusive ordens comercialmente concluidas.
create function public.market_replenishment_physical_needs_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,revision integer,born timestamptz,
 target numeric,delivered numeric,remaining numeric,warehouse_line_id uuid)
language sql stable set search_path=public as $$
 select a.id,o.id,i.product_id,a.store_id,o.approval_revision,
 public.market_replenishment_approval_time_internal(p_account,o.id,o.approval_revision),
 coalesce(a.adjusted_quantity,a.suggested_quantity),coalesce(e.quantity,0),
 greatest(0,coalesce(a.adjusted_quantity,a.suggested_quantity)-coalesce(e.quantity,0)),w.id
 from market_replenishment_orders o join market_replenishment_order_items i on i.order_id=o.id and i.market_account_id=o.market_account_id
 join market_replenishment_order_allocations a on a.order_item_id=i.id and a.market_account_id=i.market_account_id
 left join market_replenishment_operation_lines w on w.allocation_id=a.id and w.approval_revision=o.approval_revision and w.operation_type='warehouse'
 left join lateral(select sum(quantity) quantity from market_replenishment_supply_executions where allocation_id=a.id and market_account_id=p_account) e on true
 where o.market_account_id=p_account and o.status in ('approved','in_progress','completed') and i.status<>'cancelled' and a.status<>'cancelled'
 and not exists(select 1 from market_replenishment_candidates c where c.id=a.candidate_id and c.priority_level='low');
$$;

-- Projecao FIFO, nao reserva. Todas as execucoes revalidam esta projecao sob lock.
create function public.market_replenishment_supply_queue_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,warehouse_line_id uuid,
 source_store_id uuid,target numeric,delivered numeric,remaining numeric,balance numeric,ready boolean)
language plpgsql stable set search_path=public as $$
declare n record; w record; v_balances jsonb:='{}'; v_blocked uuid[]:='{}'; v_available numeric; v_ready boolean;
begin
 for n in select q.* from public.market_replenishment_physical_needs_internal(p_account) q where q.remaining>0
   order by q.product_id,q.born,q.order_id,q.allocation_id loop
   if n.product_id=any(v_blocked) then continue; end if;
   v_ready:=false;
   for w in select s.id,coalesce(b.quantity_on_hand,0) qty from market_stores s left join market_stock_balance b
     on b.market_store_id=s.id and b.market_account_id=s.market_account_id and b.product_id=n.product_id
     where s.market_account_id=p_account and s.store_type='warehouse' and s.status='active' order by s.id loop
     v_available:=coalesce((v_balances->>(n.product_id::text||':'||w.id::text))::numeric,greatest(0,w.qty));
     if v_available>=n.remaining then
       v_balances:=jsonb_set(v_balances,array[n.product_id::text||':'||w.id::text],to_jsonb(v_available-n.remaining));
       allocation_id:=n.allocation_id;order_id:=n.order_id;product_id:=n.product_id;store_id:=n.store_id;warehouse_line_id:=n.warehouse_line_id;
       source_store_id:=w.id;target:=n.target;delivered:=n.delivered;remaining:=n.remaining;balance:=w.qty;ready:=true;
       v_ready:=true; return next; exit;
     end if;
   end loop;
   if not v_ready then v_blocked:=array_append(v_blocked,n.product_id); end if;
 end loop;
end;
$$;

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

create or replace function public.market_replenishment_guard_line_internal()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders;
begin
    if tg_op='DELETE' then raise exception 'REPLENISHMENT_OPERATION_HISTORY_IMMUTABLE'; end if;
    select * into v_order from public.market_replenishment_orders where id=new.order_id and market_account_id=new.market_account_id for update;
    if not found or not exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where a.id=new.allocation_id and a.market_account_id=new.market_account_id and i.order_id=new.order_id
    ) then raise exception 'REPLENISHMENT_OPERATION_INVALID_ALLOCATION'; end if;
    if tg_op='INSERT' then
        if v_order.status <> 'approved' or new.approval_revision <> v_order.approval_revision or new.confirmed_quantity <> 0 then
            raise exception 'REPLENISHMENT_OPERATION_INVALID_REVISION';
        end if;
        new.created_at := now(); new.created_by := auth.uid();
    else
        if (new.id,new.market_account_id,new.order_id,new.allocation_id,new.approval_revision,new.operation_type,new.target_quantity,new.created_at)
            is distinct from (old.id,old.market_account_id,old.order_id,old.allocation_id,old.approval_revision,old.operation_type,old.target_quantity,old.created_at) then
            raise exception 'REPLENISHMENT_OPERATION_TARGET_IMMUTABLE';
        end if;
        if (new.confirmed_quantity < old.confirmed_quantity and not (new.operation_type='purchase' and public.market_replenishment_correction_internal(new.market_account_id,new.order_id,new.id,new.confirmed_quantity))) or (old.started_at is not null and new.started_at is distinct from old.started_at) then
            raise exception 'REPLENISHMENT_OPERATION_PROGRESS_IMMUTABLE';
        end if;
        if v_order.status <> 'in_progress' or new.approval_revision <> v_order.approval_revision then raise exception 'REPLENISHMENT_OPERATION_INVALID_REVISION'; end if;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

create or replace function public.market_approve_replenishment_order(
    p_market_account_id uuid,p_order_id uuid,p_request_id uuid default gen_random_uuid()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'ORDER_APPROVED','{}') then return p_order_id; end if;
    if v_order.status <> 'draft' then raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT'; end if;
    perform public.market_replenishment_validate_plan_internal(p_market_account_id,p_order_id);
    if not exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where i.order_id=p_order_id and i.market_account_id=p_market_account_id and i.status<>'cancelled' and a.status<>'cancelled'
          and (a.warehouse_allocated_quantity>0 or a.purchase_needed_quantity>0)
    ) then raise exception 'REPLENISHMENT_ORDER_NO_OPERATION'; end if;
    update public.market_replenishment_orders set status='approved',approved_at=now(),approved_by=auth.uid(),
        approval_revision=approval_revision+1,updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    insert into public.market_replenishment_operation_lines(market_account_id,order_id,allocation_id,approval_revision,operation_type,target_quantity)
    select p_market_account_id,p_order_id,a.id,v_order.approval_revision+1,t.kind,t.quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    cross join lateral (values ('warehouse',a.warehouse_allocated_quantity),('purchase',a.purchase_needed_quantity)) t(kind,quantity)
    where i.order_id=p_order_id and i.market_account_id=p_market_account_id and i.status<>'cancelled' and a.status<>'cancelled' and t.quantity>0;
    perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_APPROVED',p_request_id,'draft','approved',null,null,'{}');
    perform public.market_reconcile_replenishment_receipts_internal(p_market_account_id,
      array(select product_id from market_replenishment_order_items where order_id=p_order_id and market_account_id=p_market_account_id));
    return p_order_id;
end;
$$;

create or replace function public.market_receive_purchase_items(
  p_market_account_id uuid, p_purchase_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_purchase public.market_purchases;
  v_item record;
  v_inserted integer;
  v_received_now integer := 0;
  v_total_items integer;
  v_received_items integer;
  v_new_status text;
begin
  if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
    raise exception 'RECONCILE_PERMISSION_DENIED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
  select * into v_purchase from public.market_purchases
    where id = p_purchase_id and market_account_id = p_market_account_id for update;
  if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
    raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
  end if;
  if v_purchase.status in ('completed','cancelled','failed') or not exists (
    select 1 from public.market_accounts where id = p_market_account_id and status in ('pilot','active')
  ) then
    raise exception 'PURCHASE_REVIEW_LOCKED';
  end if;

  for v_item in
    select i.* from public.market_purchase_items i
    where i.market_purchase_id = p_purchase_id
      and i.market_account_id = p_market_account_id
      and i.stock_entry_status = 'pending'
      and i.market_product_id is not null
      and i.reconciliation_status in ('matched_auto','matched_manual','mapped')
      and i.conversion_factor is not null
      and i.stock_unit is not null
      -- Regra preexistente desde 202609070006: preservar o criterio de custo.
      and i.stock_unit_cost is not null
      and i.reviewed_at is not null
      and i.reviewed_by is not null
    for update
  loop
    -- Revalida o produto no instante da entrada (pode ter mudado desde a
    -- conferência): item permanece pendente, sem travar os demais.
    if not exists (
      select 1 from public.market_products pr
      where pr.id = v_item.market_product_id and pr.market_account_id = p_market_account_id
        and pr.status = 'active' and public.market_is_accesys_current_product(p_market_account_id, pr.id)
    ) then
      continue;
    end if;

    insert into public.market_stock_movements(
      market_account_id, market_store_id, product_id, movement_type, direction,
      quantity, unit_cost, reference_type, reference_id, reference_item_id, notes, occurred_at, created_by
    ) values (
      p_market_account_id, v_purchase.destination_store_id, v_item.market_product_id, 'PURCHASE', 'IN',
      v_item.stock_quantity, v_item.stock_unit_cost, 'PURCHASE', v_purchase.id, v_item.id,
      'Recebimento da compra' || case when v_purchase.invoice_number is not null then ' ' || v_purchase.invoice_number else '' end,
      now(), auth.uid()
    )
    -- ux_market_stock_movements_source_item é parcial: o arbitro do ON CONFLICT
    -- só resolve para ela se o predicado for repetido aqui (não basta citar as colunas).
    on conflict (market_account_id, movement_type, reference_type, reference_id, reference_item_id)
      where reference_type is not null and reference_id is not null and reference_item_id is not null
      do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      continue;
    end if;

    update public.market_purchase_items
      set stock_entry_status = 'received', received_at = now(), received_by = auth.uid()
      where id = v_item.id and market_account_id = p_market_account_id;
    v_received_now := v_received_now + 1;
  end loop;

  if v_received_now = 0 then
    raise exception 'PURCHASE_RECEIVE_NO_READY_ITEMS';
  end if;

  select count(*), count(*) filter (where stock_entry_status = 'received')
    into v_total_items, v_received_items
    from public.market_purchase_items
    where market_purchase_id = p_purchase_id and market_account_id = p_market_account_id;

  if v_received_items = v_total_items then
    v_new_status := 'completed';
    update public.market_purchases set status = 'completed', received_at = now()
      where id = p_purchase_id and market_account_id = p_market_account_id;
  else
    v_new_status := 'receiving';
    update public.market_purchases set status = 'receiving'
      where id = p_purchase_id and market_account_id = p_market_account_id;
  end if;

  perform public.market_reconcile_replenishment_receipts_internal(p_market_account_id,
    array(select distinct market_product_id from market_purchase_items where market_purchase_id=p_purchase_id and market_account_id=p_market_account_id and stock_entry_status='received'));
  return jsonb_build_object(
    'purchaseId', p_purchase_id,
    'itemsReceivedNow', v_received_now,
    'itemsReceivedTotal', v_received_items,
    'itemsTotal', v_total_items,
    'purchaseStatus', v_new_status
  );
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
        return v_order;
    end if;

    return public.market_materialize_replenishment_order_draft_internal(p_market_account_id, v_run);
end;
$$;


-- Helpers internos: sem API de escrita direta; leitura/escrita oficial mantem guards.
revoke all on function public.market_link_replenishment_purchase_nf(uuid,uuid,uuid,uuid,numeric,uuid) from authenticated;
revoke all on function public.market_replenishment_approval_time_internal(uuid,uuid,integer),
 public.market_replenishment_received_items_internal(uuid,uuid),
 public.market_reconcile_replenishment_receipts_internal(uuid,uuid[]),
 public.market_replenishment_correction_internal(uuid,uuid,uuid,numeric),
 public.market_replenishment_physical_needs_internal(uuid),
 public.market_replenishment_supply_queue_internal(uuid) from public,anon,authenticated,service_role;
commit;
