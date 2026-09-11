-- GiroMicro Market
-- Reposicao Inteligente / Lista de Compras
-- Migration: leitura consolidada da lista com ultimo fornecedor conhecido
-- Data: 2026-09-10
--
-- Escopo:
-- - cria uma RPC de leitura para a lista consolidada;
-- - enriquece os itens com o ultimo fornecedor valido por produto;
-- - nao persiste fornecedor, nao duplica historico de compras.

begin;

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
                oi.total_suggested_quantity,
                oi.warehouse_stock_snapshot,
                oi.suggested_purchase_quantity,
                oi.adjusted_purchase_quantity,
                oi.purchased_quantity,
                oi.warehouse_surplus_quantity,
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
                        'totalSuggestedQuantity', ir.total_suggested_quantity,
                        'warehouseStockSnapshot', ir.warehouse_stock_snapshot,
                        'suggestedPurchaseQuantity', ir.suggested_purchase_quantity,
                        'adjustedPurchaseQuantity', ir.adjusted_purchase_quantity,
                        'purchasedQuantity', ir.purchased_quantity,
                        'warehouseSurplusQuantity', ir.warehouse_surplus_quantity,
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

revoke all on function public.market_get_replenishment_order(uuid, uuid) from public, anon;
grant execute on function public.market_get_replenishment_order(uuid, uuid) to authenticated;
grant execute on function public.market_get_replenishment_order(uuid, uuid) to service_role;

comment on function public.market_get_replenishment_order(uuid, uuid) is
'Le a lista consolidada de reposicao/compra e enriquece cada produto, em lote, com o ultimo fornecedor valido obtido de itens de compra recebidos e confirmados no ledger PURCHASE. Nao persiste nem duplica historico de fornecedores.';

commit;
