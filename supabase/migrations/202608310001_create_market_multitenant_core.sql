-- GiroMicro Market
-- Migration: 202608310001_create_market_multitenant_core.sql
-- Objetivo: núcleo multi-tenant para gestão de múltiplos clientes/franqueados,
-- múltiplas lojas por cliente, múltiplos usuários por conta e estoque por loja.

begin;

create extension if not exists pgcrypto;

-- =========================================================
-- 1. CONTAS / TENANTS
-- =========================================================

create table if not exists public.market_accounts (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    status text not null default 'active'
        check (status in ('pilot','active','suspended','cancelled')),
    plan_code text not null default 'pilot',
    partner_referrer_user_id uuid null references auth.users(id) on delete set null,
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.market_account_members (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null
        check (role in ('owner','admin','manager','operator','viewer')),
    all_stores boolean not null default false,
    status text not null default 'active'
        check (status in ('invited','active','disabled')),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (market_account_id, user_id)
);

-- =========================================================
-- 2. LOJAS
-- =========================================================

create table if not exists public.market_stores (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    name text not null,
    external_code text null,
    description text null,
    status text not null default 'active'
        check (status in ('active','inactive')),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    unique (market_account_id, external_code)
);

create table if not exists public.market_member_stores (
    market_account_member_id uuid not null references public.market_account_members(id) on delete cascade,
    market_store_id uuid not null references public.market_stores(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (market_account_member_id, market_store_id)
);

-- =========================================================
-- 3. PRODUTOS E CONFIGURAÇÃO POR LOJA
-- =========================================================

create table if not exists public.market_products (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    sku text null,
    ean text null,
    name text not null,
    description text null,
    unit text not null default 'UN',
    status text not null default 'active'
        check (status in ('active','inactive')),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id)
);

create unique index if not exists ux_market_products_account_ean
    on public.market_products(market_account_id, ean)
    where ean is not null and btrim(ean) <> '';

create unique index if not exists ux_market_products_account_sku
    on public.market_products(market_account_id, sku)
    where sku is not null and btrim(sku) <> '';

create table if not exists public.market_store_products (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    product_id uuid not null,
    minimum_stock numeric(14,3) not null default 0 check (minimum_stock >= 0),
    sale_price numeric(14,2) null check (sale_price is null or sale_price >= 0),
    status text not null default 'active'
        check (status in ('active','inactive')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (market_store_id, product_id),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id) on delete cascade
);

-- =========================================================
-- 4. MAPEAMENTOS DE INTEGRAÇÃO
-- =========================================================

create table if not exists public.market_external_store_mappings (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    source_system text not null,
    external_store_code text not null,
    external_store_name text null,
    market_store_id uuid not null,
    created_at timestamptz not null default now(),
    unique (market_account_id, source_system, external_store_code),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id) on delete cascade
);

create table if not exists public.market_product_mappings (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    source_system text not null,
    external_product_code text null,
    external_ean text null,
    external_description text null,
    product_id uuid not null,
    confidence numeric(5,4) null check (confidence is null or (confidence >= 0 and confidence <= 1)),
    confirmed_by uuid null references auth.users(id) on delete set null,
    confirmed_at timestamptz null,
    created_at timestamptz not null default now(),
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id) on delete cascade
);

create index if not exists ix_market_product_mappings_lookup
    on public.market_product_mappings
       (market_account_id, source_system, external_product_code, external_ean);

-- =========================================================
-- 5. COMPRAS
-- =========================================================

create table if not exists public.market_purchases (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    supplier_name text null,
    supplier_document text null,
    invoice_number text null,
    invoice_key text null,
    purchase_date date not null default current_date,
    total_amount numeric(14,2) null check (total_amount is null or total_amount >= 0),
    status text not null default 'draft'
        check (status in ('draft','confirmed','cancelled')),
    source_type text not null default 'manual'
        check (source_type in ('manual','qrcode','nfe','pdf','image','import')),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    confirmed_at timestamptz null,
    unique (id, market_account_id),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id)
);

