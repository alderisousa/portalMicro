-- GiroMicro Market - reimportacao controlada de NF-e ja existente em staging.
-- Nao altera 202609040001 nem 202609040002: adiciona uma funcao nova e dedicada,
-- reaproveitando a mesma trava de concorrencia (account + invoice_key) usada pela
-- importacao normal.
begin;

create or replace function public.market_reimport_purchase_staging(
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
    v_blocked boolean;
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

    -- Mesma chave de trava da importacao normal (market_import_purchase_staging):
    -- serializa qualquer combinacao de import/reimport concorrente para a mesma nota.
    perform pg_advisory_xact_lock(hashtextextended(p_market_account_id::text || ':' || v_invoice_key, 0));

    -- Localiza e trava a linha da compra existente dentro da transacao (FOR UPDATE),
    -- para que a revalidacao de elegibilidade abaixo nao sofra race condition com uma
    -- conciliacao ou outra reimportacao concorrente.
    select p.id, p.status
    into v_existing
    from public.market_purchases p
    where p.market_account_id = p_market_account_id and p.invoice_key = v_invoice_key
    for update;

    if not found then
        raise exception 'PURCHASE_NOT_FOUND_FOR_REIMPORT';
    end if;

    -- Revalidacao defensiva: qualquer efeito operacional ja iniciado (status da compra
    -- alem de 'imported', ou qualquer item fora de reconciliation_status/stock_entry_status
    -- 'pending') bloqueia a substituicao. Em caso de duvida, NAO reimporta.
    v_blocked := v_existing.status <> 'imported' or exists (
        select 1 from public.market_purchase_items i
        where i.market_purchase_id = v_existing.id
          and i.market_account_id = p_market_account_id
          and (i.reconciliation_status <> 'pending' or i.stock_entry_status <> 'pending')
    );

    if v_blocked then
        raise exception 'PURCHASE_REIMPORT_BLOCKED';
    end if;

    v_purchase_id := v_existing.id;

    delete from public.market_purchase_items
    where market_purchase_id = v_purchase_id and market_account_id = p_market_account_id;

    update public.market_purchases set
        destination_store_id = p_destination_store_id,
        supplier_name = nullif(btrim(p_document#>>'{supplier,name}'), ''),
        supplier_document = nullif(regexp_replace(coalesce(p_document#>>'{supplier,document}', ''), '[^0-9]', '', 'g'), ''),
        invoice_number = nullif(btrim(p_document->>'invoiceNumber'), ''),
        invoice_series = nullif(btrim(p_document->>'series'), ''),
        issued_at = nullif(p_document->>'issuedAt', '')::timestamptz,
        total_amount = nullif(p_document#>>'{totals,totalAmount}', '')::numeric,
        products_amount = nullif(p_document#>>'{totals,productsAmount}', '')::numeric,
        freight_amount = nullif(p_document#>>'{totals,freightAmount}', '')::numeric,
        discount_amount = nullif(p_document#>>'{totals,discountAmount}', '')::numeric,
        other_amount = nullif(p_document#>>'{totals,otherAmount}', '')::numeric,
        status = 'imported',
        source_type = p_source_type,
        source_reference = 'nfe:' || v_invoice_key,
        raw_payload = jsonb_build_object('provider', p_document->>'provider')
    where id = v_purchase_id and market_account_id = p_market_account_id;

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

    -- Mesmo formato de retorno do sucesso da importacao normal (duplicate: false), para
    -- que o frontend reutilize o mesmo tipo/tratamento de resultado.
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

revoke all on function public.market_reimport_purchase_staging(uuid,uuid,text,jsonb) from public, anon;
grant execute on function public.market_reimport_purchase_staging(uuid,uuid,text,jsonb) to authenticated;

comment on function public.market_reimport_purchase_staging(uuid,uuid,text,jsonb) is
    'Substitui atomicamente os dados de uma compra em staging ja existente (mesma invoice_key), somente enquanto nenhum item tiver saido de pending em reconciliation_status/stock_entry_status e o status da compra continuar imported. Revalida elegibilidade com lock dentro da propria transacao.';

commit;
