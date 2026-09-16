-- 202609160002_allow_replenishment_receipt_without_invoice_key.sql
-- Texto IA e outros documentos validos podem nao possuir chave fiscal.
-- A evidencia fisica continua exigindo item recebido + conciliado + PURCHASE/IN
-- correspondente no Galpao. Migrations anteriores permanecem imutaveis.

begin;

create or replace function public.market_replenishment_received_items_internal(
  p_account uuid,
  p_product uuid
)
returns table(
  item_id uuid,
  warehouse_id uuid,
  quantity numeric,
  received_at timestamptz
)
language sql
stable
set search_path=public
as $$
  select
    i.id,
    p.destination_store_id,
    i.stock_quantity,
    min(m.occurred_at)
  from market_purchase_items i
  join market_purchases p
    on p.id=i.market_purchase_id
   and p.market_account_id=i.market_account_id
  join market_stores s
    on s.id=p.destination_store_id
   and s.market_account_id=p.market_account_id
  join market_stock_movements m
    on m.market_account_id=i.market_account_id
   and m.market_store_id=s.id
   and m.product_id=i.market_product_id
   and m.movement_type='PURCHASE'
   and m.direction='IN'
   and m.reference_type='PURCHASE'
   and m.reference_id=p.id
   and m.reference_item_id=i.id
   and m.quantity=i.stock_quantity
  where i.market_account_id=p_account
    and i.market_product_id=p_product
    and s.store_type='warehouse'
    and i.stock_entry_status='received'
    and p.status in ('receiving','completed')
    and i.stock_quantity>0
    and i.stock_unit is not null
    and i.reconciliation_status in ('matched_auto','matched_manual','mapped')
  group by
    i.id,
    p.destination_store_id,
    i.stock_quantity;
$$;

commit;
