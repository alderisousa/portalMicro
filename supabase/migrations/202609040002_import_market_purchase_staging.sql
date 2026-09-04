-- GiroMicro Market - importacao atomica e idempotente de NF-e normalizada.
begin;

create or replace function public.market_import_purchase_staging(
    p_market_account_id uuid,
    p_destination_store_id uuid,
    p_source_type text,
    p_document jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_purchase_id uuid;
    v_invoice_key text;
    v_item jsonb;
    v_item_count integer;
    v_existing record;
begin
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'PURCHASE_IMPORT_PERMISSION_DENIED';
    end if;

    if not exists (
        select 1 from public.market_accounts a
        where a.id = p_market_account_id and a.status in ('pilot','active')
    ) then
        raise exception 'PURCHASE_ACCOUNT_NOT_AVAILABLE';
    end if;

    if not exists (
        select 1 from public.market_stores s
        where s.id = p_destination_store_id
          and s.market_account_id = p_market_account_id
          and s.status = 'active'
          and s.store_type = 'warehouse'
          and public.market_can_access_store(s.id)
    ) then
        raise exception 'PURCHASE_DESTINATION_NOT_ALLOWED';
    end if;

    if p_source_type not in ('qrcode','nfe') then
        raise exception 'PURCHASE_SOURCE_TYPE_INVALID';
    end if;

    v_invoice_key := nullif(regexp_replace(coalesce(p_document->>'accessKey', ''), '[^0-9]', '', 'g'), '');
    if v_invoice_key is null or length(v_invoice_key) <> 44 then
        raise exception 'PURCHASE_ACCESS_KEY_INVALID';
    end if;

    if jsonb_typeof(p_document->'items') <> 'array' then
        raise exception 'PURCHASE_ITEMS_INVALID';
    end if;
    v_item_count := jsonb_array_length(p_document->'items');
    if v_item_count < 1 or v_item_count > 1000 then
        raise exception 'PURCHASE_ITEMS_INVALID';
    end if;

    -- Serializa concorrencia para a mesma chave antes de consultar/inserir.
    perform pg_advisory_xact_lock(hashtextextended(p_market_account_id::text || ':' || v_invoice_key, 0));

    select p.id, p.invoice_number, p.supplier_name, p.status
    into v_existing
    from public.market_purchases p
    where p.market_account_id = p_market_account_id and p.invoice_key = v_invoice_key;

    if found then
        return jsonb_build_object(
            'purchaseId', v_existing.id,
            'invoiceKey', v_invoice_key,
            'invoiceNumber', v_existing.invoice_number,
            'supplierName', v_existing.supplier_name,
            'itemCount', (select count(*) from public.market_purchase_items i where i.market_purchase_id = v_existing.id),
            'reconciliation', jsonb_build_object('matched', 0, 'pending',
                (select count(*) from public.market_purchase_items i where i.market_purchase_id = v_existing.id and i.reconciliation_status = 'pending')),
            'status', v_existing.status,
            'duplicate', true
        );
    end if;

    insert into public.market_purchases (
        market_account_id, destination_store_id, supplier_name, supplier_document,
        invoice_number, invoice_series, invoice_key, issued_at, total_amount,
        products_amount, freight_amount, discount_amount, other_amount, status,
        source_type, source_reference, raw_payload, created_by
    ) values (
        p_market_account_id, p_destination_store_id,
        nullif(btrim(p_document#>>'{supplier,name}'), ''),
        nullif(regexp_replace(coalesce(p_document#>>'{supplier,document}', ''), '[^0-9]', '', 'g'), ''),
        nullif(btrim(p_document->>'invoiceNumber'), ''), nullif(btrim(p_document->>'series'), ''),
        v_invoice_key, nullif(p_document->>'issuedAt', '')::timestamptz,
        nullif(p_document#>>'{totals,totalAmount}', '')::numeric,
        nullif(p_document#>>'{totals,productsAmount}', '')::numeric,
        nullif(p_document#>>'{totals,freightAmount}', '')::numeric,
        nullif(p_document#>>'{totals,discountAmount}', '')::numeric,
        nullif(p_document#>>'{totals,otherAmount}', '')::numeric,
        'imported', p_source_type, 'nfe:' || v_invoice_key,
        jsonb_build_object('provider', p_document->>'provider'), auth.uid()
    ) returning id into v_purchase_id;

    for v_item in select value from jsonb_array_elements(p_document->'items') loop
        if coalesce((v_item->>'lineNumber')::integer, 0) <= 0
           or coalesce((v_item->>'quantity')::numeric, 0) <= 0
           or nullif(btrim(v_item->>'description'), '') is null then
            raise exception 'PURCHASE_ITEM_INVALID';
        end if;

        insert into public.market_purchase_items (
            market_account_id, market_purchase_id, line_number, supplier_product_code,
            barcode_raw, barcode_normalized, description_raw, ncm, cfop, unit,
            quantity, unit_price, gross_amount, discount_amount, freight_amount,
            other_amount, net_amount, reconciliation_status, stock_entry_status
        ) values (
            p_market_account_id, v_purchase_id, (v_item->>'lineNumber')::integer,
            nullif(btrim(v_item->>'supplierProductCode'), ''), nullif(btrim(v_item->>'barcode'), ''),
            nullif(regexp_replace(coalesce(v_item->>'barcode', ''), '[^0-9]', '', 'g'), ''),
            btrim(v_item->>'description'), nullif(btrim(v_item->>'ncm'), ''),
            nullif(btrim(v_item->>'cfop'), ''), nullif(btrim(v_item->>'unit'), ''),
            (v_item->>'quantity')::numeric, nullif(v_item->>'unitPrice', '')::numeric,
            nullif(v_item->>'grossAmount', '')::numeric,
            coalesce(nullif(v_item->>'discountAmount', '')::numeric, 0),
            coalesce(nullif(v_item->>'freightAmount', '')::numeric, 0),
            coalesce(nullif(v_item->>'otherAmount', '')::numeric, 0),
            nullif(v_item->>'netAmount', '')::numeric, 'pending', 'pending'
        );
    end loop;

    return jsonb_build_object(
        'purchaseId', v_purchase_id,
        'invoiceKey', v_invoice_key,
        'invoiceNumber', nullif(btrim(p_document->>'invoiceNumber'), ''),
        'supplierName', nullif(btrim(p_document#>>'{supplier,name}'), ''),
        'itemCount', v_item_count,
        'reconciliation', jsonb_build_object('matched', 0, 'pending', v_item_count),
        'status', 'imported',
        'duplicate', false
    );
exception
    when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
        raise exception 'PURCHASE_DOCUMENT_INVALID';
end;
$$;

revoke all on function public.market_import_purchase_staging(uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.market_import_purchase_staging(uuid,uuid,text,jsonb) to authenticated;

comment on function public.market_import_purchase_staging(uuid,uuid,text,jsonb) is
    'Persiste uma NF-e normalizada e seus itens atomicamente, sem movimentar estoque.';

commit;