create table if not exists public.market_purchase_items (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    purchase_id uuid not null,
    product_id uuid not null,
    external_description text null,
    quantity numeric(14,3) not null check (quantity > 0),
    unit_cost numeric(14,4) null check (unit_cost is null or unit_cost >= 0),
    total_cost numeric(14,2) null check (total_cost is null or total_cost >= 0),
    created_at timestamptz not null default now(),
    foreign key (purchase_id, market_account_id)
        references public.market_purchases(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
);

-- =========================================================
-- 6. IMPORTAÇÃO DE VENDAS
-- Um arquivo pode conter N lojas do MESMO market_account.
-- =========================================================

create table if not exists public.market_sales_imports (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    file_name text not null,
    file_hash text null,
    source_system text not null default 'franchise_export',
    period_start date null,
    period_end date null,
    status text not null default 'uploaded'
        check (status in ('uploaded','processing','needs_mapping','processed','failed','cancelled')),
    total_rows integer not null default 0 check (total_rows >= 0),
    processed_rows integer not null default 0 check (processed_rows >= 0),
    error_rows integer not null default 0 check (error_rows >= 0),
    imported_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    processed_at timestamptz null,
    unique (id, market_account_id)
);

create unique index if not exists ux_market_sales_imports_account_hash
    on public.market_sales_imports(market_account_id, file_hash)
    where file_hash is not null and btrim(file_hash) <> '';

create table if not exists public.market_sales_import_rows (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    import_id uuid not null,
    row_number integer not null check (row_number > 0),
    market_store_id uuid null,
    external_store_code text null,
    external_store_name text null,
    product_id uuid null,
    external_product_code text null,
    external_ean text null,
    external_description text null,
    sale_date timestamptz null,
    quantity numeric(14,3) not null default 0,
    unit_price numeric(14,4) null,
    total_amount numeric(14,2) null,
    status text not null default 'pending'
        check (status in ('pending','mapped','processed','ignored','error')),
    error_message text null,
    raw_data jsonb null,
    created_at timestamptz not null default now(),
    unique (import_id, row_number),
    foreign key (import_id, market_account_id)
        references public.market_sales_imports(id, market_account_id) on delete cascade,
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id),
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
);

-- =========================================================
-- 7. TRANSFERÊNCIAS ENTRE LOJAS DO MESMO CLIENTE
-- =========================================================

create table if not exists public.market_transfers (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    source_store_id uuid not null,
    destination_store_id uuid not null,
    status text not null default 'draft'
        check (status in ('draft','confirmed','cancelled')),
    notes text null,
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    confirmed_at timestamptz null,
    unique (id, market_account_id),
    check (source_store_id <> destination_store_id),
    foreign key (source_store_id, market_account_id)
        references public.market_stores(id, market_account_id),
    foreign key (destination_store_id, market_account_id)
        references public.market_stores(id, market_account_id)
);

create table if not exists public.market_transfer_items (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    transfer_id uuid not null,
    product_id uuid not null,
    quantity numeric(14,3) not null check (quantity > 0),
    created_at timestamptz not null default now(),
    foreign key (transfer_id, market_account_id)
        references public.market_transfers(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
);

-- =========================================================
-- 8. LIVRO-RAZÃO DO ESTOQUE
-- quantity é SEMPRE positiva; direction define entrada/saída.
-- =========================================================

create table if not exists public.market_stock_movements (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    product_id uuid not null,
    movement_type text not null
        check (movement_type in (
            'PURCHASE',
            'SALE',
            'TRANSFER_IN',
            'TRANSFER_OUT',
            'ADJUSTMENT_IN',
            'ADJUSTMENT_OUT',
            'LOSS',
            'INVENTORY'
        )),
    direction text not null check (direction in ('IN','OUT')),
    quantity numeric(14,3) not null check (quantity > 0),
    unit_cost numeric(14,4) null check (unit_cost is null or unit_cost >= 0),
    reference_type text null,
    reference_id uuid null,
    notes text null,
    occurred_at timestamptz not null default now(),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id),
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id)
);

