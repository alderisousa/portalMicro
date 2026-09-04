-- GiroMicro Market - fundacao de compras por NF-e, staging e conciliacao.
-- Esta migration evolui as tabelas embrionarias criadas no core Market.
begin;

-- A compra aponta para uma localizacao Market (normalmente um galpao), sem
-- produzir movimento de estoque nesta etapa.
alter table public.market_purchases
    rename column market_store_id to destination_store_id;

alter table public.market_purchases
    rename column purchase_date to issued_at;

alter table public.market_purchases
    alter column issued_at type timestamptz using issued_at::timestamptz,
    alter column issued_at drop default,
    alter column issued_at drop not null;

alter table public.market_purchases
    drop constraint market_purchases_status_check;

update public.market_purchases
set status = case status
    when 'draft' then 'imported'
    when 'confirmed' then 'completed'
    else status
end;

alter table public.market_purchases
    alter column status set default 'imported',
    add constraint market_purchases_status_check check (
        status in ('imported','reconciling','pending','ready','receiving','completed','cancelled','failed')
    );

alter table public.market_purchases
    drop constraint market_purchases_source_type_check;

update public.market_purchases
set source_type = 'import'
where source_type = 'manual';

alter table public.market_purchases
    alter column source_type set default 'nfe',
    add constraint market_purchases_source_type_check check (
        source_type in ('qrcode','nfe','xml','pdf','image','import','api')
    ),
    add column invoice_series text null,
    add column received_at timestamptz null,
    add column products_amount numeric(14,2) null check (products_amount is null or products_amount >= 0),
    add column freight_amount numeric(14,2) null check (freight_amount is null or freight_amount >= 0),
    add column discount_amount numeric(14,2) null check (discount_amount is null or discount_amount >= 0),
    add column other_amount numeric(14,2) null check (other_amount is null or other_amount >= 0),
    add column source_reference text null,
    add column raw_payload jsonb null,
    add column updated_at timestamptz not null default now();

create unique index ux_market_purchases_account_invoice_key
    on public.market_purchases (market_account_id, invoice_key)
    where invoice_key is not null and btrim(invoice_key) <> '';

create index ix_market_purchases_account_status_issued
    on public.market_purchases (market_account_id, status, issued_at desc);

-- Os itens guardam os dados fiscais originais. Identificacao do produto e
-- recebimento fisico sao estados independentes.
alter table public.market_purchase_items
    rename column purchase_id to market_purchase_id;

alter table public.market_purchase_items
    rename column product_id to market_product_id;

alter table public.market_purchase_items
    rename column external_description to description_raw;

alter table public.market_purchase_items
    rename column unit_cost to unit_price;

alter table public.market_purchase_items
    rename column total_cost to net_amount;

alter table public.market_purchase_items
    alter column market_product_id drop not null,
    add column line_number integer null,
    add column supplier_product_code text null,
    add column barcode_raw text null,
    add column barcode_normalized text null,
    add column ncm text null,
    add column cfop text null,
    add column unit text null,
    add column gross_amount numeric(14,2) null check (gross_amount is null or gross_amount >= 0),
    add column discount_amount numeric(14,2) not null default 0 check (discount_amount >= 0),
    add column freight_amount numeric(14,2) not null default 0 check (freight_amount >= 0),
    add column other_amount numeric(14,2) not null default 0 check (other_amount >= 0),
    add column calculated_unit_cost numeric(18,6)
        generated always as (case when net_amount is null then null else net_amount / quantity end) stored,
    add column reconciliation_status text not null default 'pending' check (
        reconciliation_status in ('pending','matched_auto','matched_manual','mapped','not_found','needs_review')
    ),
    add column reconciliation_confidence numeric(5,4) null check (
        reconciliation_confidence is null or reconciliation_confidence between 0 and 1
    ),
    add column reconciliation_method text null,
    add column reconciliation_notes text null,
    add column stock_entry_status text not null default 'pending' check (
        stock_entry_status in ('pending','ready','received','ignored','blocked')
    ),
    add column updated_at timestamptz not null default now(),
    add constraint market_purchase_items_id_account_unique unique (id, market_account_id),
    add constraint market_purchase_items_reconciliation_product_check check (
        reconciliation_status in ('pending','not_found','needs_review') or market_product_id is not null
    );

with numbered_items as (
    select id, row_number() over (partition by market_purchase_id order by created_at, id) as line_number
    from public.market_purchase_items
)
update public.market_purchase_items item
set line_number = numbered_items.line_number
from numbered_items
where numbered_items.id = item.id;

alter table public.market_purchase_items
    alter column line_number set not null,
    add constraint market_purchase_items_line_number_check check (line_number > 0),
    add constraint market_purchase_items_line_unique unique (market_purchase_id, line_number);

