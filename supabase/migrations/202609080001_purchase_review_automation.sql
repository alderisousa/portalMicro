-- Aplicação MANUAL. Reduz cliques repetitivos do operador na Sprint de
-- Compras, sem mudar nenhuma regra de conciliação/conversão/recebimento já
-- validada. Dois ajustes independentes, ambos reaproveitando 100% da lógica
-- já existente (nenhuma regra de matching nova, nenhum campo de identidade
-- novo):
--
-- 1) calculated_unit_cost/stock_unit_cost passam a cair para gross_amount
--    quando net_amount não veio no documento (caso real NORAC: Texto IA não
--    promove gross_amount a net_amount sozinho). net_amount em si NUNCA é
--    escrito/sobrescrito por este fallback — continua null quando o
--    documento não trouxe o dado, preservando a distinção entre "valor
--    líquido informado" e "custo estimado do total da linha". original_data
--    (snapshot imutável) não é afetado; a mudança é só nas colunas geradas.
--
-- 2) market_confirm_purchase_item_reconciliation (conciliação manual) e os
--    dois pontos de import por QR/chave de acesso passam a chamar
--    market_reprocess_purchase_pending_items (já existente, já usada pelo
--    import de PDF/Texto IA desde 202609070004) no mesmo lugar/mesma
--    transação, para que um mapping recém-persistido resolva imediatamente
--    outras ocorrências elegíveis — sem duplicar a lógica de matching, sem
--    marcar conferência humana sozinho, sem gerar movimento de estoque.
--
-- Depende de 202609070001..202609070006 (já aplicadas). Não as altera.
begin;

-- 1) Fallback de custo -------------------------------------------------

alter table public.market_purchase_items drop column calculated_unit_cost;
alter table public.market_purchase_items add column calculated_unit_cost numeric(18,6)
  generated always as (
    case when coalesce(net_amount, gross_amount) is null then null
      else coalesce(net_amount, gross_amount) / quantity end
  ) stored;
comment on column public.market_purchase_items.calculated_unit_cost is
  'Custo efetivo unitário do documento (sem conversão). Usa net_amount quando informado; cai para gross_amount (total da linha) quando o documento não trouxe valor líquido. Nunca inventa valor quando gross_amount também falta.';

alter table public.market_purchase_items drop column stock_unit_cost;
alter table public.market_purchase_items add column stock_unit_cost numeric(18,6)
  generated always as (
    case when conversion_factor is null or coalesce(net_amount, gross_amount) is null then null
      else round(coalesce(net_amount, gross_amount) / (quantity * conversion_factor), 6) end
  ) stored;
comment on column public.market_purchase_items.stock_unit_cost is
  'Custo unitário de estoque (com conversão de embalagem). Usa net_amount quando informado; cai para gross_amount (total da linha) quando o documento não trouxe valor líquido. É o custo efetivamente gravado em market_stock_movements no recebimento.';

-- 2) Cascata de conciliação/mapping ------------------------------------

