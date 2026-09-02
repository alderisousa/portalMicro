-- GiroMicro Market - Sprint 4C.1 (proposta nao aplicada): suporte auditavel
-- a execucoes de sync e persistencia atomica de uma venda completa.
begin;

create table public.market_sales_sync_runs (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    integration_id uuid not null,
    period_start date not null,
    period_end date not null,
    status text not null default 'running'
        check (status in ('running','completed','partial','failed')),
    pages_read integer not null default 0 check (pages_read >= 0),
    orders_read integer not null default 0 check (orders_read >= 0),
    orders_inserted integer not null default 0 check (orders_inserted >= 0),
    orders_updated integer not null default 0 check (orders_updated >= 0),
    items_processed integer not null default 0 check (items_processed >= 0),
    payments_processed integer not null default 0 check (payments_processed >= 0),
    skipped_orders integer not null default 0 check (skipped_orders >= 0),
    error_message text null,
    requested_by uuid null references auth.users(id) on delete set null,
    started_at timestamptz not null default now(),
    finished_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    foreign key (integration_id, market_account_id)
        references public.market_integrations(id, market_account_id),
    check (period_start <= period_end),
    check (finished_at is null or finished_at >= started_at),
    check (
        (status = 'running' and finished_at is null)
        or (status in ('completed','partial','failed') and finished_at is not null)
    )
);

create index ix_market_sales_sync_runs_integration_started
    on public.market_sales_sync_runs (market_account_id, integration_id, started_at desc);

create table public.market_sales_sync_errors (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    sync_run_id uuid not null,
    external_order_id text null,
    external_store_id text null,
    error_code text not null check (error_code = upper(btrim(error_code)) and error_code <> ''),
    error_message text not null check (btrim(error_message) <> ''),
    created_at timestamptz not null default now(),
    foreign key (sync_run_id, market_account_id)
        references public.market_sales_sync_runs(id, market_account_id) on delete cascade,
    check (external_order_id is null or (external_order_id = btrim(external_order_id) and external_order_id <> '')),
    check (external_store_id is null or (external_store_id = btrim(external_store_id) and external_store_id <> ''))
);

create index ix_market_sales_sync_errors_run
    on public.market_sales_sync_errors (market_account_id, sync_run_id, created_at);

create index ix_market_sales_sync_errors_external_store
    on public.market_sales_sync_errors (market_account_id, external_store_id)
    where external_store_id is not null;

create trigger market_sales_sync_runs_set_updated_at
before update on public.market_sales_sync_runs
for each row execute function public.set_updated_at();

alter table public.market_sales_sync_runs enable row level security;
alter table public.market_sales_sync_errors enable row level security;

-- Sem acesso direto pelo frontend nesta etapa. A futura UI administrativa pode
-- receber somente um resumo sanitizado retornado pela Edge Function.
revoke all on public.market_sales_sync_runs from public, anon, authenticated;
revoke all on public.market_sales_sync_errors from public, anon, authenticated;
grant all on public.market_sales_sync_runs to service_role;
grant all on public.market_sales_sync_errors to service_role;

