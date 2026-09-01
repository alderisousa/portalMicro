-- GiroMicro Market - Sprint 3B.1: rascunho persistente do inventario inicial.
-- Rascunhos nao alteram saldo; somente a finalizacao chama a fundacao atomica
-- criada em 202609010001_create_market_stock_foundation.sql.
begin;

create table public.market_inventory_sessions (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    inventory_type text not null default 'initial'
        check (inventory_type in ('initial')),
    status text not null default 'draft'
        check (status in ('draft','completed','cancelled')),
    started_at timestamptz not null,
    version integer not null default 1 check (version > 0),
    created_by uuid not null references auth.users(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz null,
    cancelled_at timestamptz null,
    unique (id, market_account_id),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id)
);

create unique index ux_market_inventory_sessions_initial_draft_store
    on public.market_inventory_sessions (market_store_id)
    where inventory_type = 'initial' and status = 'draft';

create index ix_market_inventory_sessions_account_store_updated
    on public.market_inventory_sessions (market_account_id, market_store_id, updated_at desc);

create table public.market_inventory_session_items (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    inventory_session_id uuid not null,
    product_id uuid not null,
    quantity numeric(14,3) not null check (quantity > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (inventory_session_id, product_id),
    foreign key (inventory_session_id, market_account_id)
        references public.market_inventory_sessions(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
);

create index ix_market_inventory_session_items_session
    on public.market_inventory_session_items (inventory_session_id, product_id);

alter table public.market_inventory_sessions enable row level security;
alter table public.market_inventory_session_items enable row level security;

-- Sem policies e sem grants de tabela: acesso exclusivamente pelas RPCs abaixo.
revoke all on public.market_inventory_sessions from public, anon, authenticated;
revoke all on public.market_inventory_session_items from public, anon, authenticated;

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
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    select m.* into v_member
    from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;

    if not exists (
        select 1 from public.market_stores s
        where s.id = p_market_store_id and s.market_account_id = p_market_account_id
          and (v_member.all_stores or v_member.role in ('owner','admin') or exists (
              select 1 from public.market_member_stores ms
              where ms.market_account_member_id = v_member.id and ms.market_store_id = s.id
          ))
    ) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: loja inexistente ou sem acesso.'; end if;

    select * into v_session from public.market_inventory_sessions
    where market_account_id = p_market_account_id and market_store_id = p_market_store_id
      and inventory_type = 'initial' and status = 'draft'
    limit 1;
    if not found then return null; end if;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'status', v_session.status,
        'startedAt', v_session.started_at, 'version', v_session.version,
        'createdAt', v_session.created_at, 'updatedAt', v_session.updated_at,
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
    v_item_count integer;
    v_distinct_count integer;
    v_valid_count integer;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if p_started_at is null or p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5000 then
        raise exception 'INVENTORY_INVALID_DRAFT: data e lista de itens invalidas.';
    end if;

    select s.* into v_store from public.market_stores s
    join public.market_accounts a on a.id = s.market_account_id and a.status in ('pilot','active')
    where s.id = p_market_store_id and s.status = 'active' for update of s;
    if not found or v_store.stock_control_started_at is not null then
        raise exception 'INVENTORY_STORE_UNAVAILABLE: loja indisponivel ou estoque ja iniciado.';
    end if;

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
            market_account_id, market_store_id, started_at, created_by
        ) values (v_store.market_account_id, v_store.id, p_started_at, auth.uid())
        returning * into v_session;
    else
        select * into v_session from public.market_inventory_sessions
        where id = p_inventory_session_id and market_account_id = v_store.market_account_id
          and market_store_id = v_store.id for update;
        if not found or v_session.status <> 'draft' then raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.'; end if;
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
    where (item->>'quantity')::numeric > 0;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'status', v_session.status,
        'startedAt', v_session.started_at, 'version', v_session.version,
        'createdAt', v_session.created_at, 'updatedAt', v_session.updated_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object('productId', i.product_id, 'quantity', i.quantity)
            order by i.created_at, i.product_id) from public.market_inventory_session_items i
            where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
exception when unique_violation then
    raise exception 'INVENTORY_DRAFT_CONFLICT: ja existe inventario inicial em andamento para esta loja.';
end;
$$;

