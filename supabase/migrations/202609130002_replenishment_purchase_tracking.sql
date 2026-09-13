begin;

-- A compra e um fato consolidado por produto. As operation lines continuam
-- representando apenas a necessidade planejada de cada allocation.
create table public.market_replenishment_purchase_declarations (
  id uuid primary key default gen_random_uuid(),
  market_account_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  approval_revision integer not null check (approval_revision > 0),
  target_quantity numeric(18,4) not null check (target_quantity > 0 and target_quantity = trunc(target_quantity)),
  purchased_quantity numeric(18,4) null check (purchased_quantity is null or (purchased_quantity > 0 and purchased_quantity = trunc(purchased_quantity))),
  purchase_version integer not null default 0 check (purchase_version >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, product_id, approval_revision),
  unique (id, market_account_id, order_id),
  foreign key (order_id, market_account_id) references public.market_replenishment_orders(id, market_account_id) on delete restrict,
  foreign key (product_id, market_account_id) references public.market_products(id, market_account_id) on delete restrict
);
create index on public.market_replenishment_purchase_declarations(market_account_id, order_id, approval_revision);
alter table public.market_replenishment_purchase_declarations enable row level security;
revoke all on public.market_replenishment_purchase_declarations from public,anon,authenticated;

comment on table public.market_replenishment_purchase_declarations is
  'Fato consolidado da compra por produto. Nao altera allocations, nao confirma recebimento e nao gera estoque.';
comment on column public.market_replenishment_purchase_declarations.target_quantity is
  'Soma das quantidades planejadas de compra das allocations; apenas referencia, nunca e alterada pela compra.';
comment on column public.market_replenishment_purchase_declarations.purchased_quantity is
  'Quantidade efetivamente comprada do produto no conjunto da reposicao; NULL = pendente. Pode ser menor ou maior que target_quantity.';

create or replace function public.market_replenishment_sync_purchase_declaration_internal()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.operation_type = 'purchase' then
    insert into public.market_replenishment_purchase_declarations(
      market_account_id,order_id,product_id,approval_revision,target_quantity
    )
    select new.market_account_id,new.order_id,i.product_id,new.approval_revision,new.target_quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    where a.id=new.allocation_id and a.market_account_id=new.market_account_id
    on conflict (order_id,product_id,approval_revision) do update
      set target_quantity=market_replenishment_purchase_declarations.target_quantity + excluded.target_quantity,
          updated_at=now();
  end if;
  return new;
end;
$$;
create trigger trg_market_replenishment_sync_purchase_declaration
  after insert on public.market_replenishment_operation_lines
  for each row execute function public.market_replenishment_sync_purchase_declaration_internal();

