-- GiroMicro Market: backfill idempotente de saidas para vendas API elegiveis.
-- Nao altera vendas, itens ou mappings; somente completa o ledger.
begin;

insert into public.market_stock_movements (
    market_account_id, market_store_id, product_id, movement_type,
    direction, quantity, reference_type, reference_id, reference_item_id,
    notes, occurred_at, created_by
)
select
    s.market_account_id,
    s.market_store_id,
    coalesce(i.product_id, mapping.product_id),
    'SALE',
    'OUT',
    i.quantity,
    'SALE',
    s.id,
    i.id,
    'Baixa por venda sincronizada',
    s.sold_at,
    null
from public.market_sales s
join public.market_stores store
  on store.id = s.market_store_id
 and store.market_account_id = s.market_account_id
join public.market_sale_items i
  on i.sale_id = s.id
 and i.market_account_id = s.market_account_id
left join public.market_product_mappings mapping
  on mapping.market_account_id = i.market_account_id
 and mapping.integration_id = s.integration_id
 and mapping.source_system = s.source_system
 and mapping.external_product_id = i.external_product_id
where s.source_type = 'api'
  and store.store_type = 'store'
  and store.stock_control_started_at is not null
  and s.sold_at >= store.stock_control_started_at
  and coalesce(i.product_id, mapping.product_id) is not null
  and not exists (
      select 1
      from public.market_stock_movements existing
      where existing.market_account_id = s.market_account_id
        and existing.movement_type = 'SALE'
        and existing.reference_type = 'SALE'
        and existing.reference_item_id = i.id
  )
on conflict (
    market_account_id, movement_type, reference_type, reference_id, reference_item_id
) where reference_type is not null
      and reference_id is not null
      and reference_item_id is not null
do nothing;

commit;