create index if not exists ix_market_stock_movements_store_product_date
    on public.market_stock_movements(market_store_id, product_id, occurred_at);

create index if not exists ix_market_stock_movements_account_date
    on public.market_stock_movements(market_account_id, occurred_at);

-- Saldo derivado das movimentações.
create or replace view public.market_stock_balance as
select
    m.market_account_id,
    m.market_store_id,
    m.product_id,
    sum(
        case
            when m.direction = 'IN' then m.quantity
            else -m.quantity
        end
    )::numeric(14,3) as quantity_on_hand,
    max(m.occurred_at) as last_movement_at
from public.market_stock_movements m
group by
    m.market_account_id,
    m.market_store_id,
    m.product_id;

-- =========================================================
-- 9. FUNÇÕES DE AUTORIZAÇÃO
-- A função public.is_admin() já existe no GiroMicro e representa
-- o administrador geral da plataforma.
-- =========================================================

create or replace function public.market_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(public.is_admin(), false);
$$;

create or replace function public.market_is_member(p_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        public.market_is_platform_admin()
        or exists (
            select 1
            from public.market_account_members m
            where m.market_account_id = p_account_id
              and m.user_id = auth.uid()
              and m.status = 'active'
        );
$$;

create or replace function public.market_has_role(
    p_account_id uuid,
    p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        public.market_is_platform_admin()
        or exists (
            select 1
            from public.market_account_members m
            where m.market_account_id = p_account_id
              and m.user_id = auth.uid()
              and m.status = 'active'
              and m.role = any(p_roles)
        );
$$;

create or replace function public.market_can_access_store(p_store_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        public.market_is_platform_admin()
        or exists (
            select 1
            from public.market_stores s
            join public.market_account_members m
              on m.market_account_id = s.market_account_id
             and m.user_id = auth.uid()
             and m.status = 'active'
            where s.id = p_store_id
              and (
                    m.all_stores = true
                    or m.role in ('owner','admin')
                    or exists (
                        select 1
                        from public.market_member_stores ms
                        where ms.market_account_member_id = m.id
                          and ms.market_store_id = s.id
                    )
              )
        );
$$;

revoke all on function public.market_is_platform_admin() from public;
revoke all on function public.market_is_member(uuid) from public;
revoke all on function public.market_has_role(uuid,text[]) from public;
revoke all on function public.market_can_access_store(uuid) from public;

grant execute on function public.market_is_platform_admin() to authenticated;
grant execute on function public.market_is_member(uuid) to authenticated;
grant execute on function public.market_has_role(uuid,text[]) to authenticated;
grant execute on function public.market_can_access_store(uuid) to authenticated;

-- =========================================================
-- 10. RPC ADMIN PARA CRIAR CONTA + OWNER ATOMICAMENTE
-- =========================================================

create or replace function public.admin_create_market_account(
    p_name text,
    p_owner_user_id uuid,
    p_plan_code text default 'pilot',
    p_partner_referrer_user_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_account_id uuid;
begin
    if not public.market_is_platform_admin() then
        raise exception 'Acesso negado.';
    end if;

    if not exists (select 1 from auth.users where id = p_owner_user_id) then
        raise exception 'Usuário proprietário não encontrado.';
    end if;

    insert into public.market_accounts (
        name,
        status,
        plan_code,
        partner_referrer_user_id,
        created_by
    )
    values (
        btrim(p_name),
        'pilot',
        coalesce(nullif(btrim(p_plan_code), ''), 'pilot'),
        p_partner_referrer_user_id,
        auth.uid()
    )
    returning id into v_account_id;

    insert into public.market_account_members (
        market_account_id,
        user_id,
        role,
        all_stores,
        status,
        created_by
    )
    values (
        v_account_id,
        p_owner_user_id,
        'owner',
        true,
        'active',
        auth.uid()
    );

    return v_account_id;
end;
$$;

revoke all on function public.admin_create_market_account(text,uuid,text,uuid) from public;
grant execute on function public.admin_create_market_account(text,uuid,text,uuid) to authenticated;

-- =========================================================
-- 11. RLS
-- =========================================================

alter table public.market_accounts enable row level security;
alter table public.market_account_members enable row level security;
alter table public.market_stores enable row level security;
alter table public.market_member_stores enable row level security;
alter table public.market_products enable row level security;
alter table public.market_store_products enable row level security;
alter table public.market_external_store_mappings enable row level security;
alter table public.market_product_mappings enable row level security;
alter table public.market_purchases enable row level security;
alter table public.market_purchase_items enable row level security;
alter table public.market_sales_imports enable row level security;
alter table public.market_sales_import_rows enable row level security;
alter table public.market_transfers enable row level security;
alter table public.market_transfer_items enable row level security;
alter table public.market_stock_movements enable row level security;

-- Accounts
create policy market_accounts_select
on public.market_accounts for select
to authenticated
using (public.market_is_member(id));

create policy market_accounts_admin_insert
on public.market_accounts for insert
to authenticated
with check (public.market_is_platform_admin());

create policy market_accounts_admin_update
on public.market_accounts for update
to authenticated
using (public.market_is_platform_admin())
with check (public.market_is_platform_admin());

create policy market_accounts_admin_delete
on public.market_accounts for delete
to authenticated
using (public.market_is_platform_admin());

-- Members
create policy market_members_select
on public.market_account_members for select
to authenticated
using (public.market_is_member(market_account_id));

create policy market_members_insert
on public.market_account_members for insert
to authenticated
with check (
    public.market_has_role(market_account_id, array['owner','admin'])
);

create policy market_members_update
on public.market_account_members for update
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin'])
);

create policy market_members_delete
on public.market_account_members for delete
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin'])
);

-- Stores
create policy market_stores_select
on public.market_stores for select
to authenticated
using (public.market_can_access_store(id));

create policy market_stores_insert
on public.market_stores for insert
to authenticated
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
);

create policy market_stores_update
on public.market_stores for update
to authenticated
using (
    public.market_can_access_store(id)
    and public.market_has_role(market_account_id, array['owner','admin','manager'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
);

create policy market_stores_delete
on public.market_stores for delete
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin'])
);

-- Member -> Stores
create policy market_member_stores_select
on public.market_member_stores for select
to authenticated
using (
    exists (
        select 1
        from public.market_account_members m
        where m.id = market_account_member_id
          and public.market_is_member(m.market_account_id)
    )
);

create policy market_member_stores_write
on public.market_member_stores for all
to authenticated
using (
    exists (
        select 1
        from public.market_account_members m
        where m.id = market_account_member_id
          and public.market_has_role(m.market_account_id, array['owner','admin'])
    )
)
with check (
    exists (
        select 1
        from public.market_account_members m
        where m.id = market_account_member_id
          and public.market_has_role(m.market_account_id, array['owner','admin'])
    )
);

-- Products
create policy market_products_select
on public.market_products for select
to authenticated
using (public.market_is_member(market_account_id));

create policy market_products_write
on public.market_products for all
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
);

-- Store products
create policy market_store_products_select
on public.market_store_products for select
to authenticated
using (public.market_can_access_store(market_store_id));

create policy market_store_products_write
on public.market_store_products for all
to authenticated
using (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
)
with check (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
);

-- External store mappings
create policy market_external_store_mappings_select
on public.market_external_store_mappings for select
to authenticated
using (public.market_is_member(market_account_id));

create policy market_external_store_mappings_write
on public.market_external_store_mappings for all
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
);