create table public.market_replenishment_purchase_nf_links (
  id uuid primary key default gen_random_uuid(),
  market_account_id uuid not null,
  order_id uuid not null,
  purchase_declaration_id uuid not null,
  purchase_item_id uuid not null,
  quantity numeric(18,4) not null check (quantity > 0 and quantity::text not in ('NaN','Infinity','-Infinity')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  foreign key (purchase_declaration_id,market_account_id,order_id)
    references public.market_replenishment_purchase_declarations(id,market_account_id,order_id),
  foreign key (purchase_item_id,market_account_id)
    references public.market_purchase_items(id,market_account_id) on delete cascade,
  unique(purchase_declaration_id,purchase_item_id)
);
create index on public.market_replenishment_purchase_nf_links(market_account_id,purchase_item_id);
alter table public.market_replenishment_purchase_nf_links enable row level security;
revoke all on public.market_replenishment_purchase_nf_links from public,anon,authenticated;

alter table public.market_replenishment_order_events
  drop constraint market_replenishment_order_events_event_type_check,
  add constraint market_replenishment_order_events_event_type_check check (event_type in (
    'ORDER_CREATED','ORDER_APPROVED','ORDER_REOPENED','ORDER_CANCELLED','ORDER_SUPERSEDED',
    'WAREHOUSE_SEPARATION_STARTED','WAREHOUSE_QUANTITY_CONFIRMED','WAREHOUSE_SEPARATION_COMPLETED',
    'PURCHASE_STARTED','PURCHASE_QUANTITY_CONFIRMED','PURCHASE_COMPLETED','ORDER_COMPLETED',
    'PURCHASE_DECLARATION_CHANGED','PURCHASE_NF_LINKED'
  ));

create function public.market_set_replenishment_purchased(
  p_market_account_id uuid,p_order_id uuid,p_changes jsonb,p_request_id uuid
) returns void language plpgsql security definer set search_path=public as $$
declare v_order public.market_replenishment_orders; v_declaration public.market_replenishment_purchase_declarations;
  v_change jsonb; v_quantity numeric; v_metadata jsonb := jsonb_build_object('changes',p_changes);
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
  select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
  if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
  if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'PURCHASE_DECLARATION_CHANGED',v_metadata) then return; end if;
  if v_order.status not in ('approved','in_progress') then raise exception 'REPLENISHMENT_PURCHASE_NOT_APPROVED'; end if;
  if jsonb_typeof(p_changes) is distinct from 'array' or jsonb_array_length(p_changes) not between 1 and 500 then raise exception 'REPLENISHMENT_PURCHASE_INVALID_INPUT'; end if;
  if (select count(*)<>count(distinct value->>'declarationId') from jsonb_array_elements(p_changes)) then raise exception 'REPLENISHMENT_PURCHASE_INVALID_INPUT'; end if;
  for v_change in select value from jsonb_array_elements(p_changes) loop
    select * into v_declaration from public.market_replenishment_purchase_declarations
      where id=(v_change->>'declarationId')::uuid and market_account_id=p_market_account_id and order_id=p_order_id for update;
    if not found then raise exception 'REPLENISHMENT_PURCHASE_DECLARATION_NOT_FOUND'; end if;
    if (v_change->>'version')::integer is distinct from v_declaration.purchase_version then raise exception 'REPLENISHMENT_PURCHASE_VERSION_CONFLICT'; end if;
    if exists (select 1 from public.market_replenishment_purchase_nf_links where purchase_declaration_id=v_declaration.id)
       or exists (select 1 from public.market_replenishment_operation_lines l
         join public.market_replenishment_order_allocations a on a.id=l.allocation_id
         join public.market_replenishment_order_items i on i.id=a.order_item_id
         where l.order_id=p_order_id and l.market_account_id=p_market_account_id and l.operation_type='purchase'
           and i.product_id=v_declaration.product_id and l.confirmed_quantity>0) then raise exception 'REPLENISHMENT_PURCHASE_NF_LOCKED'; end if;
    if not (v_change ? 'quantity') or jsonb_typeof(v_change->'quantity') not in ('number','null') then raise exception 'REPLENISHMENT_PURCHASE_INVALID_QUANTITY'; end if;
    v_quantity := (v_change->>'quantity')::numeric;
    if v_quantity is not null and (v_quantity<=0 or v_quantity<>trunc(v_quantity) or v_quantity::text in ('NaN','Infinity','-Infinity') or v_quantity>=100000000000000) then raise exception 'REPLENISHMENT_PURCHASE_INVALID_QUANTITY'; end if;
    if v_order.status='approved' then
      if v_quantity is null then raise exception 'REPLENISHMENT_PURCHASE_NOT_MARKED'; end if;
      update public.market_replenishment_orders set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now() where id=p_order_id;
      v_order.status := 'in_progress';
    end if;
    update public.market_replenishment_purchase_declarations set purchased_quantity=v_quantity,purchase_version=purchase_version+1,updated_at=now() where id=v_declaration.id;
    update public.market_replenishment_operation_lines l set started_at=coalesce(l.started_at,now()),started_by=coalesce(l.started_by,auth.uid())
      from public.market_replenishment_order_allocations a join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
      where l.allocation_id=a.id and l.market_account_id=p_market_account_id and l.order_id=p_order_id and l.operation_type='purchase' and i.product_id=v_declaration.product_id;
  end loop;
  perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'PURCHASE_DECLARATION_CHANGED',p_request_id,null,null,null,null,v_metadata);
end;
$$;

create function public.market_link_replenishment_purchase_nf(
  p_market_account_id uuid,p_order_id uuid,p_declaration_id uuid,p_purchase_item_id uuid,p_quantity numeric,p_request_id uuid
) returns void language plpgsql security definer set search_path=public as $$
declare v_declaration public.market_replenishment_purchase_declarations; v_item public.market_purchase_items;
  v_metadata jsonb := jsonb_build_object('declarationId',p_declaration_id,'purchaseItemId',p_purchase_item_id,'quantity',p_quantity);
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
  perform 1 from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id and status='in_progress' for update;
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

