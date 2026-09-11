-- GiroMicro Market
-- Reposição Inteligente
-- Quantidades operacionais de reposição devem ser unidades inteiras.
--
-- Regra:
--   2.0000 -> 2
--   2.0001 -> 3
--   2.4833 -> 3
--   NULL   -> NULL
--
-- O cálculo analítico do batch permanece decimal.
-- Apenas a materialização operacional da lista é arredondada para cima.

create or replace function public.market_round_replenishment_order_item_quantities()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.total_suggested_quantity is not null then
        new.total_suggested_quantity :=
            ceil(new.total_suggested_quantity)::numeric(18,4);
    end if;

    if new.suggested_purchase_quantity is not null then
        new.suggested_purchase_quantity :=
            ceil(new.suggested_purchase_quantity)::numeric(18,4);
    end if;

    if new.adjusted_purchase_quantity is not null then
        new.adjusted_purchase_quantity :=
            ceil(new.adjusted_purchase_quantity)::numeric(18,4);
    end if;

    return new;
end;
$$;


drop trigger if exists trg_market_round_replenishment_order_item_quantities
    on public.market_replenishment_order_items;

create trigger trg_market_round_replenishment_order_item_quantities
before insert or update of
    total_suggested_quantity,
    suggested_purchase_quantity,
    adjusted_purchase_quantity
on public.market_replenishment_order_items
for each row
execute function public.market_round_replenishment_order_item_quantities();


create or replace function public.market_round_replenishment_allocation_quantities()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.suggested_quantity is not null then
        new.suggested_quantity :=
            ceil(new.suggested_quantity)::numeric(18,4);
    end if;

    if new.warehouse_allocated_quantity is not null then
        new.warehouse_allocated_quantity :=
            ceil(new.warehouse_allocated_quantity)::numeric(18,4);
    end if;

    if new.purchase_needed_quantity is not null then
        new.purchase_needed_quantity :=
            ceil(new.purchase_needed_quantity)::numeric(18,4);
    end if;

    return new;
end;
$$;


drop trigger if exists trg_market_round_replenishment_allocation_quantities
    on public.market_replenishment_order_allocations;

create trigger trg_market_round_replenishment_allocation_quantities
before insert or update of
    suggested_quantity,
    warehouse_allocated_quantity,
    purchase_needed_quantity
on public.market_replenishment_order_allocations
for each row
execute function public.market_round_replenishment_allocation_quantities();


comment on function public.market_round_replenishment_order_item_quantities()
is
'Arredonda para cima quantidades operacionais conhecidas da lista de reposicao. NULL permanece NULL.';

comment on function public.market_round_replenishment_allocation_quantities()
is
'Arredonda para cima quantidades operacionais conhecidas por loja. NULL permanece NULL.';