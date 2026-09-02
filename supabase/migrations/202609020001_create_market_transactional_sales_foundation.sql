-- GiroMicro Market - Sprint 4A: fundacao de vendas transacionais e integracoes.
-- Esta migration nao altera o fluxo existente de importacao por arquivo e nao
-- gera movimentos de estoque.
begin;

-- =========================================================
-- 1. INTEGRACOES EXTERNAS POR CONTA
-- Configuracao nao sensivel fica em market_integrations. Credenciais de cada
-- Market ficam cifradas e isoladas em market_integration_credentials; a chave
-- de criptografia permanece fora do banco, em secret exclusivamente server-side.
-- =========================================================

create table public.market_integrations (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null
        references public.market_accounts(id) on delete cascade,
    provider text not null check (provider = lower(btrim(provider)) and provider <> ''),
    base_url text not null check (base_url = btrim(base_url) and base_url ~ '^https://[^[:space:]]+$'),
    external_company_id text not null check (external_company_id = btrim(external_company_id) and external_company_id <> ''),
    status text not null default 'inactive'
        check (status in ('inactive','active','error')),
    last_sync_at timestamptz null,
    last_success_at timestamptz null,
    last_error text null,
    last_test_at timestamptz null,
    last_test_succeeded boolean null,
    last_test_error text null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    unique (id, market_account_id, provider),
    unique (market_account_id, provider, external_company_id),
    check (last_success_at is null or last_sync_at is null or last_success_at <= last_sync_at)
);

create index ix_market_integrations_account_status
    on public.market_integrations (market_account_id, status);

create index ix_market_integrations_provider_company
    on public.market_integrations (provider, external_company_id);

comment on table public.market_integrations is
    'Configuracao nao sensivel de uma integracao externa pertencente a uma conta Market.';
comment on column public.market_integrations.provider is
    'Identificador normalizado do provider, por exemplo accesys; nao contem credenciais.';

-- Tabela deliberadamente sem policies e sem grants para papeis de frontend.
-- A senha individual de cada Market fica no banco somente como ciphertext
-- produzido pelo backend. A chave de criptografia fica fora do banco. Bearer
-- tokens serao obtidos dinamicamente e nao sao configuracao permanente.
create table public.market_integration_credentials (
    integration_id uuid primary key,
    market_account_id uuid not null,
    username text not null check (username = btrim(username) and username <> ''),
    password_ciphertext bytea not null check (octet_length(password_ciphertext) > 0),
    encryption_version integer not null check (encryption_version > 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (integration_id, market_account_id)
        references public.market_integrations(id, market_account_id) on delete cascade
);

create index ix_market_integration_credentials_account
    on public.market_integration_credentials (market_account_id);

comment on table public.market_integration_credentials is
    'Credenciais cifradas de uso exclusivamente server-side. Nao armazena chave de criptografia nem Bearer token.';
comment on column public.market_integration_credentials.password_ciphertext is
    'Envelope cifrado (incluindo metadados como nonce/tag) produzido pelo backend; a chave permanece em secret externo ao banco.';

-- =========================================================
-- 2. REFERENCIAS DE LOJAS EXTERNAS
-- market_external_store_mappings permanece intacta para o fluxo legado.
-- =========================================================

create table public.market_store_external_refs (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    integration_id uuid not null,
    external_store_id text not null check (external_store_id = btrim(external_store_id) and external_store_id <> ''),
    external_store_name text null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id, market_store_id, integration_id),
    unique (market_account_id, integration_id, external_store_id),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id) on delete cascade,
    foreign key (integration_id, market_account_id)
        references public.market_integrations(id, market_account_id) on delete cascade
);

create index ix_market_store_external_refs_store
    on public.market_store_external_refs (market_account_id, market_store_id);

create index ix_market_store_external_refs_integration
    on public.market_store_external_refs (integration_id, external_store_id);

-- =========================================================
-- 3. VENDAS TRANSACIONAIS
-- Idempotencia usa a integracao quando presente e source_system para fontes
-- sem integracao configurada. Periodos de sincronizacao nunca sao a chave.
-- =========================================================