create index ix_market_purchase_items_purchase_reconciliation
    on public.market_purchase_items (market_account_id, market_purchase_id, reconciliation_status);

create index ix_market_purchase_items_purchase_stock_entry
    on public.market_purchase_items (market_account_id, market_purchase_id, stock_entry_status);

create index ix_market_purchase_items_barcode
    on public.market_purchase_items (market_account_id, barcode_normalized)
    where barcode_normalized is not null and btrim(barcode_normalized) <> '';

-- De/para proprio de fornecedor. Nao reutiliza o mapping da integracao, pois
-- aquele e gerenciado pela sincronizacao e tem escrita direta revogada.
create table public.market_purchase_product_mappings (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    supplier_document text null,
    supplier_product_code text null,
    barcode_normalized text null,
    description_normalized text null,
    market_product_id uuid not null,
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    foreign key (market_product_id, market_account_id)
        references public.market_products(id, market_account_id) on delete cascade,
    check (num_nonnulls(supplier_product_code, barcode_normalized, description_normalized) > 0)
);

create unique index ux_market_purchase_product_mappings_identity
    on public.market_purchase_product_mappings (
        market_account_id,
        coalesce(supplier_document, ''),
        coalesce(supplier_product_code, ''),
        coalesce(barcode_normalized, ''),
        coalesce(description_normalized, '')
    );

create index ix_market_purchase_product_mappings_product
    on public.market_purchase_product_mappings (market_account_id, market_product_id);

create or replace function public.market_touch_purchase_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

create trigger market_purchases_touch_updated_at
before update on public.market_purchases
for each row execute function public.market_touch_purchase_updated_at();

create trigger market_purchase_items_touch_updated_at
before update on public.market_purchase_items
for each row execute function public.market_touch_purchase_updated_at();

create trigger market_purchase_product_mappings_touch_updated_at
before update on public.market_purchase_product_mappings
for each row execute function public.market_touch_purchase_updated_at();

alter table public.market_purchase_product_mappings enable row level security;

-- As tabelas base contem custos. Operator nao recebe SELECT direto; uma camada
-- operacional sem valores podera ser exposta na etapa de recebimento.
drop policy if exists market_purchases_select on public.market_purchases;
create policy market_purchases_select
on public.market_purchases for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and public.market_can_access_store(destination_store_id)
);

drop policy if exists market_purchases_write on public.market_purchases;
create policy market_purchases_write
on public.market_purchases for all to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
    and public.market_can_access_store(destination_store_id)
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
    and public.market_can_access_store(destination_store_id)
);

drop policy if exists market_purchase_items_select on public.market_purchase_items;
create policy market_purchase_items_select
on public.market_purchase_items for select to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager','viewer'])
    and exists (
        select 1 from public.market_purchases p
        where p.id = market_purchase_id
          and p.market_account_id = market_purchase_items.market_account_id
          and public.market_can_access_store(p.destination_store_id)
    )
);

drop policy if exists market_purchase_items_write on public.market_purchase_items;
create policy market_purchase_items_write
on public.market_purchase_items for all to authenticated
using (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
    and exists (
        select 1 from public.market_purchases p
        where p.id = market_purchase_id
          and p.market_account_id = market_purchase_items.market_account_id
          and public.market_can_access_store(p.destination_store_id)
    )
)
with check (
    public.market_has_role(market_account_id, array['owner','admin','manager'])
    and exists (
        select 1 from public.market_purchases p
        where p.id = market_purchase_id
          and p.market_account_id = market_purchase_items.market_account_id
          and public.market_can_access_store(p.destination_store_id)
    )
);

create policy market_purchase_product_mappings_select
on public.market_purchase_product_mappings for select to authenticated
using (public.market_is_member(market_account_id));

create policy market_purchase_product_mappings_write
on public.market_purchase_product_mappings for all to authenticated
using (public.market_has_role(market_account_id, array['owner','admin','manager']))
with check (public.market_has_role(market_account_id, array['owner','admin','manager']));

revoke all on function public.market_touch_purchase_updated_at() from public, anon, authenticated;
grant select, insert, update, delete on table public.market_purchases to authenticated;
grant select, insert, update, delete on table public.market_purchase_items to authenticated;
grant select, insert, update, delete on table public.market_purchase_product_mappings to authenticated;

comment on table public.market_purchases is 'Staging de NF-e/compras; nao representa entrada confirmada em estoque.';
comment on column public.market_purchase_items.calculated_unit_cost is 'Custo efetivo unitario derivado do valor liquido original da linha.';
comment on column public.market_purchase_items.stock_entry_status is 'Estado fisico separado da conciliacao; received ainda nao gera ledger nesta etapa.';
comment on table public.market_purchase_product_mappings is 'De/para tenant-scoped entre identidades de fornecedor e produtos sincronizados.';

commit;
