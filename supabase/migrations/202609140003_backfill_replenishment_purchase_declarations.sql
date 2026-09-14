-- GiroMicro Market: compatibilidade para ordens de reposicao aprovadas antes
-- da criacao de market_replenishment_purchase_declarations.
-- Nao altera batch, allocations, compras, abastecimento ou estoque.
begin;

insert into public.market_replenishment_purchase_declarations (
    market_account_id,
    order_id,
    product_id,
    approval_revision,
    target_quantity
)
select
    l.market_account_id,
    l.order_id,
    i.product_id,
    l.approval_revision,
    sum(l.target_quantity)::numeric(18,4)
from public.market_replenishment_operation_lines l
join public.market_replenishment_order_allocations a
  on a.id = l.allocation_id
 and a.market_account_id = l.market_account_id
join public.market_replenishment_order_items i
  on i.id = a.order_item_id
 and i.market_account_id = a.market_account_id
join public.market_replenishment_orders o
  on o.id = l.order_id
 and o.market_account_id = l.market_account_id
where l.operation_type = 'purchase'
  and o.status in ('approved', 'in_progress')
  and i.status <> 'cancelled'
  and a.status <> 'cancelled'
  and l.target_quantity > 0
  and not exists (
      select 1
      from public.market_replenishment_purchase_declarations d
      where d.market_account_id = l.market_account_id
        and d.order_id = l.order_id
        and d.product_id = i.product_id
        and d.approval_revision = l.approval_revision
  )
group by l.market_account_id, l.order_id, i.product_id, l.approval_revision;

commit;
