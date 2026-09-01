-- GiroMicro Market - Sprint 3B.1: fundacao segura do estoque operacional.
-- Ativa o controle por loja por meio de inventario inicial atomico e mantem
-- market_stock_movements como livro-razao append-only.
begin;

alter table public.market_stores
    add column if not exists stock_control_started_at timestamptz null;

comment on column public.market_stores.stock_control_started_at is
    'Marco oficial do controle de estoque da loja. Movimentos comerciais anteriores nao devem ser aplicados automaticamente.';

alter table public.market_stock_movements
    add column if not exists reference_item_id uuid null;

comment on column public.market_stock_movements.reference_item_id is
    'Identifica o item da origem para garantir idempotencia por item em compras, vendas, transferencias e inventarios.';

alter table public.market_stock_movements
    drop constraint if exists market_stock_movements_direction_type_check;

-- NOT VALID preserva eventuais dados legados, mas passa a validar toda nova escrita.
alter table public.market_stock_movements
    add constraint market_stock_movements_direction_type_check
    check (
        (movement_type in ('PURCHASE','TRANSFER_IN','ADJUSTMENT_IN','INVENTORY') and direction = 'IN')
        or
        (movement_type in ('SALE','TRANSFER_OUT','ADJUSTMENT_OUT','LOSS') and direction = 'OUT')
    ) not valid;

create unique index if not exists ux_market_stock_movements_source_item
    on public.market_stock_movements (
        market_account_id, movement_type, reference_type, reference_id, reference_item_id
    )
    where reference_type is not null
      and reference_id is not null
      and reference_item_id is not null;

create index if not exists ix_market_stock_movements_balance_lookup
    on public.market_stock_movements (
        market_account_id, market_store_id, product_id, occurred_at desc
    );

-- A view deixa de ser uma API publica. security_invoker e revogacao formam
-- defesa em profundidade; o frontend consulta somente a RPC abaixo.
alter view public.market_stock_balance set (security_invoker = true);
revoke all on public.market_stock_balance from public;
revoke all on public.market_stock_balance from anon;
revoke all on public.market_stock_balance from authenticated;

-- Movimentos operacionais passam a ser gravados somente por RPCs auditaveis.
-- SELECT continua protegido pela policy por loja; UPDATE/DELETE seguem restritos
-- ao administrador da plataforma conforme a migration inicial.
drop policy if exists market_stock_movements_insert on public.market_stock_movements;