create function public.market_upsert_external_sale(
    p_market_account_id uuid,
    p_integration_id uuid,
    p_store_external_ref_id uuid,
    p_sale jsonb,
    p_items jsonb,
    p_payments jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
    v_provider text;
    v_market_store_id uuid;
    v_external_order_id text;
    v_sale_id uuid;
    v_existing_sale_id uuid;
    v_item jsonb;
    v_payment jsonb;
    v_item_ids text[] := array[]::text[];
    v_payment_ids text[] := array[]::text[];
    v_external_item_id text;
    v_external_payment_id text;
    v_items_snapshot_complete boolean;
    v_payments_snapshot_complete boolean;
begin
    if p_sale is null or jsonb_typeof(p_sale) <> 'object'
       or p_items is null or jsonb_typeof(p_items) <> 'array'
       or p_payments is null or jsonb_typeof(p_payments) <> 'array' then
        raise exception 'SYNC_INVALID_PAYLOAD: venda, itens e pagamentos normalizados sao obrigatorios.';
    end if;
    if jsonb_array_length(p_items) > 1000 or jsonb_array_length(p_payments) > 1000 then
        raise exception 'SYNC_INVALID_PAYLOAD: limite de itens ou pagamentos excedido.';
    end if;

    select i.provider into v_provider
    from public.market_integrations i
    join public.market_accounts a
      on a.id = i.market_account_id
     and a.status in ('pilot','active')
    where i.id = p_integration_id
      and i.market_account_id = p_market_account_id
      and i.status = 'active'
    for share of i;

    if not found then
        raise exception 'SYNC_INTEGRATION_UNAVAILABLE: integracao inexistente, inativa ou pertencente a outra conta.';
    end if;

    select r.market_store_id into v_market_store_id
    from public.market_store_external_refs r
    where r.id = p_store_external_ref_id
      and r.market_account_id = p_market_account_id
      and r.integration_id = p_integration_id
    for share;

    if not found then
        raise exception 'SYNC_STORE_MAPPING_NOT_FOUND: referencia de loja inexistente ou incompatível.';
    end if;

    v_external_order_id := nullif(btrim(p_sale->>'externalOrderId'), '');
    if v_external_order_id is null or nullif(btrim(p_sale->>'soldAt'), '') is null then
        raise exception 'SYNC_INVALID_SALE: externalOrderId e soldAt sao obrigatorios.';
    end if;
    if (p_sale->>'soldAt') !~ '([zZ]|[+-][0-9]{2}:[0-9]{2})$' then
        raise exception 'SYNC_AMBIGUOUS_TIMEZONE: soldAt deve possuir offset explicito antes da persistencia.';
    end if;
    begin
        perform (p_sale->>'soldAt')::timestamptz;
    exception when others then
        raise exception 'SYNC_INVALID_SALE: soldAt invalido.';
    end;

    if jsonb_typeof(p_sale->'itemsQuantity') <> 'number'
       or jsonb_typeof(p_sale->'subtotalAmount') <> 'number'
       or jsonb_typeof(p_sale->'discountAmount') <> 'number'
       or jsonb_typeof(p_sale->'couponAmount') <> 'number'
       or jsonb_typeof(p_sale->'totalAmount') <> 'number'
       or jsonb_typeof(p_sale->'isRefunded') <> 'boolean'
       or jsonb_typeof(p_sale->'hasError') <> 'boolean'
       or jsonb_typeof(p_sale->'itemsSnapshotComplete') <> 'boolean'
       or jsonb_typeof(p_sale->'paymentsSnapshotComplete') <> 'boolean' then
        raise exception 'SYNC_INVALID_SALE: totais, indicadores e completude dos snapshots devem ser informados com tipos validos.';
    end if;
    if (p_sale->>'itemsQuantity')::numeric < 0
       or (p_sale->>'subtotalAmount')::numeric < 0
       or (p_sale->>'discountAmount')::numeric < 0
       or (p_sale->>'couponAmount')::numeric < 0
       or (p_sale->>'totalAmount')::numeric < 0 then
        raise exception 'SYNC_INVALID_SALE: quantidades e valores nao podem ser negativos.';
    end if;
    if p_sale ? 'rawData'
       and p_sale->'rawData' <> 'null'::jsonb
       and jsonb_typeof(p_sale->'rawData') <> 'object' then
        raise exception 'SYNC_INVALID_SALE: rawData deve ser objeto sanitizado ou NULL.';
    end if;

    v_items_snapshot_complete := (p_sale->>'itemsSnapshotComplete')::boolean;
    v_payments_snapshot_complete := (p_sale->>'paymentsSnapshotComplete')::boolean;

    -- Serializa concorrencia para o mesmo pedido antes de consultar/inserir.
    perform pg_advisory_xact_lock(hashtextextended(
        p_market_account_id::text || ':' || p_integration_id::text || ':' || v_external_order_id,
        0
    ));

    select s.id into v_existing_sale_id
    from public.market_sales s
    where s.market_account_id = p_market_account_id
      and s.integration_id = p_integration_id
      and s.external_order_id = v_external_order_id
    for update;

    insert into public.market_sales (
        market_account_id, market_store_id, integration_id, store_external_ref_id,
        source_type, source_system, external_order_id, sold_at, items_quantity,
        subtotal_amount, discount_amount, coupon_amount, total_amount,
        external_status, is_refunded, has_error, raw_data,
        first_synced_at, last_synced_at
    ) values (
        p_market_account_id,
        v_market_store_id,
        p_integration_id,
        p_store_external_ref_id,
        'api',
        v_provider,
        v_external_order_id,
        (p_sale->>'soldAt')::timestamptz,
        (p_sale->>'itemsQuantity')::numeric,
        (p_sale->>'subtotalAmount')::numeric,
        (p_sale->>'discountAmount')::numeric,
        (p_sale->>'couponAmount')::numeric,
        (p_sale->>'totalAmount')::numeric,
        nullif(p_sale->>'externalStatus', ''),
        (p_sale->>'isRefunded')::boolean,
        (p_sale->>'hasError')::boolean,
        p_sale->'rawData',
        now(),
        now()
    )
    on conflict (market_account_id, integration_id, external_order_id)
        where integration_id is not null and external_order_id is not null
    do update set
        market_store_id = excluded.market_store_id,
        store_external_ref_id = excluded.store_external_ref_id,
        sold_at = excluded.sold_at,
        items_quantity = excluded.items_quantity,
        subtotal_amount = excluded.subtotal_amount,
        discount_amount = excluded.discount_amount,
        coupon_amount = excluded.coupon_amount,
        total_amount = excluded.total_amount,
        external_status = excluded.external_status,
        is_refunded = excluded.is_refunded,
        has_error = excluded.has_error,
        raw_data = excluded.raw_data,
        last_synced_at = now()
    returning id into v_sale_id;

    for v_item in select value from jsonb_array_elements(p_items) loop
        if jsonb_typeof(v_item) <> 'object' then
            raise exception 'SYNC_INVALID_ITEM: item normalizado invalido.';
        end if;
        v_external_item_id := nullif(btrim(v_item->>'externalItemId'), '');
        if v_external_item_id is null or jsonb_typeof(v_item->'quantity') <> 'number' then
            raise exception 'SYNC_INVALID_ITEM: externalItemId e quantity numerica sao obrigatorios.';
        end if;
        if (v_item->>'quantity')::numeric <= 0 then
            raise exception 'SYNC_INVALID_ITEM: quantity deve ser positiva.';
        end if;
        if jsonb_typeof(v_item->'discountAmount') <> 'number' then
            raise exception 'SYNC_INVALID_ITEM: discountAmount numerico e obrigatorio.';
        end if;
        if (v_item->>'discountAmount')::numeric < 0 then
            raise exception 'SYNC_INVALID_ITEM: discountAmount nao pode ser negativo.';
        end if;
        if exists (
            select 1
            from jsonb_each(v_item) field(key, value)
            where field.key in (
                'unitPrice','salePrice','totalAmount','netAmount',
                'unitCostSnapshot','totalCostSnapshot'
            )
              and field.value <> 'null'::jsonb
              and jsonb_typeof(field.value) <> 'number'
        ) then
            raise exception 'SYNC_INVALID_ITEM: valores monetarios opcionais devem ser numericos ou NULL.';
        end if;
        if coalesce((v_item->>'unitPrice')::numeric, 0) < 0
           or coalesce((v_item->>'salePrice')::numeric, 0) < 0
           or coalesce((v_item->>'totalAmount')::numeric, 0) < 0
           or coalesce((v_item->>'netAmount')::numeric, 0) < 0
           or coalesce((v_item->>'unitCostSnapshot')::numeric, 0) < 0
           or coalesce((v_item->>'totalCostSnapshot')::numeric, 0) < 0 then
            raise exception 'SYNC_INVALID_ITEM: valores monetarios nao podem ser negativos.';
        end if;
        if nullif(v_item->>'productId', '') is not null
           and (v_item->>'productId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
            raise exception 'SYNC_INVALID_ITEM: productId interno deve ser UUID valido ou NULL.';
        end if;
        if v_external_item_id = any(v_item_ids) then
            raise exception 'SYNC_DUPLICATE_ITEM: externalItemId repetido no pedido.';
        end if;
        v_item_ids := array_append(v_item_ids, v_external_item_id);

        insert into public.market_sale_items (
            market_account_id, sale_id, product_id, external_item_id,
            external_product_id, external_ean, external_description, quantity,
            unit_price, sale_price, total_amount, discount_amount, net_amount,
            unit_cost_snapshot, total_cost_snapshot
        ) values (
            p_market_account_id,
            v_sale_id,
            nullif(v_item->>'productId', '')::uuid,
            v_external_item_id,
            nullif(btrim(v_item->>'externalProductId'), ''),
            nullif(btrim(v_item->>'externalEan'), ''),
            nullif(v_item->>'externalDescription', ''),
            (v_item->>'quantity')::numeric,
            nullif(v_item->>'unitPrice', '')::numeric,
            nullif(v_item->>'salePrice', '')::numeric,
            nullif(v_item->>'totalAmount', '')::numeric,
            (v_item->>'discountAmount')::numeric,
            nullif(v_item->>'netAmount', '')::numeric,
            nullif(v_item->>'unitCostSnapshot', '')::numeric,
            nullif(v_item->>'totalCostSnapshot', '')::numeric
        )
        on conflict (market_account_id, sale_id, external_item_id)
            where external_item_id is not null
        do update set
            product_id = excluded.product_id,
            external_product_id = excluded.external_product_id,
            external_ean = excluded.external_ean,
            external_description = excluded.external_description,
            quantity = excluded.quantity,
            unit_price = excluded.unit_price,
            sale_price = excluded.sale_price,
            total_amount = excluded.total_amount,
            discount_amount = excluded.discount_amount,
            net_amount = excluded.net_amount,
            unit_cost_snapshot = excluded.unit_cost_snapshot,
            total_cost_snapshot = excluded.total_cost_snapshot;
    end loop;

    if v_items_snapshot_complete then
        delete from public.market_sale_items i
        where i.market_account_id = p_market_account_id
          and i.sale_id = v_sale_id
          and (i.external_item_id is null or not (i.external_item_id = any(v_item_ids)));
    end if;

    for v_payment in select value from jsonb_array_elements(p_payments) loop
        if jsonb_typeof(v_payment) <> 'object' then
            raise exception 'SYNC_INVALID_PAYMENT: pagamento normalizado invalido.';
        end if;
        v_external_payment_id := nullif(btrim(v_payment->>'externalPaymentId'), '');
        if v_external_payment_id is null or jsonb_typeof(v_payment->'amount') <> 'number' then
            raise exception 'SYNC_INVALID_PAYMENT: externalPaymentId e amount numerico sao obrigatorios.';
        end if;
        if (v_payment->>'amount')::numeric < 0 then
            raise exception 'SYNC_INVALID_PAYMENT: amount nao pode ser negativo.';
        end if;
        if nullif(v_payment->>'paidAt', '') is not null
           and (v_payment->>'paidAt') !~ '([zZ]|[+-][0-9]{2}:[0-9]{2})$' then
            raise exception 'SYNC_AMBIGUOUS_TIMEZONE: paidAt deve possuir offset explicito antes da persistencia.';
        end if;
        if nullif(v_payment->>'paidAt', '') is not null then
            begin
                perform (v_payment->>'paidAt')::timestamptz;
            exception when others then
                raise exception 'SYNC_INVALID_PAYMENT: paidAt invalido.';
            end;
        end if;
        if v_external_payment_id = any(v_payment_ids) then
            raise exception 'SYNC_DUPLICATE_PAYMENT: externalPaymentId repetido no pedido.';
        end if;
        v_payment_ids := array_append(v_payment_ids, v_external_payment_id);

        insert into public.market_sale_payments (
            market_account_id, sale_id, external_payment_id, amount, paid_at,
            method, description, brand, card_type, authorization_id, raw_data
        ) values (
            p_market_account_id,
            v_sale_id,
            v_external_payment_id,
            (v_payment->>'amount')::numeric,
            nullif(v_payment->>'paidAt', '')::timestamptz,
            nullif(v_payment->>'method', ''),
            nullif(v_payment->>'description', ''),
            nullif(v_payment->>'brand', ''),
            nullif(v_payment->>'cardType', ''),
            nullif(v_payment->>'authorizationId', ''),
            v_payment->'rawData'
        )
        on conflict (market_account_id, sale_id, external_payment_id)
            where external_payment_id is not null
        do update set
            amount = excluded.amount,
            paid_at = excluded.paid_at,
            method = excluded.method,
            description = excluded.description,
            brand = excluded.brand,
            card_type = excluded.card_type,
            authorization_id = excluded.authorization_id,
            raw_data = excluded.raw_data;
    end loop;

    if v_payments_snapshot_complete then
        delete from public.market_sale_payments p
        where p.market_account_id = p_market_account_id
          and p.sale_id = v_sale_id
          and (p.external_payment_id is null or not (p.external_payment_id = any(v_payment_ids)));
    end if;

    return jsonb_build_object(
        'saleId', v_sale_id,
        'inserted', v_existing_sale_id is null,
        'itemsProcessed', jsonb_array_length(p_items),
        'paymentsProcessed', jsonb_array_length(p_payments)
    );
end;
$$;

revoke all on function public.market_upsert_external_sale(uuid,uuid,uuid,jsonb,jsonb,jsonb)
    from public, anon, authenticated;
grant execute on function public.market_upsert_external_sale(uuid,uuid,uuid,jsonb,jsonb,jsonb)
    to service_role;

comment on function public.market_upsert_external_sale(uuid,uuid,uuid,jsonb,jsonb,jsonb) is
    'Persiste atomicamente um DTO interno normalizado de venda, itens e pagamentos. Nao cria movimentos de estoque.';

commit;
