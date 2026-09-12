-- Lista de Compras: inclusao manual com destino obrigatorio.
begin;

-- Remove a assinatura antiga para impedir novas inclusoes sem loja.
drop function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric);

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

revoke all on function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric, uuid) from public, anon;
grant execute on function public.market_add_replenishment_order_manual_item(uuid, uuid, uuid, numeric, uuid) to authenticated, service_role;

commit;
