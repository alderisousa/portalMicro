-- Aplicação MANUAL. Conferência não é recebimento. Nenhum ledger é alterado.
begin;

-- Preserva as quatro casas da quantidade fiscal e cinco do preço do PDF.
alter table public.market_purchase_items drop column calculated_unit_cost;
alter table public.market_purchase_items alter column quantity type numeric(18,4), alter column unit_price type numeric(18,5);
alter table public.market_purchase_items add column calculated_unit_cost numeric(18,6)
  generated always as (case when net_amount is null then null else net_amount / quantity end) stored;

alter table public.market_purchase_items
  add column original_data jsonb,
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users(id);
alter table public.market_purchases
  add column reviewed_at timestamptz,
  add column reviewed_by uuid references auth.users(id);

create function public.market_purchase_review_values(p_row jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'supplier_product_code', p_row->'supplier_product_code', 'barcode_raw', p_row->'barcode_raw',
    'description_raw', p_row->'description_raw', 'quantity', p_row->'quantity', 'unit', p_row->'unit',
    'unit_price', p_row->'unit_price', 'gross_amount', p_row->'gross_amount', 'net_amount', p_row->'net_amount',
    'discount_amount', p_row->'discount_amount', 'freight_amount', p_row->'freight_amount', 'other_amount', p_row->'other_amount'
  );
$$;

-- Para itens anteriores, esta é a primeira versão disponível, não uma
-- reconstrução de documentos históricos que nunca foram armazenados.
update public.market_purchase_items i set original_data = public.market_purchase_review_values(to_jsonb(i));
alter table public.market_purchase_items alter column original_data set not null;
alter table public.market_purchase_items add constraint purchase_item_original_object check (jsonb_typeof(original_data) = 'object');
alter table public.market_purchase_items add constraint purchase_item_review_actor check ((reviewed_at is null) = (reviewed_by is null));
alter table public.market_purchases add constraint purchase_review_actor check ((reviewed_at is null) = (reviewed_by is null));

-- Escritas passam exclusivamente pelas RPCs autorizadas. SELECT/RLS existentes
-- são preservados; evita forjar aprovação ou substituir o original por REST.
revoke insert, update, delete on public.market_purchases, public.market_purchase_items,
  public.market_purchase_product_mappings from authenticated;

create function public.market_guard_purchase_item_review()
returns trigger language plpgsql set search_path = public as $$
declare v_changed boolean;
begin
  if tg_op = 'INSERT' then
    new.original_data := coalesce(new.original_data, public.market_purchase_review_values(to_jsonb(new)));
    new.reviewed_at := null; new.reviewed_by := null;
    return new;
  end if;
  if new.original_data is distinct from old.original_data then raise exception 'PURCHASE_ORIGINAL_IMMUTABLE'; end if;
  v_changed := public.market_purchase_review_values(to_jsonb(new)) is distinct from public.market_purchase_review_values(to_jsonb(old))
    or new.market_product_id is distinct from old.market_product_id
    or new.reconciliation_status is distinct from old.reconciliation_status;
  if v_changed then
    if old.stock_entry_status <> 'pending' then raise exception 'RECONCILE_STOCK_ALREADY_ADVANCED'; end if;
    if not exists (select 1 from public.market_purchases p join public.market_accounts a on a.id = p.market_account_id
      where p.id = old.market_purchase_id and p.market_account_id = old.market_account_id
      and p.status in ('imported','reconciling','pending','ready') and a.status in ('pilot','active')) then
      raise exception 'PURCHASE_REVIEW_LOCKED';
    end if;
    new.reviewed_at := null; new.reviewed_by := null;
  end if;
  if v_changed or (old.reviewed_at is not null and new.reviewed_at is null) then
    update public.market_purchases set reviewed_at = null, reviewed_by = null,
      status = case when status = 'ready' then 'reconciling' else status end
    where id = old.market_purchase_id and market_account_id = old.market_account_id;
  end if;
  return new;
end;
$$;
create trigger market_purchase_item_review_guard before insert or update on public.market_purchase_items
for each row execute function public.market_guard_purchase_item_review();