create table public.market_sales (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    integration_id uuid null,
    store_external_ref_id uuid null,
    source_type text not null
        check (source_type in ('api','file','manual','other')),
    source_system text not null check (source_system = lower(btrim(source_system)) and source_system <> ''),
    external_order_id text null,
    sold_at timestamptz not null,
    items_quantity numeric(14,3) not null default 0 check (items_quantity >= 0),
    subtotal_amount numeric(14,2) not null default 0 check (subtotal_amount >= 0),
    discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
    coupon_amount numeric(14,2) not null default 0 check (coupon_amount >= 0),
    total_amount numeric(14,2) not null default 0 check (total_amount >= 0),
    external_status text null,
    is_refunded boolean not null default false,
    has_error boolean not null default false,
    raw_data jsonb null,
    first_synced_at timestamptz null,
    last_synced_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id),
    foreign key (integration_id, market_account_id, source_system)
        references public.market_integrations(id, market_account_id, provider),
    foreign key (store_external_ref_id, market_account_id, market_store_id, integration_id)
        references public.market_store_external_refs(id, market_account_id, market_store_id, integration_id),
    check (external_order_id is null or (external_order_id = btrim(external_order_id) and external_order_id <> '')),
    check (store_external_ref_id is null or integration_id is not null),
    check (
        source_type <> 'api'
        or (
            integration_id is not null
            and store_external_ref_id is not null
            and external_order_id is not null
        )
    ),
    check (last_synced_at is null or first_synced_at is null or first_synced_at <= last_synced_at)
);

create unique index ux_market_sales_integration_order
    on public.market_sales (market_account_id, integration_id, external_order_id)
    where integration_id is not null and external_order_id is not null;

create unique index ux_market_sales_source_order_without_integration
    on public.market_sales (market_account_id, source_system, external_order_id)
    where integration_id is null and external_order_id is not null;

create index ix_market_sales_account_sold_at
    on public.market_sales (market_account_id, sold_at desc);

create index ix_market_sales_store_sold_at
    on public.market_sales (market_store_id, sold_at desc);

create index ix_market_sales_integration_sync
    on public.market_sales (integration_id, last_synced_at desc)
    where integration_id is not null;

create index ix_market_sales_store_external_ref
    on public.market_sales (store_external_ref_id)
    where store_external_ref_id is not null;

-- =========================================================
-- 4. ITENS E PAGAMENTOS
-- =========================================================

