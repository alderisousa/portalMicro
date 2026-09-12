-- Reposicao: contrato de ciclo de vida, metas por allocation e eventos.
-- Sem execucao fisica, recebimento de NF ou movimentos de estoque.
begin;

-- Bloqueia com diagnostico em vez de converter estados/dados existentes.
lock table public.market_replenishment_orders in share row exclusive mode;
do $$
begin
    if exists (select 1 from public.market_replenishment_orders where status not in ('draft','cancelled')) then
        raise exception 'REPLENISHMENT_CONTRACT_PREFLIGHT: existem orders aprovadas, concluidas ou com status legado; revisar explicitamente antes de aplicar.';
    end if;
    if exists (select 1 from public.market_replenishment_orders where status = 'draft' group by market_account_id having count(*) > 1) then
        raise exception 'REPLENISHMENT_CONTRACT_PREFLIGHT: mais de uma order ativa por conta; resolver explicitamente antes de aplicar.';
    end if;
    if exists (
        select 1 from public.market_replenishment_order_items i
        join public.market_replenishment_orders o on o.id=i.order_id
        left join public.market_replenishment_order_allocations a on a.order_item_id=i.id
        where o.status='draft' and (i.purchased_quantity > 0 or a.allocated_quantity > 0 or a.dispatched_quantity > 0 or a.received_quantity > 0)
    ) then
        raise exception 'REPLENISHMENT_CONTRACT_PREFLIGHT: draft com evidencia operacional existente.';
    end if;
end;
$$;

alter table public.market_replenishment_orders
    add column started_at timestamptz null,
    add column started_by uuid null references auth.users(id) on delete set null,
    add column approval_revision integer not null default 0,
    drop constraint market_replenishment_orders_status_check,
    add constraint market_replenishment_orders_status_check check (status in ('draft','approved','in_progress','completed','cancelled')),
    add constraint market_replenishment_orders_revision_check check (approval_revision >= 0),
    add constraint market_replenishment_orders_started_check check (
        (status in ('draft','approved','cancelled') and started_at is null)
        or (status in ('in_progress','completed') and started_at is not null)
    ),
    add constraint market_replenishment_orders_approved_contract_check check (
        status in ('draft','cancelled') or (approved_at is not null and approval_revision > 0)
    );

-- A unicidade ativa e DIFERIDA: supersede precisa criar a nova draft antes
-- de cancelar a antiga. Todos os escritores serializam pela mesma conta.
-- O constraint trigger abaixo rejeita qualquer duplicidade no COMMIT.
create index idx_market_replenishment_orders_active_account
    on public.market_replenishment_orders(market_account_id)
    where status in ('draft','approved','in_progress');

alter table public.market_replenishment_order_allocations
    add constraint market_replenishment_allocations_id_account_key unique(id,market_account_id);

create table public.market_replenishment_operation_lines (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    order_id uuid not null,
    allocation_id uuid not null,
    approval_revision integer not null check (approval_revision > 0),
    operation_type text not null check (operation_type in ('warehouse','purchase')),
    target_quantity numeric(18,4) not null check (target_quantity > 0 and target_quantity = trunc(target_quantity) and target_quantity::text not in ('NaN','Infinity','-Infinity')),
    confirmed_quantity numeric(18,4) not null default 0 check (confirmed_quantity >= 0 and confirmed_quantity <= target_quantity and confirmed_quantity = trunc(confirmed_quantity)),
    started_at timestamptz null,
    started_by uuid null references auth.users(id) on delete set null,
    completed_at timestamptz null,
    completed_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    created_by uuid null references auth.users(id) on delete set null,
    updated_at timestamptz not null default now(),
    unique (allocation_id, operation_type, approval_revision),
    unique (id, market_account_id, order_id),
    foreign key (order_id, market_account_id) references public.market_replenishment_orders(id, market_account_id) on delete restrict,
    foreign key (allocation_id, market_account_id) references public.market_replenishment_order_allocations(id, market_account_id) on delete restrict,
    check (confirmed_quantity = 0 or started_at is not null),
    check ((confirmed_quantity = target_quantity and completed_at is not null) or (confirmed_quantity < target_quantity and completed_at is null))
);
create index idx_market_replenishment_operation_lines_order
    on public.market_replenishment_operation_lines(market_account_id, order_id, approval_revision, operation_type);

create table public.market_replenishment_order_events (
    id uuid primary key default gen_random_uuid(),
    sequence bigint generated always as identity unique,
    market_account_id uuid not null,
    order_id uuid not null,
    event_type text not null check (event_type in (
        'ORDER_CREATED','ORDER_APPROVED','ORDER_REOPENED','ORDER_CANCELLED','ORDER_SUPERSEDED',
        'WAREHOUSE_SEPARATION_STARTED','WAREHOUSE_QUANTITY_CONFIRMED','WAREHOUSE_SEPARATION_COMPLETED',
        'PURCHASE_STARTED','PURCHASE_QUANTITY_CONFIRMED','PURCHASE_COMPLETED','ORDER_COMPLETED'
    )),
    occurred_at timestamptz not null default now(),
    actor_user_id uuid null references auth.users(id) on delete restrict,
    actor_kind text not null check (actor_kind in ('user','service')),
    approval_revision integer not null check (approval_revision >= 0),
    operation_line_id uuid null,
    from_status text null check (from_status in ('draft','approved','in_progress','completed','cancelled')),
    to_status text null check (to_status in ('draft','approved','in_progress','completed','cancelled')),
    request_id uuid not null,
    request_ordinal integer not null default 1 check (request_ordinal > 0),
    quantity_delta numeric(18,4) null check (quantity_delta > 0 and quantity_delta = trunc(quantity_delta) and quantity_delta::text not in ('NaN','Infinity','-Infinity')),
    reason text null,
    related_order_id uuid null,
    metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
    foreign key (order_id, market_account_id) references public.market_replenishment_orders(id, market_account_id) on delete restrict,
    foreign key (operation_line_id, market_account_id, order_id) references public.market_replenishment_operation_lines(id, market_account_id, order_id) on delete restrict,
    foreign key (related_order_id, market_account_id) references public.market_replenishment_orders(id, market_account_id) on delete restrict,
    unique (market_account_id, request_id, request_ordinal),
    check (event_type not in ('ORDER_CANCELLED','ORDER_SUPERSEDED') or nullif(btrim(reason),'') is not null),
    check (event_type <> 'ORDER_SUPERSEDED' or (related_order_id is not null and related_order_id <> order_id)),
    check (event_type not in ('WAREHOUSE_QUANTITY_CONFIRMED','PURCHASE_QUANTITY_CONFIRMED') or (operation_line_id is not null and quantity_delta is not null))
);
create index idx_market_replenishment_order_events_order
    on public.market_replenishment_order_events(market_account_id, order_id, sequence);