create or replace function public.market_cancel_inventory_draft(
    p_inventory_session_id uuid,
    p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_session public.market_inventory_sessions; v_member public.market_account_members;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    select * into v_session from public.market_inventory_sessions where id = p_inventory_session_id;
    if not found or v_session.status <> 'draft' then raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.'; end if;
    select m.* into v_member from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = v_session.market_account_id and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found or v_member.role = 'viewer' then raise exception 'INVENTORY_PERMISSION_DENIED: usuario sem permissao.'; end if;
    if not (v_member.all_stores or v_member.role in ('owner','admin') or exists (
        select 1 from public.market_member_stores ms where ms.market_account_member_id = v_member.id
          and ms.market_store_id = v_session.market_store_id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;
    -- Mesma ordem de locks do autosave/finalizacao: loja antes da sessao.
    perform 1 from public.market_stores where id = v_session.market_store_id for update;
    select * into v_session from public.market_inventory_sessions
    where id = p_inventory_session_id and market_account_id = v_session.market_account_id for update;
    if not found or v_session.status <> 'draft' then raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.'; end if;
    if p_expected_version is null or v_session.version <> p_expected_version then
        raise exception 'INVENTORY_VERSION_CONFLICT: rascunho atualizado em outro dispositivo.';
    end if;
    update public.market_inventory_sessions set status = 'cancelled', cancelled_at = now(),
        updated_at = now(), version = version + 1 where id = v_session.id returning * into v_session;
    return jsonb_build_object('id', v_session.id, 'status', v_session.status, 'version', v_session.version);
end;
$$;

create or replace function public.market_finalize_inventory_draft(
    p_inventory_session_id uuid,
    p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_session public.market_inventory_sessions; v_items jsonb; v_stock_result jsonb;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    select * into v_session from public.market_inventory_sessions where id = p_inventory_session_id;
    if not found or v_session.status <> 'draft' then raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.'; end if;
    -- Mantem a ordem loja -> sessao usada pelo autosave e evita deadlock.
    perform 1 from public.market_stores where id = v_session.market_store_id for update;
    select * into v_session from public.market_inventory_sessions
    where id = p_inventory_session_id and market_account_id = v_session.market_account_id for update;
    if not found or v_session.status <> 'draft' then raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.'; end if;
    if p_expected_version is null or v_session.version <> p_expected_version then
        raise exception 'INVENTORY_VERSION_CONFLICT: rascunho atualizado em outro dispositivo.';
    end if;
    select jsonb_agg(jsonb_build_object('productId', i.product_id, 'quantity', i.quantity)
        order by i.created_at, i.product_id) into v_items
    from public.market_inventory_session_items i where i.inventory_session_id = v_session.id and i.quantity > 0;
    if v_items is null or jsonb_array_length(v_items) = 0 then raise exception 'INVENTORY_EMPTY: informe ao menos um produto.'; end if;

    -- Reutiliza autenticacao, membership, escopo, lock da loja, produtos e
    -- idempotencia da fundacao ja aplicada. A chamada participa desta transacao.
    v_stock_result := public.market_start_stock_control(v_session.market_store_id, v_session.started_at, v_items);

    update public.market_inventory_sessions set status = 'completed', completed_at = now(),
        updated_at = now(), version = version + 1 where id = v_session.id returning * into v_session;
    return v_stock_result || jsonb_build_object(
        'inventorySessionId', v_session.id, 'inventorySessionStatus', v_session.status,
        'inventorySessionVersion', v_session.version
    );
end;
$$;

revoke all on function public.market_get_inventory_draft(uuid,uuid) from public;
revoke all on function public.market_save_inventory_draft(uuid,uuid,integer,timestamptz,jsonb) from public;
revoke all on function public.market_cancel_inventory_draft(uuid,integer) from public;
revoke all on function public.market_finalize_inventory_draft(uuid,integer) from public;
grant execute on function public.market_get_inventory_draft(uuid,uuid) to authenticated;
grant execute on function public.market_save_inventory_draft(uuid,uuid,integer,timestamptz,jsonb) to authenticated;
grant execute on function public.market_cancel_inventory_draft(uuid,integer) to authenticated;
grant execute on function public.market_finalize_inventory_draft(uuid,integer) to authenticated;

commit;
