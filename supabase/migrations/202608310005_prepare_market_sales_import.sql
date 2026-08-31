-- GiroMicro Market - Sprint 2A: fundação auditável da importação de vendas.
-- Não realiza parsing, não gera estoque e não cria movimentações SALE.
begin;

-- =========================================================
-- 1. CABEÇALHO / CICLO DA IMPORTAÇÃO
-- created_at permanece sendo a data/hora de importação.
-- file_name já representa o nome bruto apresentado pelo arquivo de origem.
-- =========================================================

alter table public.market_sales_imports
    add column if not exists pending_rows integer not null default 0,
    add column if not exists global_error_message text;

alter table public.market_sales_imports
    drop constraint if exists market_sales_imports_status_check;

update public.market_sales_imports
set status = case status
    when 'processed' then 'completed'
    when 'needs_mapping' then 'completed_with_pending'
    else status
end;

alter table public.market_sales_imports
    add constraint market_sales_imports_status_check
    check (status in (
        'uploaded',
        'validating',
        'ready',
        'processing',
        'completed',
        'completed_with_pending',
        'failed',
        'cancelled'
    )),
    add constraint market_sales_imports_period_check
    check (period_start is null or period_end is null or period_start <= period_end),
    add constraint market_sales_imports_pending_rows_check
    check (pending_rows >= 0);

comment on column public.market_sales_imports.created_at is
    'Data e hora em que o registro/arquivo foi importado para o GiroMicro Market.';
comment on column public.market_sales_imports.file_name is
    'Nome original do arquivo informado pela origem.';
comment on column public.market_sales_imports.file_hash is
    'Hash do arquivo para idempotência por market_account; obrigatório no futuro fluxo de confirmação.';
comment on column public.market_sales_imports.period_start is
    'Início inclusivo do período comercial consolidado no relatório.';
comment on column public.market_sales_imports.period_end is
    'Fim inclusivo do período comercial consolidado no relatório.';

-- O índice parcial existente ux_market_sales_imports_account_hash já garante
-- idempotência por tenant quando o hash está preenchido.
create index if not exists ix_market_sales_imports_account_created
    on public.market_sales_imports (market_account_id, created_at desc);

create index if not exists ix_market_sales_imports_account_period
    on public.market_sales_imports (market_account_id, period_start, period_end);

-- =========================================================
-- 2. LINHAS CONSOLIDADAS E AUDITORIA
-- Uma linha representa LOJA + PRODUTO + PERÍODO, não uma venda individual.
-- Os campos external_* e raw_data são o dado original. market_store_id e
-- product_id são associações resolvidas e podem mudar sem apagar a origem.
-- =========================================================

alter table public.market_sales_import_rows
    add column if not exists barcode_normalized text,
    add column if not exists total_cost numeric(18,4),
    add column if not exists profit numeric(18,4),
    add column if not exists markup numeric(18,6),
    add column if not exists markdown numeric(18,6),
    add column if not exists store_resolution_status text not null default 'pending',
    add column if not exists product_resolution_status text not null default 'pending',
    add column if not exists pending_reason text,
    add column if not exists error_code text;

alter table public.market_sales_import_rows
    alter column quantity type numeric(18,4) using quantity::numeric(18,4),
    alter column unit_price type numeric(18,4) using unit_price::numeric(18,4),
    alter column total_amount type numeric(18,4) using total_amount::numeric(18,4);

update public.market_sales_import_rows
set raw_data = '{}'::jsonb
where raw_data is null;

alter table public.market_sales_import_rows
    alter column raw_data set not null,
    alter column raw_data drop default;

update public.market_sales_import_rows
set
    store_resolution_status = case
        when market_store_id is not null then 'resolved'
        else 'pending'
    end,
    product_resolution_status = case
        when product_id is not null then 'resolved'
        else 'pending'
    end;

alter table public.market_sales_import_rows
    drop constraint if exists market_sales_import_rows_status_check;

