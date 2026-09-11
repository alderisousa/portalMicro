-- GiroMicro Market
-- Reposicao Inteligente / Lista de Compras
-- Migration: backend da revisao pre-compra
-- Data: 2026-09-10
--
-- Escopo:
-- - identifica origem dos itens consolidados da lista;
-- - permite ajustar quantidade em draft;
-- - permite incluir produto manualmente durante revisao;
-- - permite cancelar logicamente item durante revisao;
-- - aprova a lista draft para a proxima fase.

begin;

alter table public.market_replenishment_order_items
    add column if not exists source text not null default 'batch',
    add column if not exists review_cancelled_at timestamptz null,
    add column if not exists review_cancelled_by uuid null references auth.users(id) on delete set null,
    add column if not exists review_cancellation_reason text null;

alter table public.market_replenishment_order_items
    add constraint market_replenishment_order_items_source_check
    check (source in ('batch', 'manual_review', 'manual_purchase')) not valid;

alter table public.market_replenishment_order_items
    add constraint market_replenishment_order_items_review_cancelled_check
    check (
        (
            review_cancelled_at is null
            and review_cancellation_reason is null
        )
        or
        (
            status = 'cancelled'
            and review_cancelled_at is not null
            and review_cancellation_reason is not null
            and btrim(review_cancellation_reason) <> ''
        )
    ) not valid;

comment on column public.market_replenishment_order_items.source is
'Origem operacional do item consolidado: batch, manual_review ou manual_purchase. Nesta fase apenas batch e manual_review sao gerados.';

comment on column public.market_replenishment_order_items.review_cancelled_at is
'Momento em que o item foi retirado logicamente durante a revisao pre-compra.';

comment on column public.market_replenishment_order_items.review_cancelled_by is
'Usuario que retirou o item durante a revisao pre-compra.';

comment on column public.market_replenishment_order_items.review_cancellation_reason is
'Motivo operacional da retirada do item durante a revisao pre-compra.';

create or replace function public.market_update_replenishment_order_item_quantity(
    p_market_account_id uuid,
    p_order_id uuid,
    p_order_item_id uuid,
    p_adjusted_purchase_quantity numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
    v_item public.market_replenishment_order_items;
begin
    if p_market_account_id is null or p_order_id is null or p_order_item_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id, order_id e order_item_id sao obrigatorios.';
    end if;

    if p_adjusted_purchase_quantity is null or p_adjusted_purchase_quantity < 0 then
        raise exception 'REPLENISHMENT_ORDER_INVALID_QUANTITY: quantidade revisada deve ser maior ou igual a zero.';
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

    select oi.* into v_item
    from public.market_replenishment_order_items oi
    where oi.market_account_id = p_market_account_id
      and oi.order_id = p_order_id
      and oi.id = p_order_item_id
    for update;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_ITEM_NOT_FOUND: item nao encontrado.';
    end if;

    if v_item.status = 'cancelled' then
        raise exception 'REPLENISHMENT_ORDER_ITEM_CANCELLED: item retirado nao pode ser ajustado.';
    end if;

    update public.market_replenishment_order_items
    set adjusted_purchase_quantity = p_adjusted_purchase_quantity,
        updated_at = now()
    where id = p_order_item_id
      and market_account_id = p_market_account_id;

    update public.market_replenishment_orders
    set updated_at = now(),
        updated_by = auth.uid()
    where id = p_order_id
      and market_account_id = p_market_account_id;

    return p_order_item_id;
end;
$$;

create or replace function public.market_add_replenishment_order_manual_item(
    p_market_account_id uuid,
    p_order_id uuid,
    p_product_id uuid,
    p_purchase_quantity numeric
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
begin
    if p_market_account_id is null or p_order_id is null or p_product_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id, order_id e product_id sao obrigatorios.';
    end if;

    if p_purchase_quantity is null or p_purchase_quantity < 0 then
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
        0,
        null,
        0,
        p_purchase_quantity
    )
    returning id into v_item_id;

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

create or replace function public.market_approve_replenishment_order(
    p_market_account_id uuid,
    p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
begin
    if p_market_account_id is null or p_order_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id e order_id sao obrigatorios.';
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
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para aprovar lista consolidada.';
        end if;
    end if;

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

    update public.market_replenishment_orders
    set status = 'approved',
        approved_at = now(),
        approved_by = auth.uid(),
        updated_at = now(),
        updated_by = auth.uid()
    where id = p_order_id
      and market_account_id = p_market_account_id;

    return p_order_id;
end;
$$;

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
          and o.status <> 'cancelled'
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

    return (
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

revoke all on function public.market_update_replenishment_order_item_quantity(uuid, uuid, uuid, numeric) from public, anon;
revoke all on function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric) from public, anon;
revoke all on function public.market_cancel_replenishment_order_item_review(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.market_approve_replenishment_order(uuid, uuid) from public, anon;
grant execute on function public.market_update_replenishment_order_item_quantity(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric) to authenticated;
grant execute on function public.market_cancel_replenishment_order_item_review(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.market_approve_replenishment_order(uuid, uuid) to authenticated;
grant execute on function public.market_update_replenishment_order_item_quantity(uuid, uuid, uuid, numeric) to service_role;
grant execute on function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric) to service_role;
grant execute on function public.market_cancel_replenishment_order_item_review(uuid, uuid, uuid, text) to service_role;
grant execute on function public.market_approve_replenishment_order(uuid, uuid) to service_role;

comment on function public.market_update_replenishment_order_item_quantity(uuid, uuid, uuid, numeric) is
'Ajusta a quantidade de compra de um item consolidado enquanto a lista esta em draft, preservando a sugestao original do batch.';

comment on function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric) is
'Inclui em draft um produto ativo do catalogo como manual_review, sem criar produto e sem inventar allocation por loja.';

comment on function public.market_cancel_replenishment_order_item_review(uuid, uuid, uuid, text) is
'Retira logicamente um item durante a revisao pre-compra, preservando origem e rastreabilidade.';

comment on function public.market_approve_replenishment_order(uuid, uuid) is
'Transiciona com seguranca uma lista de draft para approved, encerrando a fase de revisao pre-compra.';

commit;