comment on table public.market_replenishment_operation_lines is
'Metas aprovadas por allocation e frente. Purchase confirma aquisicao, nunca recebimento fisico. IDs estaveis permitem futuro vinculo N:N com itens de NF recebidos no Galpao, sem FK prematura. Em warehouse, confirmed_quantity mede recebimento pela loja; separar apenas registra inicio/evento, sem incrementar esse contador. Warehouse so conclui no recebimento pela loja, nunca apenas na separacao.';

create or replace function public.market_replenishment_assert_access_internal(p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if p_account is null or not exists (select 1 from public.market_accounts where id=p_account and status in ('pilot','active')) then
        raise exception 'REPLENISHMENT_ORDER_ACCOUNT_UNAVAILABLE';
    end if;
    if auth.uid() is not null and not exists (
        select 1 from public.market_account_members m
        where m.market_account_id=p_account and m.user_id=auth.uid() and m.status='active'
          and (m.role in ('owner','admin') or (m.role='manager' and m.all_stores))
    ) then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
end;
$$;

create or replace function public.market_replenishment_has_started_internal(p_account uuid, p_order uuid)
returns boolean language sql stable set search_path = public as $$
    select exists (select 1 from public.market_replenishment_orders where id=p_order and market_account_id=p_account and started_at is not null)
    or exists (select 1 from public.market_replenishment_operation_lines where order_id=p_order and market_account_id=p_account and (started_at is not null or confirmed_quantity > 0))
    or exists (select 1 from public.market_replenishment_order_events where order_id=p_order and market_account_id=p_account and event_type in (
        'WAREHOUSE_SEPARATION_STARTED','WAREHOUSE_QUANTITY_CONFIRMED','WAREHOUSE_SEPARATION_COMPLETED',
        'PURCHASE_STARTED','PURCHASE_QUANTITY_CONFIRMED','PURCHASE_COMPLETED','ORDER_COMPLETED'
    ));
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
            or (old.status='in_progress' and new.status='completed')) then
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
create trigger trg_market_replenishment_order_contract before insert or update on public.market_replenishment_orders
for each row execute function public.market_replenishment_guard_order_internal();

create or replace function public.market_replenishment_one_active_internal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if (select count(*) from public.market_replenishment_orders where market_account_id=new.market_account_id and status in ('draft','approved','in_progress')) > 1 then
        raise exception 'REPLENISHMENT_ORDER_ACTIVE_CONFLICT';
    end if;
    return null;
end;
$$;
create constraint trigger trg_market_replenishment_one_active after insert or update on public.market_replenishment_orders
    deferrable initially deferred for each row execute function public.market_replenishment_one_active_internal();

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
        if new.confirmed_quantity < old.confirmed_quantity or (old.started_at is not null and new.started_at is distinct from old.started_at) then
            raise exception 'REPLENISHMENT_OPERATION_PROGRESS_IMMUTABLE';
        end if;
        if v_order.status <> 'in_progress' or new.approval_revision <> v_order.approval_revision then raise exception 'REPLENISHMENT_OPERATION_INVALID_REVISION'; end if;
    end if;
    new.updated_at := now();
    return new;
end;
$$;
create trigger trg_market_replenishment_operation_guard before insert or update or delete on public.market_replenishment_operation_lines
for each row execute function public.market_replenishment_guard_line_internal();

create or replace function public.market_replenishment_guard_event_internal()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    if tg_op <> 'INSERT' then raise exception 'REPLENISHMENT_EVENT_APPEND_ONLY'; end if;
    new.occurred_at := now();
    new.actor_user_id := auth.uid();
    new.actor_kind := case when auth.uid() is null then 'service' else 'user' end;
    return new;
end;
$$;
create trigger trg_market_replenishment_event_guard before insert or update or delete on public.market_replenishment_order_events
for each row execute function public.market_replenishment_guard_event_internal();

create or replace function public.market_replenishment_emit_event_internal(
    p_account uuid, p_order uuid, p_event text, p_request uuid,
    p_from text, p_to text, p_reason text, p_related uuid, p_metadata jsonb, p_ordinal integer default 1
) returns void language plpgsql set search_path = public as $$
begin
    insert into public.market_replenishment_order_events (
        market_account_id,order_id,event_type,approval_revision,request_id,request_ordinal,
        from_status,to_status,reason,related_order_id,metadata,actor_kind
    ) select p_account,p_order,p_event,o.approval_revision,p_request,p_ordinal,p_from,p_to,p_reason,p_related,p_metadata,'service'
      from public.market_replenishment_orders o where o.id=p_order and o.market_account_id=p_account;
end;
$$;

create or replace function public.market_replenishment_request_replayed_internal(
    p_account uuid,p_order uuid,p_request uuid,p_event text,p_metadata jsonb
) returns boolean language plpgsql set search_path = public as $$
declare v_event public.market_replenishment_order_events;
begin
    if p_request is null then raise exception 'REPLENISHMENT_ORDER_REQUEST_REQUIRED'; end if;
    select * into v_event from public.market_replenishment_order_events
    where market_account_id=p_account and request_id=p_request and request_ordinal=1;
    if not found then return false; end if;
    if v_event.order_id <> p_order or v_event.event_type <> p_event or v_event.metadata <> p_metadata
       or v_event.actor_user_id is distinct from auth.uid() then
        raise exception 'REPLENISHMENT_ORDER_REQUEST_CONFLICT';
    end if;
    return true;
end;
$$;