-- Product mappings
create policy market_product_mappings_select
on public.market_product_mappings for select
to authenticated
using (public.market_is_member(market_account_id));

create policy market_product_mappings_write
on public.market_product_mappings for all
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
);

-- Purchases
create policy market_purchases_select
on public.market_purchases for select
to authenticated
using (public.market_can_access_store(market_store_id));

create policy market_purchases_write
on public.market_purchases for all
to authenticated
using (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
)
with check (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
);

create policy market_purchase_items_select
on public.market_purchase_items for select
to authenticated
using (
    exists (
        select 1
        from public.market_purchases p
        where p.id = purchase_id
          and p.market_account_id = market_purchase_items.market_account_id
          and public.market_can_access_store(p.market_store_id)
    )
);

create policy market_purchase_items_write
on public.market_purchase_items for all
to authenticated
using (
    exists (
        select 1
        from public.market_purchases p
        where p.id = purchase_id
          and p.market_account_id = market_purchase_items.market_account_id
          and public.market_can_access_store(p.market_store_id)
          and public.market_has_role(p.market_account_id, array['owner','admin','manager','operator'])
    )
)
with check (
    exists (
        select 1
        from public.market_purchases p
        where p.id = purchase_id
          and p.market_account_id = market_purchase_items.market_account_id
          and public.market_can_access_store(p.market_store_id)
          and public.market_has_role(p.market_account_id, array['owner','admin','manager','operator'])
    )
);