create table public.market_sale_items (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    sale_id uuid not null,
    product_id uuid null,
    external_item_id text null,
    external_product_id text null,
    external_ean text null,
    external_description text null,
    quantity numeric(14,3) not null check (quantity > 0),
    unit_price numeric(14,4) null check (unit_price is null or unit_price >= 0),
    sale_price numeric(14,4) null check (sale_price is null or sale_price >= 0),
    total_amount numeric(14,2) null check (total_amount is null or total_amount >= 0),
    discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
    net_amount numeric(14,2) null check (net_amount is null or net_amount >= 0),
    unit_cost_snapshot numeric(14,4) null
        check (unit_cost_snapshot is null or unit_cost_snapshot >= 0),
    total_cost_snapshot numeric(14,2) null
        check (total_cost_snapshot is null or total_cost_snapshot >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    foreign key (sale_id, market_account_id)
        references public.market_sales(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id),
    check (external_item_id is null or (external_item_id = btrim(external_item_id) and external_item_id <> '')),
    check (external_product_id is null or (external_product_id = btrim(external_product_id) and external_product_id <> '')),
    check (external_ean is null or (external_ean = btrim(external_ean) and external_ean <> ''))
);

create unique index ux_market_sale_items_external_item
    on public.market_sale_items (market_account_id, sale_id, external_item_id)
    where external_item_id is not null;

create index ix_market_sale_items_sale
    on public.market_sale_items (sale_id);

create index ix_market_sale_items_product
    on public.market_sale_items (market_account_id, product_id)
    where product_id is not null;

create index ix_market_sale_items_external_product
    on public.market_sale_items (market_account_id, external_product_id)
    where external_product_id is not null;

comment on column public.market_sale_items.unit_cost_snapshot is
    'Custo unitario historico conhecido/apurado para a venda; permanece NULL sem fonte confiavel e nunca copia automaticamente o custo atual.';
comment on column public.market_sale_items.total_cost_snapshot is
    'Custo total historico conhecido/apurado para a venda; permanece NULL sem fonte confiavel e nao calcula lucro automaticamente.';

create table public.market_sale_payments (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    sale_id uuid not null,
    external_payment_id text null,
    amount numeric(14,2) not null check (amount >= 0),
    paid_at timestamptz null,
    method text null,
    description text null,
    brand text null,
    card_type text null,
    authorization_id text null,
    raw_data jsonb null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    foreign key (sale_id, market_account_id)
        references public.market_sales(id, market_account_id) on delete cascade,
    check (external_payment_id is null or (external_payment_id = btrim(external_payment_id) and external_payment_id <> ''))
);

create unique index ux_market_sale_payments_external_payment
    on public.market_sale_payments (market_account_id, sale_id, external_payment_id)
    where external_payment_id is not null;

create index ix_market_sale_payments_sale
    on public.market_sale_payments (sale_id);

-- =========================================================
-- 5. DADOS COMERCIAIS EXTERNOS DE PRODUTO POR LOJA
-- external_available_quantity e apenas diagnostico; nao ha trigger, FK ou
-- funcao que a propague para market_stock_movements/market_stock_balance.
-- =========================================================

create table public.market_product_store_data (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    market_store_id uuid not null,
    product_id uuid not null,
    integration_id uuid not null,
    store_external_ref_id uuid not null,
    external_product_id text not null check (external_product_id = btrim(external_product_id) and external_product_id <> ''),
    external_product_site_id text null,
    current_cost numeric(14,4) null check (current_cost is null or current_cost >= 0),
    current_sale_price numeric(14,4) null check (current_sale_price is null or current_sale_price >= 0),
    promotion_price numeric(14,4) null check (promotion_price is null or promotion_price >= 0),
    loyalty_price numeric(14,4) null check (loyalty_price is null or loyalty_price >= 0),
    minimum_quantity numeric(14,3) null check (minimum_quantity is null or minimum_quantity >= 0),
    maximum_quantity numeric(14,3) null check (maximum_quantity is null or maximum_quantity >= 0),
    ideal_quantity numeric(14,3) null check (ideal_quantity is null or ideal_quantity >= 0),
    external_available_quantity numeric(14,3) null,
    source_synced_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (market_account_id, integration_id, market_store_id, external_product_id),
    foreign key (market_store_id, market_account_id)
        references public.market_stores(id, market_account_id) on delete cascade,
    foreign key (product_id, market_account_id)
        references public.market_products(id, market_account_id) on delete cascade,
    foreign key (integration_id, market_account_id)
        references public.market_integrations(id, market_account_id) on delete cascade,
    foreign key (store_external_ref_id, market_account_id, market_store_id, integration_id)
        references public.market_store_external_refs(id, market_account_id, market_store_id, integration_id)
        on delete cascade,
    check (external_product_site_id is null or (external_product_site_id = btrim(external_product_site_id) and external_product_site_id <> '')),
    check (minimum_quantity is null or maximum_quantity is null or minimum_quantity <= maximum_quantity)
);

create index ix_market_product_store_data_store_product
    on public.market_product_store_data (market_account_id, market_store_id, product_id);

create index ix_market_product_store_data_product
    on public.market_product_store_data (market_account_id, product_id);

create index ix_market_product_store_data_integration_sync
    on public.market_product_store_data (integration_id, source_synced_at desc);

create index ix_market_product_store_data_external_product
    on public.market_product_store_data (market_account_id, integration_id, external_product_id);

-- =========================================================
-- 6. TIMESTAMPS E REGRA DE LOCAL COMERCIAL
-- =========================================================

create trigger market_integrations_set_updated_at
before update on public.market_integrations
for each row execute function public.set_updated_at();

create trigger market_store_external_refs_set_updated_at
before update on public.market_store_external_refs
for each row execute function public.set_updated_at();

create trigger market_integration_credentials_set_updated_at
before update on public.market_integration_credentials
for each row execute function public.set_updated_at();

create trigger market_sales_set_updated_at
before update on public.market_sales
for each row execute function public.set_updated_at();

create trigger market_sale_items_set_updated_at
before update on public.market_sale_items
for each row execute function public.set_updated_at();

create trigger market_sale_payments_set_updated_at
before update on public.market_sale_payments
for each row execute function public.set_updated_at();

create trigger market_product_store_data_set_updated_at
before update on public.market_product_store_data
for each row execute function public.set_updated_at();

create function public.market_reject_warehouse_transactional_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_store_type text;
begin
    select s.store_type into v_store_type
    from public.market_stores s
    where s.id = new.market_store_id
      and s.market_account_id = new.market_account_id
    for share;

    if not found then
        raise exception 'SALE_STORE_NOT_FOUND: local inexistente ou pertencente a outra conta.';
    end if;
    if v_store_type <> 'store' then
        raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: galpao nao pode receber venda.';
    end if;
    return new;
end;
$$;

create trigger market_sales_reject_warehouse
before insert or update of market_account_id, market_store_id
on public.market_sales
for each row execute function public.market_reject_warehouse_transactional_sale();

revoke all on function public.market_reject_warehouse_transactional_sale()
    from public, anon, authenticated;

-- =========================================================
-- 7. RLS E GRANTS
-- =========================================================

alter table public.market_integrations enable row level security;
alter table public.market_integration_credentials enable row level security;
alter table public.market_store_external_refs enable row level security;
alter table public.market_sales enable row level security;
alter table public.market_sale_items enable row level security;
alter table public.market_sale_payments enable row level security;
alter table public.market_product_store_data enable row level security;

-- Sem policies: mesmo usuarios autenticados que administram a conta nao podem
-- ler ou escrever credenciais diretamente. O backend futuro usara um papel
-- server-side dedicado/service role e nunca retornara password_ciphertext.
revoke all on public.market_integration_credentials
    from public, anon, authenticated;

create policy market_integrations_select
on public.market_integrations for select to authenticated
using (public.market_is_member(market_account_id));

create policy market_integrations_write
on public.market_integrations for all to authenticated
using (public.market_has_role(market_account_id, array['owner','admin','manager']))
with check (public.market_has_role(market_account_id, array['owner','admin','manager']));

create policy market_store_external_refs_select
on public.market_store_external_refs for select to authenticated
using (public.market_can_access_store(market_store_id));

create policy market_store_external_refs_write
on public.market_store_external_refs for all to authenticated
using (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager'])
)
with check (
    public.market_can_access_store(market_store_id)
    and public.market_has_role(market_account_id, array['owner','admin','manager'])
);

create policy market_sales_select
on public.market_sales for select to authenticated
using (public.market_can_access_store(market_store_id));

create policy market_sale_items_select
on public.market_sale_items for select to authenticated
using (
    exists (
        select 1 from public.market_sales s
        where s.id = sale_id
          and s.market_account_id = market_sale_items.market_account_id
          and public.market_can_access_store(s.market_store_id)
    )
);

create policy market_sale_payments_select
on public.market_sale_payments for select to authenticated
using (
    exists (
        select 1 from public.market_sales s
        where s.id = sale_id
          and s.market_account_id = market_sale_payments.market_account_id
          and public.market_can_access_store(s.market_store_id)
    )
);

create policy market_product_store_data_select
on public.market_product_store_data for select to authenticated
using (public.market_can_access_store(market_store_id));

revoke all on public.market_integrations from public, anon;
revoke all on public.market_store_external_refs from public, anon;
revoke all on public.market_sales from public, anon, authenticated;
revoke all on public.market_sale_items from public, anon, authenticated;
revoke all on public.market_sale_payments from public, anon, authenticated;
revoke all on public.market_product_store_data from public, anon, authenticated;

grant select, insert, update, delete on public.market_integrations to authenticated;
grant select, insert, update, delete on public.market_store_external_refs to authenticated;
grant select on public.market_sales to authenticated;
grant select on public.market_sale_items to authenticated;
grant select on public.market_sale_payments to authenticated;
grant select on public.market_product_store_data to authenticated;

-- A sincronizacao server-side conserva acesso explicito de escrita. service_role
-- possui BYPASSRLS no Supabase; nenhuma destas permissoes e exposta ao frontend.
grant all on public.market_integrations to service_role;
grant all on public.market_integration_credentials to service_role;
grant all on public.market_store_external_refs to service_role;
grant all on public.market_sales to service_role;
grant all on public.market_sale_items to service_role;
grant all on public.market_sale_payments to service_role;
grant all on public.market_product_store_data to service_role;

commit;