create function public.market_get_replenishment_purchasing(p_market_account_id uuid,p_order_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
  perform public.market_replenishment_assert_access_internal(p_market_account_id);
  if not exists(select 1 from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id) then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
  with nf as (
    select i.id,i.market_product_id,i.stock_quantity,i.stock_entry_status,p.id purchase_id,p.invoice_number,s.name warehouse_name,
      coalesce((select sum(x.quantity) from public.market_replenishment_purchase_nf_links x where x.purchase_item_id=i.id and x.market_account_id=p_market_account_id),0) linked_total,
      exists(select 1 from public.market_stock_movements m where m.market_account_id=p_market_account_id and m.market_store_id=s.id and m.product_id=i.market_product_id and m.movement_type='PURCHASE' and m.direction='IN' and m.reference_type='PURCHASE' and m.reference_id=p.id and m.reference_item_id=i.id and m.quantity=i.stock_quantity)
        and i.stock_entry_status='received' and p.status in ('receiving','completed') received
    from public.market_purchase_items i join public.market_purchases p on p.id=i.market_purchase_id and p.market_account_id=i.market_account_id join public.market_stores s on s.id=p.destination_store_id and s.market_account_id=p.market_account_id
    where i.market_account_id=p_market_account_id and s.store_type='warehouse' and public.market_can_access_store(s.id) and p.invoice_key is not null and btrim(p.invoice_key)<>'' and p.status not in ('cancelled','failed') and i.reconciliation_status in ('matched_auto','matched_manual','mapped') and i.stock_unit is not null and i.stock_entry_status not in ('ignored','blocked') and i.stock_quantity>0
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',d.id,'productId',d.product_id,'productName',pr.name,'targetQuantity',d.target_quantity,'purchasedQuantity',d.purchased_quantity,'version',d.purchase_version,
    'stores',(select coalesce(jsonb_agg(jsonb_build_object('storeId',store_rows.store_id,'storeName',store_rows.store_name,'targetQuantity',store_rows.target_quantity) order by store_rows.store_name),'[]'::jsonb) from (select s.id store_id,s.name store_name,sum(l.target_quantity) target_quantity from public.market_replenishment_operation_lines l join public.market_replenishment_order_allocations a on a.id=l.allocation_id and a.market_account_id=l.market_account_id join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id join public.market_stores s on s.id=a.store_id and s.market_account_id=a.market_account_id where l.order_id=p_order_id and l.market_account_id=p_market_account_id and l.operation_type='purchase' and i.product_id=d.product_id and l.approval_revision=d.approval_revision group by s.id,s.name) store_rows),
    'linked',exists(select 1 from public.market_replenishment_purchase_nf_links x where x.purchase_declaration_id=d.id),
    'coveredQuantity',coalesce((select sum(x.quantity) from public.market_replenishment_purchase_nf_links x join nf on nf.id=x.purchase_item_id where x.purchase_declaration_id=d.id and nf.linked_total<=nf.stock_quantity),0),
    'receivedQuantity',coalesce((select sum(x.quantity) from public.market_replenishment_purchase_nf_links x join nf on nf.id=x.purchase_item_id where x.purchase_declaration_id=d.id and nf.linked_total<=nf.stock_quantity and nf.received),0),
    'invoices',coalesce((select jsonb_agg(jsonb_build_object('itemId',nf.id,'invoiceNumber',nf.invoice_number,'warehouseName',nf.warehouse_name,'availableQuantity',nf.stock_quantity-nf.linked_total,'received',nf.received)) from nf where nf.market_product_id=d.product_id and nf.stock_quantity>nf.linked_total and not exists(select 1 from public.market_replenishment_purchase_nf_links x where x.purchase_declaration_id=d.id and x.purchase_item_id=nf.id)), '[]'::jsonb)
  ) order by pr.name,d.id),'[]'::jsonb) into v_result
  from public.market_replenishment_purchase_declarations d join public.market_products pr on pr.id=d.product_id and pr.market_account_id=d.market_account_id
  where d.order_id=p_order_id and d.market_account_id=p_market_account_id and d.approval_revision=(select approval_revision from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id);
  return v_result;
end;
$$;

revoke all on function public.market_set_replenishment_purchased(uuid,uuid,jsonb,uuid) from public,anon;
revoke all on function public.market_link_replenishment_purchase_nf(uuid,uuid,uuid,uuid,numeric,uuid) from public,anon;
revoke all on function public.market_get_replenishment_purchasing(uuid,uuid) from public,anon;
grant execute on function public.market_set_replenishment_purchased(uuid,uuid,jsonb,uuid) to authenticated;
grant execute on function public.market_link_replenishment_purchase_nf(uuid,uuid,uuid,uuid,numeric,uuid) to authenticated;
grant execute on function public.market_get_replenishment_purchasing(uuid,uuid) to authenticated;
commit;
