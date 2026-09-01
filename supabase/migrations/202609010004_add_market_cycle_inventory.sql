-- GiroMicro Market - Sprint 3B.1.1: inventario recorrente de estoque.
-- Reutiliza sessoes e itens existentes. A finalizacao cycle reconcilia a
-- contagem fisica com o saldo vigente, sem alterar movimentos anteriores.
begin;

alter table public.market_inventory_sessions
    drop constraint if exists market_inventory_sessions_inventory_type_check;

alter table public.market_inventory_sessions
    add constraint market_inventory_sessions_inventory_type_check
    check (inventory_type in ('initial','cycle'));

alter table public.market_inventory_session_items
    drop constraint if exists market_inventory_session_items_quantity_check;

alter table public.market_inventory_session_items
    add constraint market_inventory_session_items_quantity_check
    check (quantity >= 0);

create unique index ux_market_inventory_sessions_cycle_draft_store
    on public.market_inventory_sessions (market_store_id)
    where inventory_type = 'cycle' and status = 'draft';

-- Defesa adicional contra repeticao: para inventarios recorrentes, um item da
-- sessao pode originar no maximo um movimento, independentemente da direcao.
create unique index ux_market_stock_movements_inventory_session_item
    on public.market_stock_movements (
        market_account_id, reference_type, reference_id, reference_item_id
    )
    where reference_type = 'INVENTORY_SESSION'
      and reference_id is not null
      and reference_item_id is not null;

comment on column public.market_inventory_sessions.inventory_type is
    'initial inicia o estoque; cycle reconcilia uma contagem parcial com o saldo vigente na finalizacao.';

comment on column public.market_inventory_session_items.quantity is
    'Quantidade fisica contada. Em cycle, zero e uma contagem explicita; ausencia do item significa nao contado.';

create or replace function public.market_get_inventory_draft(
    p_market_account_id uuid,
    p_market_store_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_session public.market_inventory_sessions;
    v_inventory_type text;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    select m.* into v_member
    from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;

    select case when s.stock_control_started_at is null then 'initial' else 'cycle' end
    into v_inventory_type
    from public.market_stores s
    where s.id = p_market_store_id and s.market_account_id = p_market_account_id
      and s.status = 'active'
      and (v_member.all_stores or v_member.role in ('owner','admin') or exists (
          select 1 from public.market_member_stores ms
          where ms.market_account_member_id = v_member.id and ms.market_store_id = s.id
      ));
    if not found then raise exception 'INVENTORY_STORE_NOT_ALLOWED: loja inexistente ou sem acesso.'; end if;

    select * into v_session from public.market_inventory_sessions
    where market_account_id = p_market_account_id and market_store_id = p_market_store_id
      and inventory_type = v_inventory_type and status = 'draft'
    limit 1;
    if not found then return null; end if;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'inventoryType', v_session.inventory_type,
        'status', v_session.status, 'startedAt', v_session.started_at,
        'version', v_session.version, 'createdAt', v_session.created_at,
        'updatedAt', v_session.updated_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'productId', i.product_id, 'quantity', i.quantity
        ) order by i.created_at, i.product_id)
        from public.market_inventory_session_items i where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
end;
$$;