create or replace function public.market_replenishment_validate_plan_internal(p_account uuid,p_order uuid)
returns void language plpgsql set search_path = public as $$
begin
    if exists (
        select 1 from public.market_replenishment_order_items i
        where i.order_id=p_order and i.market_account_id=p_account and i.status <> 'cancelled'
        and not exists (select 1 from public.market_replenishment_order_allocations a where a.order_item_id=i.id and a.market_account_id=p_account and a.status <> 'cancelled')
    ) then raise exception 'REPLENISHMENT_ORDER_ALLOCATION_REQUIRED'; end if;
    if exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where i.order_id=p_order and i.market_account_id=p_account and i.status <> 'cancelled' and a.status <> 'cancelled'
        and (coalesce(a.adjusted_quantity,a.suggested_quantity) is null or a.warehouse_allocated_quantity is null or a.purchase_needed_quantity is null
            or a.warehouse_allocated_quantity <> trunc(a.warehouse_allocated_quantity)
            or a.purchase_needed_quantity <> trunc(a.purchase_needed_quantity)
            or a.warehouse_allocated_quantity::text in ('NaN','Infinity','-Infinity')
            or a.purchase_needed_quantity::text in ('NaN','Infinity','-Infinity')
            or coalesce(a.adjusted_quantity,a.suggested_quantity) <> a.warehouse_allocated_quantity+a.purchase_needed_quantity)
    ) then raise exception 'REPLENISHMENT_ORDER_REVIEW_PENDING'; end if;
    if exists (
        select 1 from public.market_replenishment_order_items i
        join lateral (
            select sum(coalesce(a.adjusted_quantity,a.suggested_quantity)) need,
                sum(a.warehouse_allocated_quantity) warehouse, sum(a.purchase_needed_quantity) purchase
            from public.market_replenishment_order_allocations a
            where a.order_item_id=i.id and a.market_account_id=p_account and a.status <> 'cancelled'
        ) totals on true
        where i.order_id=p_order and i.market_account_id=p_account and i.status <> 'cancelled'
          and (i.total_suggested_quantity is distinct from totals.need
              or i.suggested_purchase_quantity is distinct from totals.purchase
              or (i.adjusted_purchase_quantity is not null and i.adjusted_purchase_quantity <> totals.purchase)
              or totals.warehouse > greatest(coalesce(i.warehouse_stock_snapshot,0),0))
    ) then raise exception 'REPLENISHMENT_ORDER_ALLOCATION_REVIEW_REQUIRED'; end if;
end;
$$;

-- A sugestao original e preservada; adjusted_quantity passa a ser a necessidade
-- explicitamente revisada da loja. Nao ha redistribuicao entre lojas.
alter table public.market_replenishment_order_allocations
    drop constraint market_replenishment_order_allocations_source_split_check,
    add constraint market_replenishment_order_allocations_source_split_check check (
        (coalesce(adjusted_quantity,suggested_quantity) is null and warehouse_allocated_quantity is null and purchase_needed_quantity is null)
        or (coalesce(adjusted_quantity,suggested_quantity) is not null and warehouse_allocated_quantity is not null and purchase_needed_quantity is not null
            and warehouse_allocated_quantity <= coalesce(adjusted_quantity,suggested_quantity)
            and coalesce(adjusted_quantity,suggested_quantity) = warehouse_allocated_quantity + purchase_needed_quantity)
    ) not valid;