create function public.market_assert_purchase_review_access(p_account uuid, p_purchase uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_purchase public.market_purchases;
begin
  if not public.market_has_role(p_account, array['owner','admin','manager']) then raise exception 'RECONCILE_PERMISSION_DENIED'; end if;
  select * into v_purchase from public.market_purchases where id = p_purchase and market_account_id = p_account for update;
  if not found or not public.market_can_access_store(v_purchase.destination_store_id) then raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE'; end if;
  if v_purchase.status not in ('imported','reconciling','pending','ready') or not exists (
    select 1 from public.market_accounts where id = p_account and status in ('pilot','active')
  ) then raise exception 'PURCHASE_REVIEW_LOCKED'; end if;
end;
$$;

create function public.market_validate_purchase_review_precision(p_values jsonb)
returns void language plpgsql set search_path=public as $$
declare v_key text; v_value numeric; v_scale integer;
begin
  foreach v_key in array array['quantity','unit_price','gross_amount','net_amount','discount_amount','freight_amount','other_amount'] loop
    v_value:=(p_values->>v_key)::numeric;
    v_scale:=case v_key when 'quantity' then 4 when 'unit_price' then 5 else 2 end;
    if v_value::text in ('NaN','Infinity','-Infinity') or v_value<0 then raise exception 'PURCHASE_ITEM_INVALID'; end if;
    if v_value<>round(v_value,v_scale) then raise exception 'PURCHASE_ITEM_PRECISION'; end if;
  end loop;
end;
$$;

create function public.market_save_purchase_item_review(
  p_market_account_id uuid, p_purchase_item_id uuid, p_values jsonb,
  p_expected_updated_at timestamptz, p_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.market_purchase_items; v_purchase uuid; v_values public.market_purchase_items; v_barcode text;
begin
  select market_purchase_id into v_purchase from public.market_purchase_items
    where id = p_purchase_item_id and market_account_id = p_market_account_id;
  perform public.market_assert_purchase_review_access(p_market_account_id, v_purchase);
  select * into v_item from public.market_purchase_items
    where id = p_purchase_item_id and market_account_id = p_market_account_id for update;
  if not found then raise exception 'RECONCILE_ITEM_NOT_FOUND'; end if;
  if v_item.stock_entry_status <> 'pending' then raise exception 'RECONCILE_STOCK_ALREADY_ADVANCED'; end if;
  if p_expected_updated_at is null or v_item.updated_at <> p_expected_updated_at then raise exception 'PURCHASE_REVIEW_CONFLICT'; end if;
  if jsonb_typeof(p_values) is distinct from 'object' then raise exception 'PURCHASE_ITEM_INVALID'; end if;
  perform public.market_validate_purchase_review_precision(p_values);
  select * into v_values from jsonb_populate_record(null::public.market_purchase_items, p_values);
  if v_values.quantity is null or v_values.quantity <= 0 or v_values.quantity::text in ('NaN','Infinity','-Infinity')
    or nullif(btrim(v_values.description_raw),'') is null or nullif(btrim(v_values.unit),'') is null
    or v_values.unit_price is null or v_values.gross_amount is null
    or v_values.unit_price < 0 or v_values.gross_amount < 0
    or v_values.unit_price::text in ('NaN','Infinity','-Infinity') or v_values.gross_amount::text in ('NaN','Infinity','-Infinity')
    or v_values.net_amount::text in ('NaN','Infinity','-Infinity')
    or coalesce(v_values.discount_amount,0)::text in ('NaN','Infinity','-Infinity')
    or coalesce(v_values.freight_amount,0)::text in ('NaN','Infinity','-Infinity')
    or coalesce(v_values.other_amount,0)::text in ('NaN','Infinity','-Infinity') then raise exception 'PURCHASE_ITEM_INVALID'; end if;
  v_barcode := regexp_replace(coalesce(v_values.barcode_raw,''), '[^0-9]', '', 'g');
  if coalesce(v_values.barcode_raw,'') !~ '^[0-9 .-]+$' or not public.market_is_valid_gtin(v_barcode) then v_barcode := null; end if;
  update public.market_purchase_items set
    supplier_product_code = nullif(btrim(v_values.supplier_product_code),''), barcode_raw = nullif(btrim(v_values.barcode_raw),''),
    barcode_normalized = v_barcode, description_raw = btrim(v_values.description_raw), unit = upper(btrim(v_values.unit)),
    quantity = v_values.quantity, unit_price = v_values.unit_price, gross_amount = v_values.gross_amount,
    net_amount = v_values.net_amount, discount_amount = coalesce(v_values.discount_amount,0),
    freight_amount = coalesce(v_values.freight_amount,0), other_amount = coalesce(v_values.other_amount,0),
    reviewed_at = null, reviewed_by = null,
    market_product_id = case when v_item.supplier_product_code is distinct from nullif(btrim(v_values.supplier_product_code),'')
      or v_item.barcode_raw is distinct from nullif(btrim(v_values.barcode_raw),'') then null else v_item.market_product_id end,
    reconciliation_status = case when v_item.supplier_product_code is distinct from nullif(btrim(v_values.supplier_product_code),'')
      or v_item.barcode_raw is distinct from nullif(btrim(v_values.barcode_raw),'') then 'pending' else v_item.reconciliation_status end,
    reconciliation_method = case when v_item.supplier_product_code is distinct from nullif(btrim(v_values.supplier_product_code),'')
      or v_item.barcode_raw is distinct from nullif(btrim(v_values.barcode_raw),'') then null else v_item.reconciliation_method end,
    reconciliation_confidence = case when v_item.supplier_product_code is distinct from nullif(btrim(v_values.supplier_product_code),'')
      or v_item.barcode_raw is distinct from nullif(btrim(v_values.barcode_raw),'') then null else v_item.reconciliation_confidence end
  where id = v_item.id and market_account_id = p_market_account_id;
  if p_confirm then
    select * into v_item from public.market_purchase_items where id = v_item.id;
    if v_item.market_product_id is null or v_item.reconciliation_status not in ('matched_auto','matched_manual','mapped')
      or not exists (select 1 from public.market_products pr where pr.id = v_item.market_product_id
        and pr.market_account_id = p_market_account_id and pr.status = 'active'
        and public.market_is_accesys_current_product(p_market_account_id,pr.id)) then raise exception 'PURCHASE_REVIEW_MATCH_REQUIRED'; end if;
    if abs(round(v_item.quantity * v_item.unit_price,2) - v_item.gross_amount) > 0.02
      or (v_item.net_amount is not null and abs(v_item.gross_amount-v_item.discount_amount+v_item.freight_amount+v_item.other_amount-v_item.net_amount)>0.02)
      then raise exception 'PURCHASE_REVIEW_MATH'; end if;
    update public.market_purchase_items set reviewed_at = now(), reviewed_by = auth.uid() where id = v_item.id;
  end if;
  update public.market_purchases set status=case when status='imported' then 'reconciling' else status end
    where id=v_purchase and market_account_id=p_market_account_id;
  return jsonb_build_object('purchaseItemId',v_item.id,'reviewed',p_confirm);
end;
$$;

create function public.market_complete_purchase_review(p_market_account_id uuid, p_purchase_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.market_assert_purchase_review_access(p_market_account_id,p_purchase_id);
  perform 1 from public.market_purchase_items where market_purchase_id=p_purchase_id and market_account_id=p_market_account_id for update;
  if not exists (select 1 from public.market_purchase_items where market_purchase_id=p_purchase_id and market_account_id=p_market_account_id)
    or exists (select 1 from public.market_purchase_items i where i.market_purchase_id=p_purchase_id and i.market_account_id=p_market_account_id
      and (i.reviewed_at is null or i.reviewed_by is null or i.stock_entry_status <> 'pending'
        or i.reconciliation_status not in ('matched_auto','matched_manual','mapped') or i.market_product_id is null
        or not exists (select 1 from public.market_products pr where pr.id=i.market_product_id and pr.market_account_id=p_market_account_id
          and pr.status='active' and public.market_is_accesys_current_product(p_market_account_id,pr.id)))) then raise exception 'PURCHASE_REVIEW_INCOMPLETE'; end if;
  if exists (select 1 from public.market_purchases p where p.id=p_purchase_id and p.products_amount is not null
    and abs(p.products_amount-(select sum(i.gross_amount) from public.market_purchase_items i where i.market_purchase_id=p.id))>0.05)
    then raise exception 'PURCHASE_REVIEW_TOTALS'; end if;
  update public.market_purchases set reviewed_at=now(),reviewed_by=auth.uid(),status='ready'
    where id=p_purchase_id and market_account_id=p_market_account_id;
  return jsonb_build_object('purchaseId',p_purchase_id,'reviewed',true);
end;
$$;

-- Serializa concilia??o e confer?ncia sempre na ordem compra -> item.
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
    end if;

    return jsonb_build_object(
        'purchaseItemId', p_purchase_item_id,
        'marketProductId', p_market_product_id,
        'reconciliationStatus', 'matched_manual'
    );
end;
$$;

create or replace function public.market_undo_purchase_item_reconciliation(
    p_market_account_id uuid,
    p_purchase_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_item record;
    v_purchase record;
begin
    perform public.market_assert_purchase_review_access(p_market_account_id, (select market_purchase_id from public.market_purchase_items where id=p_purchase_item_id and market_account_id=p_market_account_id));
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select i.id, i.market_purchase_id, i.stock_entry_status
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

    select p.id, p.destination_store_id
    into v_purchase
    from public.market_purchases p
    where p.id = v_item.market_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    update public.market_purchase_items set
        market_product_id = null,
        reconciliation_status = 'pending',
        reconciliation_confidence = null,
        reconciliation_method = null,
        reconciliation_notes = null
    where id = p_purchase_item_id and market_account_id = p_market_account_id;

    return jsonb_build_object('purchaseItemId', p_purchase_item_id, 'reconciliationStatus', 'pending');
end;
$$;

-- Mesmo match existente; lock da compra, escopo pendente e agrega??o UUID compat?vel.
create or replace function public.market_reprocess_purchase_pending_items(
    p_market_account_id uuid,
    p_purchase_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_purchase record;
    v_item record;
    v_mapped_product uuid;
    v_mapping_count integer;
    v_ean_product uuid;
    v_ean_count integer;
    v_matched_count integer := 0;
    v_processed_count integer := 0;
begin
    perform public.market_assert_purchase_review_access(p_market_account_id,p_purchase_id);
    if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
        raise exception 'RECONCILE_PERMISSION_DENIED';
    end if;

    select p.id, p.destination_store_id, p.supplier_document
    into v_purchase
    from public.market_purchases p
    where p.id = p_purchase_id and p.market_account_id = p_market_account_id;

    if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
        raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
    end if;

    for v_item in
        select i.id, i.supplier_product_code, i.barcode_normalized, i.description_raw
        from public.market_purchase_items i
        where i.market_purchase_id = p_purchase_id
          and i.market_account_id = p_market_account_id
          and i.stock_entry_status = 'pending'
          and i.reconciliation_status in ('pending', 'not_found', 'needs_review')
        for update
    loop
        v_processed_count := v_processed_count + 1;
        v_mapped_product := null;
        v_mapping_count := 0;
        v_ean_product := null;

        if nullif(btrim(v_item.supplier_product_code), '') is not null then
            -- Campos preenchidos no mapping qualificam a identidade. Campos
            -- vazios preservam o de/para manual por fornecedor + código.
            select count(*), min(m.market_product_id::text)::uuid
            into v_mapping_count, v_mapped_product
            from public.market_purchase_product_mappings m
            where m.market_account_id = p_market_account_id
              and coalesce(m.supplier_document, '') = coalesce(nullif(btrim(v_purchase.supplier_document), ''), '')
              and m.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
              and (nullif(btrim(m.barcode_normalized), '') is null
                or m.barcode_normalized = v_item.barcode_normalized)
              and (nullif(btrim(m.description_normalized), '') is null
                or upper(regexp_replace(btrim(m.description_normalized), '[[:space:]]+', ' ', 'g'))
                  = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')));
        end if;

        -- Não desempata por ordem física, UUID, nem por EAN: identidades
        -- compatíveis concorrentes exigem uma decisão explícita do operador.
        if v_mapping_count > 1 then
            update public.market_purchase_items set
                market_product_id = null, reconciliation_status = 'needs_review',
                reconciliation_confidence = null, reconciliation_method = null,
                reconciliation_notes = 'Mais de um de/para compatível; selecione o produto manualmente.'
            where id = v_item.id and market_account_id = p_market_account_id;
            continue;
        end if;

        if v_mapped_product is not null and exists (
            select 1 from public.market_products pr
            where pr.id = v_mapped_product
              and pr.market_account_id = p_market_account_id
              and pr.status = 'active'
              and public.market_is_accesys_current_product(p_market_account_id, pr.id)
        ) then
            update public.market_purchase_items set
                market_product_id = v_mapped_product,
                reconciliation_status = 'mapped',
                reconciliation_confidence = 1.0,
                reconciliation_method = 'purchase_mapping',
                reconciliation_notes = null
            where id = v_item.id;
            v_matched_count := v_matched_count + 1;
            continue;
        end if;

        if v_item.barcode_normalized is not null and public.market_is_valid_gtin(v_item.barcode_normalized) then
            select count(*), min(pr.id::text)::uuid
            into v_ean_count, v_ean_product
            from public.market_products pr
            where pr.market_account_id = p_market_account_id
              and pr.ean = v_item.barcode_normalized
              and pr.status = 'active'
              and public.market_is_accesys_current_product(p_market_account_id, pr.id);

            if v_ean_count = 1 then
                update public.market_purchase_items set
                    market_product_id = v_ean_product,
                    reconciliation_status = 'matched_auto',
                    reconciliation_confidence = 1.0,
                    reconciliation_method = 'ean_exact',
                    reconciliation_notes = null
                where id = v_item.id;
                v_matched_count := v_matched_count + 1;
            end if;
        end if;
    end loop;

    return jsonb_build_object(
        'purchaseId', p_purchase_id,
        'itemsProcessed', v_processed_count,
        'itemsMatched', v_matched_count,
        'itemsStillPending', v_processed_count - v_matched_count
    );
end;
$$;

create unique index ux_market_purchase_pdf_source on public.market_purchases(market_account_id,source_reference) where source_type='pdf';
create function public.market_import_pdf_purchase_staging(
  p_market_account_id uuid, p_destination_store_id uuid, p_source_reference text, p_document jsonb, p_original jsonb
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_existing_store uuid; v_item jsonb; v_index integer:=0; v_key text; v_header jsonb:=p_document->'header'; v_barcode text;
begin
  if not public.market_has_role(p_market_account_id,array['owner','admin','manager']) then raise exception 'RECONCILE_PERMISSION_DENIED'; end if;
  if not exists(select 1 from public.market_accounts where id=p_market_account_id and status in ('pilot','active')) then raise exception 'PURCHASE_ACCOUNT_NOT_AVAILABLE'; end if;
  if not exists(select 1 from public.market_stores s where s.id=p_destination_store_id and s.market_account_id=p_market_account_id
    and s.status='active' and s.store_type='warehouse' and public.market_can_access_store(s.id)) then raise exception 'PURCHASE_DESTINATION_NOT_ALLOWED'; end if;
  if nullif(btrim(p_source_reference),'') is null or length(p_source_reference)>200
    or jsonb_typeof(p_document->'items') is distinct from 'array' or jsonb_typeof(p_original->'items') is distinct from 'array'
    or jsonb_typeof(v_header) is distinct from 'object' then raise exception 'PURCHASE_DOCUMENT_INVALID'; end if;
  if jsonb_array_length(p_document->'items') not between 1 and 1000
    or jsonb_array_length(p_document->'items')<>jsonb_array_length(p_original->'items') then raise exception 'PURCHASE_ITEMS_INVALID'; end if;
  v_key:=nullif(regexp_replace(coalesce(v_header->>'accessKey',''),'[^0-9]','','g'),'');
  if v_key is not null and length(v_key)<>44 then raise exception 'PURCHASE_ACCESS_KEY_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_market_account_id::text||':'||coalesce(v_key,p_source_reference),0));
  select id,destination_store_id into v_id,v_existing_store from public.market_purchases where market_account_id=p_market_account_id
    and ((v_key is not null and invoice_key=v_key) or (source_type='pdf' and source_reference=p_source_reference));
  if found then
    if not public.market_can_access_store(v_existing_store) then raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE'; end if;
    return v_id;
  end if;
  insert into public.market_purchases(market_account_id,destination_store_id,supplier_name,supplier_document,invoice_number,invoice_series,
    invoice_key,issued_at,total_amount,products_amount,discount_amount,freight_amount,other_amount,source_type,source_reference,raw_payload,created_by,status)
  values(p_market_account_id,p_destination_store_id,v_header->>'supplierName',nullif(regexp_replace(coalesce(v_header->>'supplierCnpj',''),'[^0-9]','','g'),''),
    v_header->>'documentNumber',v_header->>'series',v_key,
    case when nullif(v_header->>'issueDate','') is null then null else to_date(v_header->>'issueDate','DD/MM/YYYY')::timestamp at time zone 'America/Sao_Paulo' end,
    (v_header->>'invoiceTotal')::numeric,(v_header->>'productsTotal')::numeric,(v_header->>'discount')::numeric,
    (v_header->>'freight')::numeric,(v_header->>'otherExpenses')::numeric,'pdf',p_source_reference,
    jsonb_build_object('original',p_original),auth.uid(),'imported') returning id into v_id;
  for v_item in select value from jsonb_array_elements(p_document->'items') loop
    perform public.market_validate_purchase_review_precision(v_item);
    if coalesce((v_item->>'quantity')::numeric,0)<=0 or nullif(btrim(v_item->>'description_raw'),'') is null then raise exception 'PURCHASE_ITEM_INVALID'; end if;
    v_barcode:=regexp_replace(coalesce(v_item->>'barcode_raw',''),'[^0-9]','','g');
    if coalesce(v_item->>'barcode_raw','') !~ '^[0-9 .-]+$' or not public.market_is_valid_gtin(v_barcode) then v_barcode:=null; end if;
    insert into public.market_purchase_items(market_account_id,market_purchase_id,line_number,supplier_product_code,barcode_raw,barcode_normalized,
      description_raw,quantity,unit,unit_price,gross_amount,net_amount,discount_amount,freight_amount,other_amount,original_data)
    values(p_market_account_id,v_id,v_index+1,v_item->>'supplier_product_code',v_item->>'barcode_raw',v_barcode,
      v_item->>'description_raw',(v_item->>'quantity')::numeric,v_item->>'unit',(v_item->>'unit_price')::numeric,
      (v_item->>'gross_amount')::numeric,(v_item->>'net_amount')::numeric,coalesce((v_item->>'discount_amount')::numeric,0),
      coalesce((v_item->>'freight_amount')::numeric,0),coalesce((v_item->>'other_amount')::numeric,0),p_original->'items'->v_index);
    v_index:=v_index+1;
  end loop;
  perform public.market_reprocess_purchase_pending_items(p_market_account_id,v_id);
  return v_id;
end;
$$;

revoke all on function public.market_validate_purchase_review_precision(jsonb), public.market_purchase_review_values(jsonb), public.market_guard_purchase_item_review(),
 public.market_assert_purchase_review_access(uuid,uuid), public.market_save_purchase_item_review(uuid,uuid,jsonb,timestamptz,boolean),
 public.market_complete_purchase_review(uuid,uuid), public.market_import_pdf_purchase_staging(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.market_save_purchase_item_review(uuid,uuid,jsonb,timestamptz,boolean),
 public.market_complete_purchase_review(uuid,uuid), public.market_import_pdf_purchase_staging(uuid,uuid,text,jsonb,jsonb) to authenticated;
commit;