-- Corpo idêntico ao de 202609070002, só acrescentando a chamada a
-- market_reprocess_purchase_pending_items logo após persistir o mapping (e
-- só quando ele de fato foi persistido: mesma condição que já guarda o
-- insert do mapping, então uma conciliação sem "usar esta correspondência"
-- marcado não dispara reprocessamento nenhum). Escopo continua restrito à
-- própria compra (p_purchase_id do item) — nunca reprocessamento global.
-- Retorno ganha itemsAutoResolved para a UI informar quantos outros itens
-- foram reconhecidos automaticamente nesta mesma ação.
create or replace function public.market_confirm_purchase_item_reconciliation(
    p_market_account_id uuid,
    p_purchase_item_id uuid,
    p_market_product_id uuid,
    p_save_supplier_mapping boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item record;
    v_purchase record;
    v_product record;
    v_reprocess jsonb;
    v_items_auto_resolved integer := 0;
begin
    perform public.market_assert_purchase_review_access(p_market_account_id, (select market_purchase_id from public.market_purchase_items where id=p_purchase_item_id and market_account_id=p_market_account_id));
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select i.id, i.market_purchase_id, i.stock_entry_status, i.supplier_product_code
    into v_item
    from public.market_purchase_items i
    where i.id = p_purchase_item_id and i.market_account_id = p_market_account_id
    for update;

    if not found then
        raise exception 'RECONCILE_ITEM_NOT_FOUND';
    end if;

    if v_item.stock_entry_status <> 'pending' then
        raise exception 'RECONCILE_STOCK_ALREADY_ADVANCED';
    end if;

    select p.id, p.destination_store_id, p.supplier_document
    into v_purchase
    from public.market_purchases p
    where p.id = v_item.market_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    select pr.id, pr.status
    into v_product
    from public.market_products pr
    where pr.id = p_market_product_id and pr.market_account_id = p_market_account_id;

    if not found then
        raise exception 'RECONCILE_PRODUCT_NOT_FOUND';
    end if;
    if v_product.status <> 'active' then
        raise exception 'RECONCILE_PRODUCT_INACTIVE';
    end if;
    if not public.market_is_accesys_current_product(p_market_account_id, p_market_product_id) then
        raise exception 'RECONCILE_PRODUCT_NOT_CURRENT';
    end if;

    update public.market_purchase_items set
        market_product_id = p_market_product_id,
        reconciliation_status = 'matched_manual',
        reconciliation_confidence = null,
        reconciliation_method = 'manual',
        reconciliation_notes = null
    where id = p_purchase_item_id and market_account_id = p_market_account_id;

    perform public.market_resolve_purchase_item_unit(p_market_account_id, p_purchase_item_id);

    if p_save_supplier_mapping and nullif(btrim(v_item.supplier_product_code), '') is not null then
        insert into public.market_purchase_product_mappings (
            market_account_id, supplier_document, supplier_product_code,
            barcode_normalized, description_normalized, market_product_id, created_by
        ) values (
            p_market_account_id,
            nullif(btrim(v_purchase.supplier_document), ''),
            nullif(btrim(v_item.supplier_product_code), ''),
            null, null, p_market_product_id, auth.uid()
        )
        on conflict (
            market_account_id,
            coalesce(supplier_document, ''),
            coalesce(supplier_product_code, ''),
            coalesce(barcode_normalized, ''),
            coalesce(description_normalized, '')
        )
        -- updated_at e mantido pelo trigger market_purchase_product_mappings_touch_updated_at
        do update set market_product_id = excluded.market_product_id;

        -- NOVO: mapping acabou de ser persistido — outras linhas pendentes
        -- desta MESMA compra que já satisfaçam a identidade do de/para
        -- (fornecedor+código, e EAN/descrição só quando o registro salvo os
        -- exige) resolvem produto imediatamente, sem exigir que o operador
        -- repita a seleção manual. Isto NÃO marca conferência humana nem
        -- gera movimento de estoque — mesma garantia já existente da RPC de
        -- reprocessamento em qualquer outro ponto de chamada.
        select public.market_reprocess_purchase_pending_items(p_market_account_id, v_item.market_purchase_id) into v_reprocess;
        v_items_auto_resolved := coalesce((v_reprocess->>'itemsMatched')::integer, 0);
    end if;

    return jsonb_build_object(
        'purchaseItemId', p_purchase_item_id,
        'marketProductId', p_market_product_id,
        'reconciliationStatus', 'matched_manual',
        'itemsAutoResolved', v_items_auto_resolved
    );
end;
$$;

comment on function public.market_confirm_purchase_item_reconciliation(uuid,uuid,uuid,boolean) is
  'Vincula manualmente um item ao produto do catálogo; opcionalmente grava de/para reaproveitável por fornecedor+código. Quando grava o de/para, reprocessa imediatamente os demais itens pendentes da MESMA compra (itemsAutoResolved no retorno) — nunca confere nem recebe sozinho.';

-- Mesmo corpo de 202609040002, só acrescentando a chamada de reprocessamento
-- (já usada pelo import de PDF/Texto IA desde 202609070004) ao final do
-- caminho de insert novo — nunca no caminho "duplicate" (nada novo foi
-- inserido, nada para reprocessar). Dá paridade ao import por QR/chave de
-- acesso: mapping salvo em uma compra anterior já resolve produto nas linhas
-- da nota recém-importada, sem exigir clique em "Reprocessar pendentes".
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

    perform public.market_reprocess_purchase_pending_items(p_market_account_id, v_purchase_id);

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

comment on function public.market_import_purchase_staging(uuid,uuid,text,jsonb) is
    'Persiste uma NF-e normalizada e seus itens atomicamente, sem movimentar estoque. Reprocessa mapping/EAN salvos ao final (mesma rotina do import de PDF/Texto IA); pula o reprocessamento no caminho idempotente (duplicate=true), pois nada novo foi inserido.';

-- Mesmo corpo de 202609040003, só acrescentando a mesma chamada de
-- reprocessamento ao final, para que uma reimportação também se beneficie de
-- mapping salvo desde a importação anterior.
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

    perform public.market_reprocess_purchase_pending_items(p_market_account_id, v_purchase_id);

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

comment on function public.market_reimport_purchase_staging(uuid,uuid,text,jsonb) is
    'Substitui atomicamente os dados de uma compra em staging ja existente (mesma invoice_key), somente enquanto nenhum item tiver saido de pending em reconciliation_status/stock_entry_status e o status da compra continuar imported. Revalida elegibilidade com lock dentro da propria transacao. Reprocessa mapping/EAN salvos ao final, como o import normal.';

commit;