create or replace function public.market_update_replenishment_allocation_review(
    p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,
    p_warehouse_quantity numeric,p_purchase_quantity numeric
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders; v_item uuid; v_w numeric; v_p numeric;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if v_order.status <> 'draft' then raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT'; end if;
    if p_warehouse_quantity is null or p_purchase_quantity is null or p_warehouse_quantity < 0 or p_purchase_quantity < 0
       or p_warehouse_quantity::text in ('NaN','Infinity','-Infinity') or p_purchase_quantity::text in ('NaN','Infinity','-Infinity') then
        raise exception 'REPLENISHMENT_ORDER_INVALID_QUANTITY';
    end if;
    v_w := ceil(p_warehouse_quantity); v_p := ceil(p_purchase_quantity);
    select i.id into v_item from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    where a.id=p_allocation_id and i.order_id=p_order_id and i.market_account_id=p_market_account_id and a.status <> 'cancelled' and i.status <> 'cancelled';
    if not found then raise exception 'REPLENISHMENT_ORDER_ALLOCATION_NOT_FOUND'; end if;
    if v_w + coalesce((select sum(warehouse_allocated_quantity) from public.market_replenishment_order_allocations where order_item_id=v_item and id<>p_allocation_id and status<>'cancelled'),0)
        > (select greatest(coalesce(warehouse_stock_snapshot,0),0) from public.market_replenishment_order_items where id=v_item) then
        raise exception 'REPLENISHMENT_ORDER_WAREHOUSE_EXCEEDED';
    end if;
    update public.market_replenishment_order_allocations set adjusted_quantity=v_w+v_p,warehouse_allocated_quantity=v_w,purchase_needed_quantity=v_p,updated_at=now()
    where id=p_allocation_id and market_account_id=p_market_account_id;
    update public.market_replenishment_order_items i set
        total_suggested_quantity=t.need,suggested_purchase_quantity=t.purchase,adjusted_purchase_quantity=null,updated_at=now()
    from (
        select case when bool_or(coalesce(adjusted_quantity,suggested_quantity) is null) then null else sum(coalesce(adjusted_quantity,suggested_quantity)) end need,
            case when bool_or(purchase_needed_quantity is null) then null else sum(purchase_needed_quantity) end purchase
        from public.market_replenishment_order_allocations where order_item_id=v_item and market_account_id=p_market_account_id and status<>'cancelled'
    ) t where i.id=v_item and i.market_account_id=p_market_account_id;
    update public.market_replenishment_orders set updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    return p_allocation_id;
end;
$$;

-- Mantem a assinatura para clientes antigos, mas impede revisao consolidada.
create or replace function public.market_update_replenishment_order_item_quantity(
    p_market_account_id uuid,p_order_id uuid,p_order_item_id uuid,p_adjusted_purchase_quantity numeric
) returns uuid language plpgsql security definer set search_path = public as $$
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    raise exception 'REPLENISHMENT_ORDER_ALLOCATION_REVIEW_REQUIRED: revise a allocation da loja.';
end;
$$;

drop function public.market_approve_replenishment_order(uuid,uuid);
create function public.market_approve_replenishment_order(
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
    return p_order_id;
end;
$$;

create or replace function public.market_reopen_replenishment_order(
    p_market_account_id uuid,p_order_id uuid,p_request_id uuid default gen_random_uuid()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'ORDER_REOPENED','{}') then return p_order_id; end if;
    if v_order.status <> 'approved' then raise exception 'REPLENISHMENT_ORDER_NOT_APPROVED'; end if;
    if public.market_replenishment_has_started_internal(p_market_account_id,p_order_id) then raise exception 'REPLENISHMENT_ORDER_ALREADY_STARTED'; end if;
    update public.market_replenishment_orders set status='draft',approved_at=null,approved_by=null,updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_REOPENED',p_request_id,'approved','draft',null,null,'{}');
    return p_order_id;
end;
$$;

create or replace function public.market_cancel_replenishment_order(
    p_market_account_id uuid,p_order_id uuid,p_reason text,p_request_id uuid default gen_random_uuid()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders; v_meta jsonb;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    if nullif(btrim(p_reason),'') is null then raise exception 'REPLENISHMENT_ORDER_REASON_REQUIRED'; end if;
    v_meta := jsonb_build_object('reason',p_reason);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'ORDER_CANCELLED',v_meta) then return p_order_id; end if;
    if v_order.status not in ('draft','approved') or public.market_replenishment_has_started_internal(p_market_account_id,p_order_id) then raise exception 'REPLENISHMENT_ORDER_CANNOT_CANCEL'; end if;
    update public.market_replenishment_orders set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancellation_reason=p_reason,updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_CANCELLED',p_request_id,v_order.status,'cancelled',p_reason,null,v_meta);
    return p_order_id;
end;
$$;

create or replace function public.market_replenishment_order_contract_internal(p_account uuid,p_order uuid)
returns jsonb language sql stable set search_path = public as $$
    with base as (
        select o.*,r.reference_date source_date,r.started_at source_started,
            public.market_replenishment_has_started_internal(p_account,p_order) has_started
        from public.market_replenishment_orders o
        join public.market_replenishment_runs r on r.id=o.run_id and r.market_account_id=o.market_account_id
        where o.id=p_order and o.market_account_id=p_account
    ), latest as (
        select id,reference_date,started_at from public.market_replenishment_runs
        where market_account_id=p_account and status='completed' and is_effective
        order by reference_date desc,started_at desc,id desc limit 1
    ), state as (
        select b.*,l.id latest_id,coalesce((l.reference_date,l.started_at,l.id)>(b.source_date,b.source_started,b.run_id),false) stale
        from base b left join latest l on true
    )
    select jsonb_build_object(
        'sourceRunId',s.run_id,'latestEligibleRunId',s.latest_id,'isStale',s.stale,
        'canReopen',s.status='approved' and not s.has_started,
        'canSupersede',s.status in ('draft','approved') and not s.has_started and s.stale
            and exists (select 1 from public.market_replenishment_candidates c where c.market_account_id=p_account and c.run_id=s.latest_id and c.priority_level in ('critical','high','medium'))
            and not exists (select 1 from public.market_replenishment_orders x where x.run_id=s.latest_id and x.market_account_id=p_account and x.status<>'cancelled'),
        'approvalRevision',s.approval_revision,'startedAt',s.started_at,
        'warehouse',f.warehouse,'purchase',f.purchase
    ) from state s cross join lateral (
        select jsonb_object_agg(kind,summary)->'warehouse' warehouse,jsonb_object_agg(kind,summary)->'purchase' purchase
        from (
            select t.kind,jsonb_build_object(
                'applicable',count(l.id)>0,'totalTarget',coalesce(sum(l.target_quantity),0),'totalConfirmed',coalesce(sum(l.confirmed_quantity),0),
                'pendingLines',count(l.id) filter (where l.confirmed_quantity<l.target_quantity),
                'completedLines',count(l.id) filter (where l.confirmed_quantity=l.target_quantity),
                'status',case when count(l.id)=0 then 'not_applicable'
                    when bool_and(l.confirmed_quantity=l.target_quantity) then 'completed'
                    when bool_or(l.confirmed_quantity>0) then 'in_progress' else 'pending' end
            ) summary
            from (values ('warehouse'),('purchase')) t(kind)
            left join public.market_replenishment_operation_lines l on l.market_account_id=p_account and l.order_id=p_order
                and l.approval_revision=s.approval_revision and l.operation_type=t.kind and s.status<>'draft'
            group by t.kind
        ) q
    ) f;
$$;

create or replace function public.market_generate_replenishment_order_draft(p_market_account_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_run uuid;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select id into v_order from public.market_replenishment_orders where market_account_id=p_market_account_id and status in ('draft','approved','in_progress') for update;
    if found then return v_order; end if;
    select id into v_run from public.market_replenishment_runs where market_account_id=p_market_account_id and status='completed' and is_effective
    order by reference_date desc,started_at desc,id desc limit 1;
    if not found then raise exception 'REPLENISHMENT_ORDER_EFFECTIVE_RUN_NOT_FOUND'; end if;
    return public.market_materialize_replenishment_order_draft_internal(p_market_account_id,v_run);
end;
$$;

create or replace function public.market_supersede_replenishment_order(
    p_market_account_id uuid,p_order_id uuid,p_request_id uuid default gen_random_uuid()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders; v_contract jsonb; v_new uuid;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'ORDER_SUPERSEDED','{}') then
        return (select related_order_id from public.market_replenishment_order_events where market_account_id=p_market_account_id and request_id=p_request_id and request_ordinal=1);
    end if;
    v_contract := public.market_replenishment_order_contract_internal(p_market_account_id,p_order_id);
    if not (v_contract->>'canSupersede')::boolean then raise exception 'REPLENISHMENT_ORDER_CANNOT_SUPERSEDE'; end if;
    v_new := public.market_materialize_replenishment_order_draft_internal(p_market_account_id,(v_contract->>'latestEligibleRunId')::uuid);
    -- A antiga so e cancelada depois que a nova foi integralmente materializada.
    update public.market_replenishment_orders set status='cancelled',cancelled_at=now(),cancelled_by=auth.uid(),cancellation_reason='Substituida por nova analise',updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_SUPERSEDED',p_request_id,v_order.status,'cancelled','Substituida por nova analise',v_new,'{}');
    return v_new;
end;
$$;

create or replace function public.market_complete_replenishment_order_internal(p_account uuid,p_order uuid,p_request uuid)
returns boolean language plpgsql set search_path = public as $$
declare v_order public.market_replenishment_orders; v_ordinal integer;
begin
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_account::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order and market_account_id=p_account for update;
    if not found or v_order.status<>'in_progress' then return false; end if;
    if not exists (select 1 from public.market_replenishment_operation_lines where order_id=p_order and market_account_id=p_account and approval_revision=v_order.approval_revision)
       or exists (select 1 from public.market_replenishment_operation_lines where order_id=p_order and market_account_id=p_account and approval_revision=v_order.approval_revision and confirmed_quantity<target_quantity) then return false; end if;
    perform public.market_replenishment_validate_plan_internal(p_account,p_order);
    if p_request is null or exists (
        select 1 from public.market_replenishment_order_events where market_account_id=p_account and request_id=p_request
        and (order_id<>p_order or actor_user_id is distinct from auth.uid())
    ) then raise exception 'REPLENISHMENT_ORDER_REQUEST_CONFLICT'; end if;
    select coalesce(max(request_ordinal),0)+1 into v_ordinal from public.market_replenishment_order_events where market_account_id=p_account and request_id=p_request;
    update public.market_replenishment_orders set status='completed',completed_at=now(),completed_by=auth.uid(),updated_at=now(),updated_by=auth.uid() where id=p_order;
    perform public.market_replenishment_emit_event_internal(p_account,p_order,'ORDER_COMPLETED',p_request,'in_progress','completed',null,null,'{}',v_ordinal);
    return true;
end;
$$;

create or replace function public.market_replenishment_guard_review_internal()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_account uuid; v_status text;
begin
    if tg_table_name='market_replenishment_order_items' then
        if tg_op='UPDATE' and (new.id,new.order_id,new.market_account_id,new.product_id) is distinct from (old.id,old.order_id,old.market_account_id,old.product_id) then
            raise exception 'REPLENISHMENT_REVIEW_IDENTITY_IMMUTABLE';
        end if;
        if tg_op='DELETE' then v_order:=old.order_id; v_account:=old.market_account_id;
        else v_order:=new.order_id; v_account:=new.market_account_id; end if;
    else
        if tg_op='UPDATE' and (new.id,new.order_item_id,new.market_account_id,new.store_id,new.candidate_id) is distinct from (old.id,old.order_item_id,old.market_account_id,old.store_id,old.candidate_id) then
            raise exception 'REPLENISHMENT_REVIEW_IDENTITY_IMMUTABLE';
        end if;
        if tg_op='DELETE' then
            select order_id,market_account_id into v_order,v_account from public.market_replenishment_order_items where id=old.order_item_id;
        else
            select order_id,market_account_id into v_order,v_account from public.market_replenishment_order_items where id=new.order_item_id;
        end if;
    end if;
    select status into v_status from public.market_replenishment_orders where id=v_order and market_account_id=v_account for update;
    if v_status is distinct from 'draft' then raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT'; end if;
    if tg_op='DELETE' then return old; end if;
    return new;
end;
$$;
create trigger trg_market_replenishment_items_review_guard before insert or update or delete on public.market_replenishment_order_items
for each row execute function public.market_replenishment_guard_review_internal();
create trigger trg_market_replenishment_allocations_review_guard before insert or update or delete on public.market_replenishment_order_allocations
for each row execute function public.market_replenishment_guard_review_internal();

-- Integridade final da aprovacao/inicio/conclusao, inclusive em comandos
-- administrativos: a ordem das escritas dentro da transacao e flexivel.
create or replace function public.market_replenishment_lifecycle_consistency_internal()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders;
begin
    select * into v_order from public.market_replenishment_orders where id=new.id;
    if not found or v_order.status in ('draft','cancelled') then return null; end if;
    perform public.market_replenishment_validate_plan_internal(v_order.market_account_id,v_order.id);
    if not exists (select 1 from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision) then
        raise exception 'REPLENISHMENT_ORDER_NO_OPERATION';
    end if;
    if exists (
        select 1 from (
            select a.id allocation_id,t.kind,t.quantity from public.market_replenishment_order_allocations a
            join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
            cross join lateral (values ('warehouse',a.warehouse_allocated_quantity),('purchase',a.purchase_needed_quantity)) t(kind,quantity)
            where i.order_id=v_order.id and i.market_account_id=v_order.market_account_id and i.status<>'cancelled' and a.status<>'cancelled' and t.quantity>0
        ) expected
        full join (select * from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision) l
            on l.allocation_id=expected.allocation_id and l.operation_type=expected.kind
        where l.id is null or expected.allocation_id is null or l.target_quantity<>expected.quantity
    ) then raise exception 'REPLENISHMENT_ORDER_TARGET_MISMATCH'; end if;
    if v_order.status in ('in_progress','completed') and not exists (
        select 1 from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision
        and (started_at is not null or confirmed_quantity>0)
    ) then raise exception 'REPLENISHMENT_ORDER_EXECUTION_REQUIRED'; end if;
    if v_order.status='completed' and exists (
        select 1 from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision and confirmed_quantity<target_quantity
    ) then raise exception 'REPLENISHMENT_ORDER_INCOMPLETE'; end if;
    return null;
end;
$$;
create constraint trigger trg_market_replenishment_lifecycle_consistency after insert or update on public.market_replenishment_orders
    deferrable initially deferred for each row execute function public.market_replenishment_lifecycle_consistency_internal();

create or replace function public.market_add_replenishment_order_manual_item(
    p_market_account_id uuid,
    p_order_id uuid,
    p_product_id uuid,
    p_purchase_quantity numeric,
    p_store_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
    v_item_id uuid;
    v_warehouse_stock numeric(18,4);
    v_quantity numeric(18,4);
    v_from_warehouse numeric(18,4);
    v_purchase numeric(18,4);
begin
    if p_market_account_id is null or p_order_id is null or p_product_id is null or p_store_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id, order_id, product_id e store_id sao obrigatorios.';
    end if;

    if p_purchase_quantity is null or p_purchase_quantity < 0 or p_purchase_quantity::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'REPLENISHMENT_ORDER_INVALID_QUANTITY: quantidade manual deve ser maior ou igual a zero.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found or not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para revisar lista consolidada.';
        end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select o.* into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.id = p_order_id
    for update;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_NOT_FOUND: lista nao encontrada.';
    end if;

    if v_order.status <> 'draft' then
        raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT: lista nao esta em revisao.';
    end if;

    if not exists (
        select 1 from public.market_stores s
        where s.id = p_store_id
          and s.market_account_id = p_market_account_id
          and s.store_type = 'store'
          and s.status = 'active'
    ) then
        raise exception 'REPLENISHMENT_ORDER_STORE_UNAVAILABLE: loja nao encontrada ou inativa.';
    end if;

    if not exists (
        select 1
        from public.market_products p
        where p.market_account_id = p_market_account_id
          and p.id = p_product_id
          and p.status = 'active'
    ) then
        raise exception 'REPLENISHMENT_ORDER_PRODUCT_UNAVAILABLE: produto nao encontrado ou inativo.';
    end if;

    if exists (
        select 1
        from public.market_replenishment_order_items oi
        where oi.market_account_id = p_market_account_id
          and oi.order_id = p_order_id
          and oi.product_id = p_product_id
    ) then
        raise exception 'REPLENISHMENT_ORDER_DUPLICATE_PRODUCT: produto ja existe nesta lista.';
    end if;

    -- Mesma fonte e semantica do draft: snapshot desconhecido permanece NULL.
    select sum(b.quantity_on_hand)::numeric(18,4) into v_warehouse_stock
    from public.market_stock_balance b
    join public.market_stores s
      on s.id = b.market_store_id and s.market_account_id = b.market_account_id
    where b.market_account_id = p_market_account_id
      and b.product_id = p_product_id
      and s.store_type = 'warehouse';

    v_quantity := ceil(p_purchase_quantity)::numeric(18,4);
    v_from_warehouse := least(v_quantity, greatest(coalesce(v_warehouse_stock, 0), 0));
    v_purchase := v_quantity - v_from_warehouse;

    insert into public.market_replenishment_order_items (
        order_id,
        market_account_id,
        product_id,
        status,
        source,
        total_suggested_quantity,
        warehouse_stock_snapshot,
        suggested_purchase_quantity,
        adjusted_purchase_quantity
    ) values (
        p_order_id,
        p_market_account_id,
        p_product_id,
        'pending',
        'manual_review',
        v_quantity,
        v_warehouse_stock,
        v_purchase,
        null
    )
    returning id into v_item_id;

    insert into public.market_replenishment_order_allocations (
        order_item_id, market_account_id, store_id, candidate_id, status,
        suggested_quantity, warehouse_allocated_quantity, purchase_needed_quantity
    ) values (
        v_item_id, p_market_account_id, p_store_id, null, 'pending',
        v_quantity, v_from_warehouse, v_purchase
    );

    update public.market_replenishment_orders
    set updated_at = now(),
        updated_by = auth.uid()
    where id = p_order_id
      and market_account_id = p_market_account_id;

    return v_item_id;
end;
$$;
create or replace function public.market_cancel_replenishment_order_item_review(
    p_market_account_id uuid,
    p_order_id uuid,
    p_order_item_id uuid,
    p_cancellation_reason text default 'Retirado durante a revisao pre-compra'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
    v_reason text := nullif(btrim(coalesce(p_cancellation_reason, '')), '');
begin
    if p_market_account_id is null or p_order_id is null or p_order_item_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id, order_id e order_item_id sao obrigatorios.';
    end if;

    if v_reason is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: motivo de retirada e obrigatorio.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found or not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para revisar lista consolidada.';
        end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select o.* into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.id = p_order_id
    for update;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_NOT_FOUND: lista nao encontrada.';
    end if;

    if v_order.status <> 'draft' then
        raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT: lista nao esta em revisao.';
    end if;

    update public.market_replenishment_order_items
    set status = 'cancelled',
        review_cancelled_at = now(),
        review_cancelled_by = auth.uid(),
        review_cancellation_reason = v_reason,
        updated_at = now()
    where market_account_id = p_market_account_id
      and order_id = p_order_id
      and id = p_order_item_id
      and status <> 'cancelled';

    if not found then
        raise exception 'REPLENISHMENT_ORDER_ITEM_NOT_FOUND: item ativo nao encontrado.';
    end if;

    update public.market_replenishment_order_allocations
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = v_reason,
        updated_at = now()
    where market_account_id = p_market_account_id
      and order_item_id = p_order_item_id
      and status <> 'cancelled';

    update public.market_replenishment_orders
    set updated_at = now(),
        updated_by = auth.uid()
    where id = p_order_id
      and market_account_id = p_market_account_id;

    return p_order_item_id;
end;
$$;
create or replace function public.market_materialize_replenishment_order_draft_internal(
    p_market_account_id uuid,
    p_run_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_member public.market_account_members;
    v_run public.market_replenishment_runs;
    v_order_id uuid;
    v_candidate_count integer;
begin
    if p_market_account_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id e obrigatorio.';
    end if;

    if not exists (
        select 1
        from public.market_accounts a
        where a.id = p_market_account_id
          and a.status in ('pilot','active')
    ) then
        raise exception 'REPLENISHMENT_ORDER_ACCOUNT_UNAVAILABLE: conta Market indisponivel.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: vinculo ativo nao encontrado.';
        end if;

        if not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para gerar lista consolidada.';
        end if;
    end if;

    perform pg_advisory_xact_lock(
        hashtextextended(
            'market-replenishment-order-draft:' || p_market_account_id::text,
            0
        )
    );

    select r.* into v_run
    from public.market_replenishment_runs r
    where r.market_account_id = p_market_account_id
      and r.id = p_run_id
      and r.status = 'completed'
      and r.is_effective = true
    order by r.reference_date desc, r.started_at desc, r.id desc
    limit 1;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_EFFECTIVE_RUN_NOT_FOUND: nenhum batch efetivo concluido foi encontrado.';
    end if;

    select o.id into v_order_id
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.run_id = v_run.id
      and o.status <> 'cancelled'
    order by o.created_at
    limit 1;

    if found then
        return v_order_id;
    end if;

    select count(*) into v_candidate_count
    from public.market_replenishment_candidates c
    where c.market_account_id = p_market_account_id
      and c.run_id = v_run.id
          and c.priority_level in ('critical', 'high', 'medium');

    if v_candidate_count = 0 then
        raise exception 'REPLENISHMENT_ORDER_NO_CANDIDATES: o batch efetivo nao possui candidatos selecionados.';
    end if;

    insert into public.market_replenishment_orders (
        market_account_id,
        run_id,
        status,
        created_by,
        updated_by
    )
    values (
        p_market_account_id,
        v_run.id,
        'draft',
        auth.uid(),
        auth.uid()
    )
    returning id into v_order_id;

    with product_totals as (
        select
            c.product_id,

            case
                when count(*) filter (
                    where c.suggested_quantity is null
                ) > 0
                    then null
                else sum(c.suggested_quantity)
            end::numeric(18,4) as total_suggested_quantity

        from public.market_replenishment_candidates c
        where c.market_account_id = p_market_account_id
          and c.run_id = v_run.id
          and c.priority_level in ('critical', 'high', 'medium')
        group by c.product_id
    ),
    warehouse_stock as (
        select
            b.product_id,
            sum(b.quantity_on_hand)::numeric(18,4)
                as warehouse_stock_snapshot
        from public.market_stock_balance b
        join public.market_stores s
          on s.id = b.market_store_id
         and s.market_account_id = b.market_account_id
        where b.market_account_id = p_market_account_id
          and s.store_type = 'warehouse'
        group by b.product_id
    )
    insert into public.market_replenishment_order_items (
        order_id,
        market_account_id,
        product_id,
        status,
        total_suggested_quantity,
        warehouse_stock_snapshot,
        suggested_purchase_quantity
    )
    select
        v_order_id,
        p_market_account_id,
        pt.product_id,
        'pending',
        pt.total_suggested_quantity,
        ws.warehouse_stock_snapshot,

        case
            when pt.total_suggested_quantity is null then null
            else greatest(
                pt.total_suggested_quantity
                - greatest(
                    coalesce(ws.warehouse_stock_snapshot, 0),
                    0
                ),
                0
            )::numeric(18,4)
        end

    from product_totals pt
    left join warehouse_stock ws
      on ws.product_id = pt.product_id;


    with ordered_candidates as (
        select
            c.id as candidate_id,
            c.store_id,
            c.product_id,
            c.suggested_quantity,
            oi.id as order_item_id,

            greatest(
                coalesce(oi.warehouse_stock_snapshot, 0),
                0
            ) as warehouse_available,

            coalesce(
                sum(c.suggested_quantity) over (
                    partition by c.product_id
                    order by
                        case c.priority_level
                            when 'critical' then 1
                            when 'high' then 2
                            when 'medium' then 3
                            else 4
                        end,
                        c.rank_position,
                        c.id
                    rows between unbounded preceding and 1 preceding
                ),
                0
            ) as previous_known_need

        from public.market_replenishment_candidates c

        join public.market_replenishment_order_items oi
          on oi.order_id = v_order_id
         and oi.market_account_id = c.market_account_id
         and oi.product_id = c.product_id

        where c.market_account_id = p_market_account_id
          and c.run_id = v_run.id
          and c.priority_level in ('critical', 'high', 'medium')
    ),
    split as (
        select
            oc.*,

            case
                when oc.suggested_quantity is null then null
                else least(
                    oc.suggested_quantity,
                    greatest(
                        oc.warehouse_available
                        - oc.previous_known_need,
                        0
                    )
                )::numeric(18,4)
            end as warehouse_allocated_quantity

        from ordered_candidates oc
    )
    insert into public.market_replenishment_order_allocations (
        order_item_id,
        market_account_id,
        store_id,
        candidate_id,
        status,
        suggested_quantity,
        warehouse_allocated_quantity,
        purchase_needed_quantity
    )
    select
        s.order_item_id,
        p_market_account_id,
        s.store_id,
        s.candidate_id,
        'pending',
        s.suggested_quantity,
        s.warehouse_allocated_quantity,

        case
            when s.suggested_quantity is null then null
            else (
                s.suggested_quantity
                - s.warehouse_allocated_quantity
            )::numeric(18,4)
        end

    from split s;

    perform public.market_replenishment_emit_event_internal(
        p_market_account_id, v_order_id, 'ORDER_CREATED', gen_random_uuid(),
        null, 'draft', null, null, '{}'::jsonb
    );
    return v_order_id;
end;
$function$;
create or replace function public.market_get_replenishment_order(
    p_market_account_id uuid,
    p_order_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
begin
    if p_market_account_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id e obrigatorio.';
    end if;

    if not exists (
        select 1
        from public.market_accounts a
        where a.id = p_market_account_id
          and a.status in ('pilot','active')
    ) then
        raise exception 'REPLENISHMENT_ORDER_ACCOUNT_UNAVAILABLE: conta Market indisponivel.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: vinculo ativo nao encontrado.';
        end if;

        if not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para ler lista consolidada.';
        end if;
    end if;

    if p_order_id is null then
        select o.* into v_order
        from public.market_replenishment_orders o
        where o.market_account_id = p_market_account_id
          and o.status in ('draft','approved','in_progress')
        order by o.created_at desc, o.id desc
        limit 1;
    else
        select o.* into v_order
        from public.market_replenishment_orders o
        where o.market_account_id = p_market_account_id
          and o.id = p_order_id;
    end if;

    if not found then
        return null;
    end if;

    return public.market_replenishment_order_contract_internal(p_market_account_id, v_order.id) || (
        with order_products as (
            select distinct oi.product_id
            from public.market_replenishment_order_items oi
            where oi.market_account_id = p_market_account_id
              and oi.order_id = v_order.id
        ),
        last_supplier_ranked as (
            select
                i.market_product_id as product_id,
                p.id as purchase_id,
                i.id as purchase_item_id,
                p.supplier_name,
                p.supplier_document,
                p.invoice_number,
                p.invoice_series,
                p.issued_at,
                i.received_at,
                m.occurred_at as operational_at,
                coalesce(m.unit_cost, i.stock_unit_cost) as unit_cost,
                row_number() over (
                    partition by i.market_product_id
                    order by
                        coalesce(p.issued_at, i.received_at, m.occurred_at) desc nulls last,
                        i.received_at desc nulls last,
                        m.occurred_at desc nulls last,
                        i.id desc
                ) as rn
            from order_products op
            join public.market_purchase_items i
              on i.market_account_id = p_market_account_id
             and i.market_product_id = op.product_id
             and i.stock_entry_status = 'received'
            join public.market_purchases p
              on p.id = i.market_purchase_id
             and p.market_account_id = i.market_account_id
             and p.status in ('receiving','completed')
            join public.market_stock_movements m
              on m.market_account_id = i.market_account_id
             and m.movement_type = 'PURCHASE'
             and m.reference_type = 'PURCHASE'
             and m.reference_id = p.id
             and m.reference_item_id = i.id
        ),
        last_supplier as (
            select *
            from last_supplier_ranked
            where rn = 1
        ),
        item_priority as (
            select
                oi.id as order_item_id,
                count(*) filter (where c.priority_level = 'critical') as critical_count,
                count(*) filter (where c.priority_level = 'high') as high_count,
                count(*) filter (where c.priority_level = 'medium') as medium_count,
                count(*) filter (where c.priority_level = 'low') as low_count,
                min(case c.priority_level
                    when 'critical' then 1
                    when 'high' then 2
                    when 'medium' then 3
                    else 4
                end) as priority_sort,
                min(c.rank_position) as best_rank_position
            from public.market_replenishment_order_items oi
            left join public.market_replenishment_order_allocations a
              on a.order_item_id = oi.id
             and a.market_account_id = oi.market_account_id
            left join public.market_replenishment_candidates c
              on c.id = a.candidate_id
             and c.market_account_id = a.market_account_id
            where oi.market_account_id = p_market_account_id
              and oi.order_id = v_order.id
            group by oi.id
        ),
        item_rows as (
            select
                oi.id,
                oi.product_id,
                pr.name as product_name,
                pr.sku,
                pr.ean,
                pr.unit,
                oi.status,
                oi.source,
                oi.total_suggested_quantity,
                oi.warehouse_stock_snapshot,
                oi.suggested_purchase_quantity,
                oi.adjusted_purchase_quantity,
                oi.purchased_quantity,
                oi.warehouse_surplus_quantity,
                oi.review_cancelled_at,
                oi.review_cancelled_by,
                oi.review_cancellation_reason,
                oi.created_at,
                oi.updated_at,
                coalesce(ip.critical_count, 0) as critical_count,
                coalesce(ip.high_count, 0) as high_count,
                coalesce(ip.medium_count, 0) as medium_count,
                coalesce(ip.low_count, 0) as low_count,
                coalesce(ip.priority_sort, 5) as priority_sort,
                ip.best_rank_position,
                ls.purchase_id,
                ls.purchase_item_id,
                ls.supplier_name,
                ls.supplier_document,
                ls.invoice_number,
                ls.invoice_series,
                ls.issued_at,
                ls.received_at,
                ls.operational_at,
                ls.unit_cost
            from public.market_replenishment_order_items oi
            join public.market_products pr
              on pr.id = oi.product_id
             and pr.market_account_id = oi.market_account_id
            left join item_priority ip on ip.order_item_id = oi.id
            left join last_supplier ls on ls.product_id = oi.product_id
            where oi.market_account_id = p_market_account_id
              and oi.order_id = v_order.id
        )
        select jsonb_build_object(
            'order', jsonb_build_object(
                'id', v_order.id,
                'marketAccountId', v_order.market_account_id,
                'runId', v_order.run_id,
                'status', v_order.status,
                'createdAt', v_order.created_at,
                'updatedAt', v_order.updated_at,
                'approvedAt', v_order.approved_at,
                'completedAt', v_order.completed_at,
                'cancelledAt', v_order.cancelled_at
            ),
            'items', coalesce((
                select jsonb_agg(
                    jsonb_build_object(
                        'id', ir.id,
                        'productId', ir.product_id,
                        'productName', ir.product_name,
                        'sku', ir.sku,
                        'ean', ir.ean,
                        'unit', ir.unit,
                        'status', ir.status,
                        'source', ir.source,
                        'totalSuggestedQuantity', ir.total_suggested_quantity,
                        'warehouseStockSnapshot', ir.warehouse_stock_snapshot,
                        'suggestedPurchaseQuantity', ir.suggested_purchase_quantity,
                        'adjustedPurchaseQuantity', ir.adjusted_purchase_quantity,
                        'effectivePurchaseQuantity', coalesce(ir.adjusted_purchase_quantity, ir.suggested_purchase_quantity),
                        'purchasedQuantity', ir.purchased_quantity,
                        'warehouseSurplusQuantity', ir.warehouse_surplus_quantity,
                        'reviewCancelledAt', ir.review_cancelled_at,
                        'reviewCancelledBy', ir.review_cancelled_by,
                        'reviewCancellationReason', ir.review_cancellation_reason,
                        'priority', jsonb_build_object(
                            'criticalCount', ir.critical_count,
                            'highCount', ir.high_count,
                            'mediumCount', ir.medium_count,
                            'lowCount', ir.low_count,
                            'prioritySort', ir.priority_sort,
                            'bestRankPosition', ir.best_rank_position
                        ),
                        'lastSupplier', case
                            when ir.purchase_item_id is null then null
                            else jsonb_build_object(
                                'supplierName', ir.supplier_name,
                                'supplierDocument', ir.supplier_document,
                                'invoiceNumber', ir.invoice_number,
                                'invoiceSeries', ir.invoice_series,
                                'issuedAt', ir.issued_at,
                                'receivedAt', ir.received_at,
                                'operationalAt', ir.operational_at,
                                'unitCost', ir.unit_cost,
                                'purchaseId', ir.purchase_id,
                                'purchaseItemId', ir.purchase_item_id
                            )
                        end,
                        'allocations', coalesce((
                            select jsonb_agg(
                                jsonb_build_object(
                                    'id', a.id,
                                    'storeId', a.store_id,
                                    'storeName', s.name,
                                    'candidateId', a.candidate_id,
                                    'status', a.status,
                                    'suggestedQuantity', a.suggested_quantity,
                                    'adjustedQuantity', a.adjusted_quantity,
                                    'warehouseAllocatedQuantity', a.warehouse_allocated_quantity,
                                    'purchaseNeededQuantity', a.purchase_needed_quantity,
                                    'priorityLevel', c.priority_level,
                                    'rankPosition', c.rank_position
                                )
                                order by
                                    case c.priority_level
                                        when 'critical' then 1
                                        when 'high' then 2
                                        when 'medium' then 3
                                        else 4
                                    end,
                                    c.rank_position,
                                    s.name,
                                    a.id
                            )
                            from public.market_replenishment_order_allocations a
                            join public.market_stores s
                              on s.id = a.store_id
                             and s.market_account_id = a.market_account_id
                            left join public.market_replenishment_candidates c
                              on c.id = a.candidate_id
                             and c.market_account_id = a.market_account_id
                            where a.market_account_id = p_market_account_id
                              and a.order_item_id = ir.id
                        ), '[]'::jsonb)
                    )
                    order by ir.priority_sort, ir.best_rank_position nulls last, ir.product_name, ir.id
                )
                from item_rows ir
            ), '[]'::jsonb)
        )
    );
end;
$$;
alter table public.market_replenishment_operation_lines enable row level security;
alter table public.market_replenishment_order_events enable row level security;
revoke all on public.market_replenishment_operation_lines, public.market_replenishment_order_events from public, anon, authenticated, service_role;
grant select on public.market_replenishment_operation_lines, public.market_replenishment_order_events to authenticated, service_role;
create policy market_replenishment_operation_lines_select on public.market_replenishment_operation_lines for select to authenticated using (
    public.market_is_member(market_account_id) and exists (
        select 1 from public.market_replenishment_order_allocations a
        where a.id=allocation_id and a.market_account_id=market_replenishment_operation_lines.market_account_id
          and public.market_can_access_store(a.store_id)
    )
);
create policy market_replenishment_order_events_select on public.market_replenishment_order_events for select to authenticated using (
    exists (select 1 from public.market_account_members m where m.market_account_id=market_replenishment_order_events.market_account_id
        and m.user_id=auth.uid() and m.status='active'
        and (m.role in ('owner','admin') or (m.role='manager' and m.all_stores)))
);

-- Helpers nao sao endpoints RPC para clientes, inclusive service_role.
do $$
declare r record;
begin
    for r in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and (p.proname like 'market_replenishment_%_internal'
            or p.proname in ('market_materialize_replenishment_order_draft_internal','market_complete_replenishment_order_internal'))
    loop execute format('revoke all on function %s from public, anon, authenticated, service_role',r.signature); end loop;
end;
$$;
revoke all on function public.market_update_replenishment_allocation_review(uuid,uuid,uuid,numeric,numeric) from public,anon;
revoke all on function public.market_approve_replenishment_order(uuid,uuid,uuid) from public,anon;
revoke all on function public.market_reopen_replenishment_order(uuid,uuid,uuid) from public,anon;
revoke all on function public.market_cancel_replenishment_order(uuid,uuid,text,uuid) from public,anon;
revoke all on function public.market_supersede_replenishment_order(uuid,uuid,uuid) from public,anon;
grant execute on function public.market_update_replenishment_allocation_review(uuid,uuid,uuid,numeric,numeric) to authenticated,service_role;
grant execute on function public.market_approve_replenishment_order(uuid,uuid,uuid) to authenticated,service_role;
grant execute on function public.market_reopen_replenishment_order(uuid,uuid,uuid) to authenticated,service_role;
grant execute on function public.market_cancel_replenishment_order(uuid,uuid,text,uuid) to authenticated,service_role;
grant execute on function public.market_supersede_replenishment_order(uuid,uuid,uuid) to authenticated,service_role;

commit;