create or replace function public.market_save_inventory_draft(
    p_market_store_id uuid,
    p_inventory_session_id uuid,
    p_expected_version integer,
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
    v_session public.market_inventory_sessions;
    v_inventory_type text;
    v_item_count integer;
    v_distinct_count integer;
    v_valid_count integer;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if p_started_at is null or p_items is null or jsonb_typeof(p_items) <> 'array'
       or jsonb_array_length(p_items) > 5000 then
        raise exception 'INVENTORY_INVALID_DRAFT: data e lista de itens invalidas.';
    end if;

    -- A loja e o ponto de serializacao de toda operacao que altera seu ledger.
    select s.* into v_store from public.market_stores s
    join public.market_accounts a on a.id = s.market_account_id and a.status in ('pilot','active')
    where s.id = p_market_store_id and s.status = 'active' for update of s;
    if not found then raise exception 'INVENTORY_STORE_UNAVAILABLE: loja indisponivel.'; end if;
    v_inventory_type := case when v_store.stock_control_started_at is null then 'initial' else 'cycle' end;

    select m.* into v_member from public.market_account_members m
    where m.market_account_id = v_store.market_account_id and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;
    if v_member.role = 'viewer' then raise exception 'INVENTORY_PERMISSION_DENIED: perfil somente leitura.'; end if;
    if not (v_member.all_stores or v_member.role in ('owner','admin') or exists (
        select 1 from public.market_member_stores ms
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_store.id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    select count(*), count(distinct (item->>'productId')::uuid)
    into v_item_count, v_distinct_count from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) = 'object'
      and btrim(item->>'productId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and btrim(item->>'quantity') ~ '^[0-9]+([.][0-9]+)?$'
      and (item->>'quantity')::numeric >= 0;
    if v_item_count <> jsonb_array_length(p_items) or v_distinct_count <> v_item_count then
        raise exception 'INVENTORY_INVALID_ITEMS: produtos unicos e quantidades nao negativas sao obrigatorios.';
    end if;

    select count(*) into v_valid_count from public.market_products p
    join (select distinct (item->>'productId')::uuid product_id from jsonb_array_elements(p_items) item) requested
      on requested.product_id = p.id
    where p.market_account_id = v_store.market_account_id and p.status = 'active';
    if v_valid_count <> v_item_count then raise exception 'INVENTORY_INVALID_PRODUCT: produto invalido ou de outra conta.'; end if;

    if p_inventory_session_id is null then
        if p_expected_version is not null then raise exception 'INVENTORY_VERSION_CONFLICT: versao inesperada para novo rascunho.'; end if;
        insert into public.market_inventory_sessions (
            market_account_id, market_store_id, inventory_type, started_at, created_by
        ) values (v_store.market_account_id, v_store.id, v_inventory_type, p_started_at, auth.uid())
        returning * into v_session;
    else
        select * into v_session from public.market_inventory_sessions
        where id = p_inventory_session_id and market_account_id = v_store.market_account_id
          and market_store_id = v_store.id for update;
        if not found or v_session.status <> 'draft' or v_session.inventory_type <> v_inventory_type then
            raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente, encerrado ou incompativel com o estado da loja.';
        end if;
        if p_expected_version is null or v_session.version <> p_expected_version then
            raise exception 'INVENTORY_VERSION_CONFLICT: rascunho atualizado em outro dispositivo.';
        end if;
        update public.market_inventory_sessions set started_at = p_started_at,
            version = version + 1, updated_at = now()
        where id = v_session.id returning * into v_session;
        delete from public.market_inventory_session_items where inventory_session_id = v_session.id;
    end if;

    insert into public.market_inventory_session_items (
        market_account_id, inventory_session_id, product_id, quantity
    ) select v_store.market_account_id, v_session.id, (item->>'productId')::uuid,
        (item->>'quantity')::numeric from jsonb_array_elements(p_items) item
    where v_session.inventory_type = 'cycle' or (item->>'quantity')::numeric > 0;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'inventoryType', v_session.inventory_type,
        'status', v_session.status, 'startedAt', v_session.started_at,
        'version', v_session.version, 'createdAt', v_session.created_at,
        'updatedAt', v_session.updated_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object('productId', i.product_id, 'quantity', i.quantity)
            order by i.created_at, i.product_id) from public.market_inventory_session_items i
            where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
exception when unique_violation then
    raise exception 'INVENTORY_DRAFT_CONFLICT: ja existe inventario em andamento para esta loja.';
end;
$$;

create or replace function public.market_finalize_inventory_draft(
    p_inventory_session_id uuid,
    p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_session public.market_inventory_sessions;
    v_store public.market_stores;
    v_member public.market_account_members;
    v_locator_account_id uuid;
    v_locator_store_id uuid;
    v_items jsonb;
    v_stock_result jsonb;
    v_adjustment_in_count integer := 0;
    v_adjustment_out_count integer := 0;
    v_unchanged_count integer := 0;
    v_adjustment_in_quantity numeric := 0;
    v_adjustment_out_quantity numeric := 0;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    -- Leitura localizadora, sem valor de estado: serve exclusivamente para
    -- descobrir qual loja deve ser bloqueada. Nada da sessao e confiado aqui.
    select market_account_id, market_store_id
    into v_locator_account_id, v_locator_store_id
    from public.market_inventory_sessions
    where id = p_inventory_session_id;
    if not found then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.';
    end if;

    -- REGRA GLOBAL DE SERIALIZACAO:
    -- Toda operacao que grava market_stock_movements de uma loja deve adquirir
    -- primeiro FOR UPDATE da mesma market_stores. A ordem e sempre loja ->
    -- sessao; nunca sessao -> loja.
    select * into v_store from public.market_stores
    where id = v_locator_store_id and market_account_id = v_locator_account_id
      and status = 'active' for update;
    if not found then raise exception 'INVENTORY_STORE_UNAVAILABLE: loja indisponivel.'; end if;

    -- Somente depois do lock da loja a sessao e relida, bloqueada e passa a ser
    -- considerada estado confiavel.
    select * into v_session from public.market_inventory_sessions
    where id = p_inventory_session_id and market_account_id = v_store.market_account_id
      and market_store_id = v_store.id for update;
    if not found or v_session.status <> 'draft' then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.';
    end if;
    if p_expected_version is null or v_session.version <> p_expected_version then
        raise exception 'INVENTORY_VERSION_CONFLICT: rascunho atualizado em outro dispositivo.';
    end if;
    if v_session.inventory_type not in ('initial','cycle') then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: tipo de inventario invalido.';
    end if;

    select m.* into v_member from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = v_session.market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;
    if v_member.role = 'viewer' then raise exception 'INVENTORY_PERMISSION_DENIED: perfil somente leitura.'; end if;
    if not (v_member.all_stores or v_member.role in ('owner','admin') or exists (
        select 1 from public.market_member_stores ms
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_store.id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    if v_session.inventory_type = 'initial' then
        if v_store.stock_control_started_at is not null then
            raise exception 'INVENTORY_DRAFT_UNAVAILABLE: estoque ja iniciado para esta loja.';
        end if;
        select jsonb_agg(jsonb_build_object('productId', i.product_id, 'quantity', i.quantity)
            order by i.created_at, i.product_id) into v_items
        from public.market_inventory_session_items i
        where i.inventory_session_id = v_session.id and i.quantity > 0;
        if v_items is null or jsonb_array_length(v_items) = 0 then
            raise exception 'INVENTORY_EMPTY: informe ao menos um produto.';
        end if;

        v_stock_result := public.market_start_stock_control(v_store.id, v_session.started_at, v_items);
        update public.market_inventory_sessions set status = 'completed', completed_at = now(),
            updated_at = now(), version = version + 1 where id = v_session.id returning * into v_session;
        return v_stock_result || jsonb_build_object(
            'inventoryType', v_session.inventory_type,
            'inventorySessionId', v_session.id, 'inventorySessionStatus', v_session.status,
            'inventorySessionVersion', v_session.version
        );
    end if;

    if v_session.inventory_type <> 'cycle' or v_store.stock_control_started_at is null then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: inventario incompativel com o estado da loja.';
    end if;
    if not exists (select 1 from public.market_inventory_session_items i where i.inventory_session_id = v_session.id) then
        raise exception 'INVENTORY_EMPTY: informe ao menos um produto contado.';
    end if;

    -- O mesmo conjunto materializado de diferencas origina os movimentos e
    -- todos os totais retornados. Nao ha uma segunda avaliacao da reconciliacao.
    with current_balance as materialized (
        select m.product_id,
            coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)::numeric as quantity
        from public.market_stock_movements m
        where m.market_account_id = v_session.market_account_id and m.market_store_id = v_session.market_store_id
        group by m.product_id
    ), differences as materialized (
        select i.id item_id, i.product_id,
            i.quantity - coalesce(b.quantity, 0) as difference
        from public.market_inventory_session_items i
        left join current_balance b on b.product_id = i.product_id
        where i.inventory_session_id = v_session.id
    ), inserted_movements as (
        insert into public.market_stock_movements (
            market_account_id, market_store_id, product_id, movement_type,
            direction, quantity, reference_type, reference_id, reference_item_id,
            notes, occurred_at, created_by
        )
        select v_session.market_account_id, v_session.market_store_id, d.product_id,
            case when d.difference > 0 then 'ADJUSTMENT_IN' else 'ADJUSTMENT_OUT' end,
            case when d.difference > 0 then 'IN' else 'OUT' end,
            abs(d.difference), 'INVENTORY_SESSION', v_session.id, d.item_id,
            'Ajuste por inventario recorrente', now(), auth.uid()
        from differences d where d.difference <> 0
        returning direction, quantity
    )
    select movement_totals.adjustment_in_count,
           movement_totals.adjustment_out_count,
           difference_totals.unchanged_count,
           movement_totals.adjustment_in_quantity,
           movement_totals.adjustment_out_quantity
    into v_adjustment_in_count, v_adjustment_out_count, v_unchanged_count,
         v_adjustment_in_quantity, v_adjustment_out_quantity
    from (
        select count(*) filter (where direction = 'IN') adjustment_in_count,
               count(*) filter (where direction = 'OUT') adjustment_out_count,
               coalesce(sum(quantity) filter (where direction = 'IN'), 0) adjustment_in_quantity,
               coalesce(sum(quantity) filter (where direction = 'OUT'), 0) adjustment_out_quantity
        from inserted_movements
    ) movement_totals
    cross join (
        select count(*) filter (where difference = 0) unchanged_count
        from differences
    ) difference_totals;

    update public.market_inventory_sessions set status = 'completed', completed_at = now(),
        updated_at = now(), version = version + 1 where id = v_session.id returning * into v_session;

    return jsonb_build_object(
        'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id,
        'inventoryType', v_session.inventory_type,
        'inventorySessionId', v_session.id,
        'inventorySessionStatus', v_session.status,
        'inventorySessionVersion', v_session.version,
        'countedProducts', v_adjustment_in_count + v_adjustment_out_count + v_unchanged_count,
        'adjustmentInProducts', v_adjustment_in_count,
        'adjustmentOutProducts', v_adjustment_out_count,
        'unchangedProducts', v_unchanged_count,
        'adjustmentInQuantity', v_adjustment_in_quantity,
        'adjustmentOutQuantity', v_adjustment_out_quantity
    );
exception when unique_violation then
    raise exception 'INVENTORY_ALREADY_FINALIZED: ajustes deste inventario ja foram registrados.';
end;
$$;

revoke all on function public.market_get_inventory_draft(uuid,uuid) from public;
revoke all on function public.market_save_inventory_draft(uuid,uuid,integer,timestamptz,jsonb) from public;
revoke all on function public.market_finalize_inventory_draft(uuid,integer) from public;
grant execute on function public.market_get_inventory_draft(uuid,uuid) to authenticated;
grant execute on function public.market_save_inventory_draft(uuid,uuid,integer,timestamptz,jsonb) to authenticated;
grant execute on function public.market_finalize_inventory_draft(uuid,integer) to authenticated;

commit;