create or replace function public.market_start_stock_control(
    p_market_store_id uuid,
    p_started_at timestamptz,
    p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_store public.market_stores;
    v_member public.market_account_members;
    v_item_count integer;
    v_distinct_product_count integer;
    v_valid_product_count integer;
begin
    if auth.uid() is null then
        raise exception 'STOCK_AUTH_REQUIRED: usuario nao autenticado.';
    end if;

    if p_market_store_id is null or p_started_at is null then
        raise exception 'STOCK_INVALID_START: loja e data/hora sao obrigatorias.';
    end if;

    if jsonb_typeof(p_items) <> 'array'
       or jsonb_array_length(p_items) = 0
       or jsonb_array_length(p_items) > 5000 then
        raise exception 'STOCK_INVALID_ITEMS: informe entre 1 e 5000 produtos.';
    end if;

    select s.* into v_store
    from public.market_stores s
    join public.market_accounts a on a.id = s.market_account_id
    where s.id = p_market_store_id
      and s.status = 'active'
      and a.status in ('pilot','active')
    for update of s;

    if not found then
        raise exception 'STOCK_STORE_UNAVAILABLE: loja inexistente, inativa ou conta indisponivel.';
    end if;

    select m.* into v_member
    from public.market_account_members m
    where m.market_account_id = v_store.market_account_id
      and m.user_id = auth.uid()
      and m.status = 'active'
    order by m.created_at
    limit 1;

    if not found then
        raise exception 'STOCK_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.';
    end if;

    if v_member.role = 'viewer' then
        raise exception 'STOCK_PERMISSION_DENIED: perfil de visualizacao nao pode iniciar estoque.';
    end if;

    if not (
        v_member.all_stores
        or v_member.role in ('owner','admin')
        or exists (
            select 1 from public.market_member_stores ms
            where ms.market_account_member_id = v_member.id
              and ms.market_store_id = v_store.id
        )
    ) then
        raise exception 'STOCK_STORE_NOT_ALLOWED: usuario sem acesso a loja.';
    end if;

    if v_store.stock_control_started_at is not null then
        raise exception 'STOCK_ALREADY_STARTED: controle de estoque ja iniciado para esta loja.';
    end if;

    select count(*), count(distinct (item->>'productId')::uuid)
    into v_item_count, v_distinct_product_count
    from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) = 'object'
      and btrim(item->>'productId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and btrim(item->>'quantity') ~ '^[0-9]+([.][0-9]+)?$'
      and (item->>'quantity')::numeric > 0;

    if v_item_count <> jsonb_array_length(p_items)
       or v_distinct_product_count <> v_item_count then
        raise exception 'STOCK_INVALID_ITEMS: produtos devem ser unicos e quantidades maiores que zero.';
    end if;

    select count(*) into v_valid_product_count
    from public.market_products p
    join (
        select distinct (item->>'productId')::uuid product_id
        from jsonb_array_elements(p_items) item
    ) requested on requested.product_id = p.id
    where p.market_account_id = v_store.market_account_id
      and p.status = 'active';

    if v_valid_product_count <> v_item_count then
        raise exception 'STOCK_INVALID_PRODUCT: produto inexistente, inativo ou pertencente a outra conta.';
    end if;

    insert into public.market_stock_movements (
        market_account_id, market_store_id, product_id, movement_type,
        direction, quantity, reference_type, reference_id,
        reference_item_id, notes, occurred_at, created_by
    )
    select
        v_store.market_account_id, v_store.id, (item->>'productId')::uuid,
        'INVENTORY', 'IN', (item->>'quantity')::numeric,
        'STOCK_INITIALIZATION', v_store.id, (item->>'productId')::uuid,
        'Inventario inicial do controle de estoque', p_started_at, auth.uid()
    from jsonb_array_elements(p_items) item;

    update public.market_stores
    set stock_control_started_at = p_started_at,
        updated_at = now()
    where id = v_store.id;

    return jsonb_build_object(
        'marketAccountId', v_store.market_account_id,
        'marketStoreId', v_store.id,
        'stockControlStartedAt', p_started_at,
        'inventoryItems', v_item_count
    );
exception
    when unique_violation then
        raise exception 'STOCK_ALREADY_STARTED: inventario inicial ja registrado para esta loja.';
end;
$$;

create or replace function public.market_get_stock_balance(
    p_market_account_id uuid,
    p_market_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_store_ids uuid[] := array[]::uuid[];
begin
    if auth.uid() is null then
        raise exception 'STOCK_AUTH_REQUIRED: usuario nao autenticado.';
    end if;

    if not exists (
        select 1 from public.market_accounts a
        where a.id = p_market_account_id
          and a.status in ('pilot','active')
    ) then
        raise exception 'STOCK_ACCOUNT_UNAVAILABLE: conta Market indisponivel.';
    end if;

    select m.* into v_member
    from public.market_account_members m
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid()
      and m.status = 'active'
    order by m.created_at
    limit 1;

    if not found then
        raise exception 'STOCK_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.';
    end if;

    select coalesce(array_agg(s.id order by s.id), array[]::uuid[])
    into v_store_ids
    from public.market_stores s
    where s.market_account_id = p_market_account_id
      and (
          v_member.all_stores
          or v_member.role in ('owner','admin')
          or exists (
              select 1 from public.market_member_stores ms
              where ms.market_account_member_id = v_member.id
                and ms.market_store_id = s.id
          )
      );

    if p_market_store_id is not null
       and not (p_market_store_id = any(v_store_ids)) then
        raise exception 'STOCK_STORE_NOT_ALLOWED: loja inexistente ou sem acesso.';
    end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'marketAccountId', b.market_account_id,
            'marketStoreId', b.market_store_id,
            'storeName', s.name,
            'stockControlStartedAt', s.stock_control_started_at,
            'productId', b.product_id,
            'productName', p.name,
            'ean', p.ean,
            'sku', p.sku,
            'unit', p.unit,
            'quantityOnHand', b.quantity_on_hand,
            'lastMovementAt', b.last_movement_at
        ) order by s.name, p.name, p.id)
        from public.market_stock_balance b
        join public.market_stores s
          on s.id = b.market_store_id
         and s.market_account_id = b.market_account_id
        join public.market_products p
          on p.id = b.product_id
         and p.market_account_id = b.market_account_id
        where b.market_account_id = p_market_account_id
          and b.market_store_id = any(v_store_ids)
          and (p_market_store_id is null or b.market_store_id = p_market_store_id)
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.market_start_stock_control(uuid,timestamptz,jsonb) from public;
revoke all on function public.market_get_stock_balance(uuid,uuid) from public;
grant execute on function public.market_start_stock_control(uuid,timestamptz,jsonb) to authenticated;
grant execute on function public.market_get_stock_balance(uuid,uuid) to authenticated;

commit;