alter table public.market_sales_import_rows
    add constraint market_sales_import_rows_status_check
    check (status in (
        'pending',
        'mapped',
        'processed',
        'store_pending',
        'product_pending',
        'invalid',
        'ignored',
        'error'
    )),
    add constraint market_sales_import_rows_store_resolution_check
    check (store_resolution_status in ('pending','resolved','invalid','conflict')),
    add constraint market_sales_import_rows_product_resolution_check
    check (product_resolution_status in ('pending','resolved','invalid','conflict')),
    add constraint market_sales_import_rows_store_resolution_consistency
    check (store_resolution_status <> 'resolved' or market_store_id is not null),
    add constraint market_sales_import_rows_product_resolution_consistency
    check (product_resolution_status <> 'resolved' or product_id is not null);

comment on column public.market_sales_import_rows.external_store_code is
    'Site Id bruto do arquivo; nunca sobrescrever durante a resolução da loja.';
comment on column public.market_sales_import_rows.external_store_name is
    'Nome bruto da loja no arquivo; nunca sobrescrever durante a resolução.';
comment on column public.market_sales_import_rows.external_ean is
    'Código de barras bruto como texto, preservando zeros e formatos não EAN-13.';
comment on column public.market_sales_import_rows.external_description is
    'Descrição bruta do produto no arquivo.';
comment on column public.market_sales_import_rows.quantity is
    'Quantidade Total consolidada no período; aceita frações e valores negativos de ajuste.';
comment on column public.market_sales_import_rows.raw_data is
    'Objeto integral da linha original para auditoria e reprocessamento.';
comment on column public.market_sales_import_rows.sale_date is
    'Campo legado opcional; o período oficial da linha é herdado de market_sales_imports.';

create index if not exists ix_market_sales_import_rows_store
    on public.market_sales_import_rows (market_account_id, market_store_id)
    where market_store_id is not null;

create index if not exists ix_market_sales_import_rows_product
    on public.market_sales_import_rows (market_account_id, product_id)
    where product_id is not null;

create index if not exists ix_market_sales_import_rows_external_store
    on public.market_sales_import_rows (market_account_id, external_store_code);

create index if not exists ix_market_sales_import_rows_external_ean
    on public.market_sales_import_rows (market_account_id, external_ean);

-- =========================================================
-- 3. CATÁLOGO E MAPEAMENTOS
-- market_products já possui EAN text e unicidade parcial por
-- (market_account_id, ean). Nenhuma unicidade global é criada.
-- O índice existente de market_product_mappings já cobre conta, fonte,
-- código externo e EAN; a estrutura atual é mantida.
-- =========================================================

comment on table public.market_products is
    'Catálogo interno por tenant, alimentável pelas importações; não é cadastro mestre da frente de loja.';
comment on table public.market_product_mappings is
    'Mapeamentos de identificadores externos para produtos internos da mesma market_account.';

-- =========================================================
-- 4. RLS DA IMPORTAÇÃO
-- A migration 004 tornou market_is_member/market_has_role sensíveis ao
-- status operacional da conta. Viewer pode consultar, mas não importar.
-- owner/admin/manager/operator podem preparar e processar importações.
-- =========================================================

drop policy if exists market_sales_imports_select on public.market_sales_imports;
create policy market_sales_imports_select
on public.market_sales_imports for select
to authenticated
using (public.market_is_member(market_account_id));

drop policy if exists market_sales_imports_write on public.market_sales_imports;
create policy market_sales_imports_write
on public.market_sales_imports for all
to authenticated
using (
    public.market_has_role(
        market_account_id,
        array['owner','admin','manager','operator']
    )
)
with check (
    public.market_has_role(
        market_account_id,
        array['owner','admin','manager','operator']
    )
);

drop policy if exists market_sales_import_rows_select on public.market_sales_import_rows;
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

drop policy if exists market_sales_import_rows_write on public.market_sales_import_rows;
create policy market_sales_import_rows_write
on public.market_sales_import_rows for all
to authenticated
using (
    public.market_has_role(
        market_account_id,
        array['owner','admin','manager','operator']
    )
)
with check (
    public.market_has_role(
        market_account_id,
        array['owner','admin','manager','operator']
    )
);

commit;