-- Imports: owner/admin/manager podem importar arquivo multi-loja.
create policy market_sales_imports_select
on public.market_sales_imports for select
to authenticated
using (public.market_is_member(market_account_id));

create policy market_sales_imports_write
on public.market_sales_imports for all
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
);

create policy market_sales_import_rows_select
on public.market_sales_import_rows for select
to authenticated
using (
    public.market_is_member(market_account_id)
    and (
        market_store_id is null
        or public.market_can_access_store(market_store_id)
    )
);

create policy market_sales_import_rows_write
on public.market_sales_import_rows for all
to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
);

-- Transfers: acesso obrigatório às duas lojas.
create policy market_transfers_select
on public.market_transfers for select
to authenticated
using (
    public.market_can_access_store(source_store_id)
    and public.market_can_access_store(destination_store_id)
);

create policy market_transfers_write
on public.market_transfers for all
to authenticated
using (
    public.market_can_access_store(source_store_id)
    and public.market_can_access_store(destination_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
)
with check (
    public.market_can_access_store(source_store_id)
    and public.market_can_access_store(destination_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
);

create policy market_transfer_items_select
on public.market_transfer_items for select
to authenticated
using (
    exists (
        select 1
        from public.market_transfers t
        where t.id = transfer_id
          and t.market_account_id = market_transfer_items.market_account_id
          and public.market_can_access_store(t.source_store_id)
          and public.market_can_access_store(t.destination_store_id)
    )
);

create policy market_transfer_items_write
on public.market_transfer_items for all
to authenticated
using (
    exists (
        select 1
        from public.market_transfers t
        where t.id = transfer_id
          and t.market_account_id = market_transfer_items.market_account_id
          and public.market_can_access_store(t.source_store_id)
          and public.market_can_access_store(t.destination_store_id)
          and public.market_has_role(t.market_account_id, array['owner','admin','manager','operator'])
    )
)
with check (
    exists (
        select 1
        from public.market_transfers t
        where t.id = transfer_id
          and t.market_account_id = market_transfer_items.market_account_id
          and public.market_can_access_store(t.source_store_id)
          and public.market_can_access_store(t.destination_store_id)
          and public.market_has_role(t.market_account_id, array['owner','admin','manager','operator'])
    )
);

-- Movements
create policy market_stock_movements_select
on public.market_stock_movements for select
to authenticated
using (public.market_can_access_store(market_store_id));

create policy market_stock_movements_insert
on public.market_stock_movements for insert
to authenticated
with check (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager','operator'])
);

-- Movimentação histórica não deve ser alterada/apagada pelo usuário normal.
create policy market_stock_movements_admin_update
on public.market_stock_movements for update
to authenticated
using (public.market_is_platform_admin())
with check (public.market_is_platform_admin());

create policy market_stock_movements_admin_delete
on public.market_stock_movements for delete
to authenticated
using (public.market_is_platform_admin());

-- =========================================================
-- 12. GRANTS
-- =========================================================

grant select on public.market_stock_balance to authenticated;

commit;
