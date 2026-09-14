-- GiroMicro Market: vendas sincronizadas passam a alimentar o ledger de estoque.
-- O trigger e restrito a vendas API; importacoes legadas e operacoes manuais
-- continuam com seus fluxos proprios.
begin;

alter table public.market_stores
        add column if not exists stock_control_started_at timestamptz null;

-- O ledger e a fonte historica do marco: algumas lojas nao possuem mais a
-- sessao initial consultavel, embora conservem o movimento de inicializacao.
update public.market_stores s
set stock_control_started_at = initial.started_at,
        updated_at = now()
from (
        select market_store_id, min(created_at) as started_at
        from public.market_stock_movements
        where movement_type = 'INVENTORY'
            and reference_type = 'STOCK_INITIALIZATION'
        group by market_store_id
) initial
where s.id = initial.market_store_id
    and s.stock_control_started_at is null;

create or replace function public.market_mark_initial_inventory_completed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
        if new.inventory_type = 'initial'
             and new.status = 'completed'
             and old.status is distinct from new.status
             and new.completed_at is not null then
                update public.market_stores
                set stock_control_started_at = new.completed_at,
                        updated_at = now()
                where id = new.market_store_id
                    and market_account_id = new.market_account_id
                    and stock_control_started_at is null;
        end if;
        return new;
end;
$$;

drop trigger if exists market_inventory_sessions_mark_control_started on public.market_inventory_sessions;
create trigger market_inventory_sessions_mark_control_started
after update of status, completed_at on public.market_inventory_sessions
for each row execute function public.market_mark_initial_inventory_completed();

create or replace function public.market_resolve_synced_sale_item_product()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_sale public.market_sales;
    v_product_id uuid;
begin
    select s.* into v_sale
    from public.market_sales s
    where s.id = new.sale_id
      and s.market_account_id = new.market_account_id;

    if not found or v_sale.source_type <> 'api' then
        return new;
    end if;

    if new.product_id is null and new.external_product_id is not null then
        select m.product_id into v_product_id
        from public.market_product_mappings m
        where m.market_account_id = new.market_account_id
          and m.integration_id = v_sale.integration_id
          and m.source_system = v_sale.source_system
          and m.external_product_id = new.external_product_id
        limit 1;

        if v_product_id is not null and exists (
            select 1 from public.market_products p
            where p.id = v_product_id
              and p.market_account_id = new.market_account_id
        ) then
            new.product_id := v_product_id;
        end if;
    end if;

    return new;
end;
$$;

create or replace function public.market_create_synced_sale_stock_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_sale public.market_sales;
    v_store_type text;
    v_stock_control_started_at timestamptz;
begin
    select s.* into v_sale
    from public.market_sales s
    where s.id = new.sale_id
      and s.market_account_id = new.market_account_id;

    if not found or v_sale.source_type <> 'api' or new.product_id is null then
        return new;
    end if;

    -- A loja e o ponto de serializacao comum a vendas e inventarios.
        select s.store_type, s.stock_control_started_at
            into v_store_type, v_stock_control_started_at
    from public.market_stores s
    where s.id = v_sale.market_store_id
      and s.market_account_id = v_sale.market_account_id
    for update;

    if not found then
        raise exception 'SALE_STORE_NOT_FOUND: local inexistente ou pertencente a outra conta.';
    end if;
    if v_store_type <> 'store' then
        raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: galpao nao pode receber movimento de venda.';
    end if;
    if v_stock_control_started_at is null or v_sale.sold_at < v_stock_control_started_at then
        return new;
    end if;

    -- Quantidade permanece positiva; direction define a saida. O conflito
    -- torna a ressincronizacao do mesmo item um no-op, sem baixa duplicada.
    insert into public.market_stock_movements (
        market_account_id, market_store_id, product_id, movement_type,
        direction, quantity, reference_type, reference_id, reference_item_id,
        notes, occurred_at, created_by
    ) values (
        v_sale.market_account_id, v_sale.market_store_id, new.product_id,
        'SALE', 'OUT', new.quantity, 'SALE', v_sale.id, new.id,
        'Baixa por venda sincronizada', v_sale.sold_at, null
    )
    on conflict (market_account_id, movement_type, reference_type, reference_id, reference_item_id)
      where reference_type is not null and reference_id is not null and reference_item_id is not null
      do nothing;

    return new;
end;
$$;

drop trigger if exists market_sale_items_resolve_synced_product on public.market_sale_items;
create trigger market_sale_items_resolve_synced_product
before insert or update on public.market_sale_items
for each row execute function public.market_resolve_synced_sale_item_product();

drop trigger if exists market_sale_items_create_synced_stock_movement on public.market_sale_items;
create trigger market_sale_items_create_synced_stock_movement
after insert or update of product_id, quantity on public.market_sale_items
for each row execute function public.market_create_synced_sale_stock_movement();

revoke all on function public.market_resolve_synced_sale_item_product() from public, anon, authenticated;
revoke all on function public.market_create_synced_sale_stock_movement() from public, anon, authenticated;
revoke all on function public.market_mark_initial_inventory_completed() from public, anon, authenticated;

comment on function public.market_resolve_synced_sale_item_product() is
    'Resolve produto interno de item API por market_product_mappings sem rejeitar venda sem mapping.';
comment on function public.market_create_synced_sale_stock_movement() is
    'Cria uma saida SALE idempotente para cada item API resolvido apos o marco da loja; permite saldo negativo.';
comment on function public.market_mark_initial_inventory_completed() is
    'Marca o inicio oficial do controle ao concluir o primeiro inventario initial, sem mover o marco em ciclos.';

commit;