-- Aplicação MANUAL. Conversão de embalagem para estoque; não é recebimento,
-- não gera ledger. Depende de 202609070001_purchase_human_review.sql (já aplicada).
begin;

-- A quantidade/unidade do documento (quantity/unit) permanece intocada: é o que
-- o fornecedor faturou. conversion_factor e stock_unit são um dado ADICIONAL
-- sobre quantas unidades de estoque cada unidade documental representa.
-- Nunca sobrescrevem quantity/unit nem entram em original_data.
alter table public.market_purchase_items
  add column conversion_factor numeric(18,6) null
    check (conversion_factor is null or (conversion_factor > 0 and conversion_factor::text not in ('NaN','Infinity','-Infinity'))),
  add column stock_unit text null,
  add column stock_quantity numeric(18,4)
    generated always as (case when conversion_factor is null then null else round(quantity * conversion_factor, 4) end) stored,
  add column stock_unit_cost numeric(18,6)
    generated always as (
      case when conversion_factor is null or net_amount is null then null
        else round(net_amount / (quantity * conversion_factor), 6) end
    ) stored;

comment on column public.market_purchase_items.conversion_factor is
  'Quantas unidades de estoque equivalem a 1 unidade documental (ex.: 1 CX = 6 UN). Não altera quantity/unit originais.';
comment on column public.market_purchase_items.stock_unit is
  'Unidade de estoque do produto conciliado no momento da resolução; snapshot, não referência viva.';

-- Backfill conservador: só resolve automaticamente quando já há produto
-- conciliado e a unidade do documento já é igual à unidade de estoque do
-- produto (fator 1, sem ambiguidade). Os demais itens ficam pendentes de
-- conversão, exatamente como um item recém-chegado sem CX->UN resolvido.
update public.market_purchase_items i
set conversion_factor = 1, stock_unit = i.unit
from public.market_products pr
where pr.id = i.market_product_id
  and pr.market_account_id = i.market_account_id
  and upper(btrim(pr.unit)) = upper(btrim(i.unit));

-- De/para de embalagem por fornecedor. Responsabilidade distinta de
-- market_purchase_product_mappings: aquela resolve "qual produto é este
-- código"; esta resolve "quantas unidades de estoque equivalem a 1 unidade
-- documental deste código, nesta unidade documental". Um mesmo código pode
-- legitimamente ter fatores diferentes conforme a unidade em que veio.
create table public.market_purchase_unit_conversions (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null references public.market_accounts(id) on delete cascade,
    supplier_document text null,
    supplier_product_code text null,
    barcode_normalized text null,
    description_normalized text null,
    source_unit text not null,
    stock_unit text not null,
    conversion_factor numeric(18,6) not null
      check (conversion_factor > 0 and conversion_factor::text not in ('NaN','Infinity','-Infinity')),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (num_nonnulls(supplier_product_code, barcode_normalized, description_normalized) > 0)
);

create unique index ux_market_purchase_unit_conversions_identity
    on public.market_purchase_unit_conversions (
        market_account_id,
        coalesce(supplier_document, ''),
        coalesce(supplier_product_code, ''),
        coalesce(barcode_normalized, ''),
        coalesce(description_normalized, ''),
        source_unit
    );

create trigger market_purchase_unit_conversions_touch_updated_at
before update on public.market_purchase_unit_conversions
for each row execute function public.market_touch_purchase_updated_at();

alter table public.market_purchase_unit_conversions enable row level security;

create policy market_purchase_unit_conversions_select
on public.market_purchase_unit_conversions for select to authenticated
using (public.market_is_member(market_account_id));

grant select on table public.market_purchase_unit_conversions to authenticated;
-- Sem insert/update/delete para authenticated: escrita só pelas RPCs abaixo.

comment on table public.market_purchase_unit_conversions is
  'Fator de embalagem->estoque reaproveitável por fornecedor/código/unidade documental. Tenant-scoped; não é conferência.';

-- Resolve conversion_factor/stock_unit a partir do produto conciliado e, quando
-- as unidades divergem, de uma conversão conhecida não ambígua. Nunca promove
-- descrição (ex.: "CX 6 UN") a fator automaticamente — só reaproveita conversão
-- já confirmada explicitamente por um humano via market_save_purchase_item_conversion.
create function public.market_resolve_purchase_item_unit(p_market_account_id uuid, p_purchase_item_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
    v_item public.market_purchase_items;
    v_product public.market_products;
    v_supplier_document text;
    v_source text;
    v_target text;
    v_count integer;
    v_factor numeric(18,6);
    v_conv_stock_unit text;
begin
    select * into v_item from public.market_purchase_items
      where id = p_purchase_item_id and market_account_id = p_market_account_id for update;
    if not found then return; end if;

    if v_item.market_product_id is null then
        update public.market_purchase_items set conversion_factor = null, stock_unit = null where id = v_item.id;
        return;
    end if;

    select * into v_product from public.market_products
      where id = v_item.market_product_id and market_account_id = p_market_account_id;
    if not found then
        update public.market_purchase_items set conversion_factor = null, stock_unit = null where id = v_item.id;
        return;
    end if;

    v_source := upper(btrim(v_item.unit));
    v_target := upper(btrim(v_product.unit));

    if v_source = v_target then
        update public.market_purchase_items set conversion_factor = 1, stock_unit = v_item.unit where id = v_item.id;
        return;
    end if;

    select p.supplier_document into v_supplier_document
      from public.market_purchases p where p.id = v_item.market_purchase_id and p.market_account_id = p_market_account_id;

    v_count := 0; v_factor := null; v_conv_stock_unit := null;
    if nullif(btrim(v_item.supplier_product_code), '') is not null then
        -- Mesmo critério de identidade de market_purchase_product_mappings:
        -- código do fornecedor como âncora obrigatória, barcode/descrição como
        -- refinadores opcionais quando preenchidos na conversão salva.
        select count(*), min(c.conversion_factor), min(c.stock_unit)
        into v_count, v_factor, v_conv_stock_unit
        from public.market_purchase_unit_conversions c
        where c.market_account_id = p_market_account_id
          and coalesce(c.supplier_document, '') = coalesce(nullif(btrim(v_supplier_document), ''), '')
          and c.supplier_product_code = nullif(btrim(v_item.supplier_product_code), '')
          and c.source_unit = v_source
          and (nullif(btrim(c.barcode_normalized), '') is null or c.barcode_normalized = v_item.barcode_normalized)
          and (nullif(btrim(c.description_normalized), '') is null
            or upper(regexp_replace(btrim(c.description_normalized), '[[:space:]]+', ' ', 'g'))
              = upper(regexp_replace(btrim(v_item.description_raw), '[[:space:]]+', ' ', 'g')));
    end if;

    -- Ambíguo (>1) ou inexistente: não escolhe nem infere, fica pendente de
    -- confirmação humana explícita.
    if v_count = 1 and upper(btrim(v_conv_stock_unit)) = v_target then
        update public.market_purchase_items set conversion_factor = v_factor, stock_unit = v_product.unit where id = v_item.id;
    else
        update public.market_purchase_items set conversion_factor = null, stock_unit = null where id = v_item.id;
    end if;
end;
$$;

-- market_product_id passa a arrastar a resolução de unidade: casar produto
-- (auto ou manual), desfazer o match, ou o código/unidade do documento mudar
-- de identidade sempre recalculam; demais edições preservam o que já foi
-- resolvido/confirmado.
create or replace function public.market_guard_purchase_item_review()
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
    or new.reconciliation_status is distinct from old.reconciliation_status
    or new.conversion_factor is distinct from old.conversion_factor
    or new.stock_unit is distinct from old.stock_unit;
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

-- Ao salvar correções: se código/EAN mudam, produto e conversão são resetados
-- (mesma âncora de identidade); se só a unidade do documento muda, o produto
-- pode continuar valendo mas a conversão precisa ser recalculada. Preço,
-- quantidade e descrição isolados não tocam a conversão já resolvida/confirmada.
create or replace function public.market_save_purchase_item_review(
  p_market_account_id uuid, p_purchase_item_id uuid, p_values jsonb,
  p_expected_updated_at timestamptz, p_confirm boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.market_purchase_items; v_purchase uuid; v_values public.market_purchase_items; v_barcode text;
  v_identity_changed boolean; v_unit_changed boolean;
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
  v_identity_changed := v_item.supplier_product_code is distinct from nullif(btrim(v_values.supplier_product_code),'')
      or v_item.barcode_raw is distinct from nullif(btrim(v_values.barcode_raw),'');
  v_unit_changed := upper(btrim(v_item.unit)) is distinct from upper(btrim(v_values.unit));
  update public.market_purchase_items set
    supplier_product_code = nullif(btrim(v_values.supplier_product_code),''), barcode_raw = nullif(btrim(v_values.barcode_raw),''),
    barcode_normalized = v_barcode, description_raw = btrim(v_values.description_raw), unit = upper(btrim(v_values.unit)),
    quantity = v_values.quantity, unit_price = v_values.unit_price, gross_amount = v_values.gross_amount,
    net_amount = v_values.net_amount, discount_amount = coalesce(v_values.discount_amount,0),
    freight_amount = coalesce(v_values.freight_amount,0), other_amount = coalesce(v_values.other_amount,0),
    reviewed_at = null, reviewed_by = null,
    market_product_id = case when v_identity_changed then null else v_item.market_product_id end,
    reconciliation_status = case when v_identity_changed then 'pending' else v_item.reconciliation_status end,
    reconciliation_method = case when v_identity_changed then null else v_item.reconciliation_method end,
    reconciliation_confidence = case when v_identity_changed then null else v_item.reconciliation_confidence end
  where id = v_item.id and market_account_id = p_market_account_id;
  if v_identity_changed or v_unit_changed then
    perform public.market_resolve_purchase_item_unit(p_market_account_id, v_item.id);
  end if;
  if p_confirm then
    select * into v_item from public.market_purchase_items where id = v_item.id;
    if v_item.market_product_id is null or v_item.reconciliation_status not in ('matched_auto','matched_manual','mapped')
      or not exists (select 1 from public.market_products pr where pr.id = v_item.market_product_id
        and pr.market_account_id = p_market_account_id and pr.status = 'active'
        and public.market_is_accesys_current_product(p_market_account_id,pr.id)) then raise exception 'PURCHASE_REVIEW_MATCH_REQUIRED'; end if;
    if v_item.conversion_factor is null or v_item.stock_unit is null then raise exception 'PURCHASE_ITEM_CONVERSION_REQUIRED'; end if;
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

-- Completar a compra passa a exigir também a conversão resolvida, com o mesmo
-- gate de PURCHASE_REVIEW_INCOMPLETE já usado para produto/conferência.
create or replace function public.market_complete_purchase_review(p_market_account_id uuid, p_purchase_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.market_assert_purchase_review_access(p_market_account_id,p_purchase_id);
  perform 1 from public.market_purchase_items where market_purchase_id=p_purchase_id and market_account_id=p_market_account_id for update;
  if not exists (select 1 from public.market_purchase_items where market_purchase_id=p_purchase_id and market_account_id=p_market_account_id)
    or exists (select 1 from public.market_purchase_items i where i.market_purchase_id=p_purchase_id and i.market_account_id=p_market_account_id
      and (i.reviewed_at is null or i.reviewed_by is null or i.stock_entry_status <> 'pending'
        or i.reconciliation_status not in ('matched_auto','matched_manual','mapped') or i.market_product_id is null
        or i.conversion_factor is null or i.stock_unit is null
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

-- Match manual agora também resolve a unidade (auto se igual, conversão
-- conhecida se houver uma só compatível). Resolver != conferir: reviewed_at
-- do item continua null até o humano confirmar.
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
    end if;

    return jsonb_build_object(
        'purchaseItemId', p_purchase_item_id,
        'marketProductId', p_market_product_id,
        'reconciliationStatus', 'matched_manual'
    );
end;
$$;

-- Desfazer o match também limpa a conversão: ela era relativa ao produto
-- anterior e não deve sobreviver a uma reconciliação em branco.
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

    perform public.market_resolve_purchase_item_unit(p_market_account_id, p_purchase_item_id);

    return jsonb_build_object('purchaseItemId', p_purchase_item_id, 'reconciliationStatus', 'pending');
end;
$$;

-- Mesmo match existente; agora também resolve a unidade de cada item recém
-- casado (auto match ou de/para), sem tornar isso conferência.
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
            perform public.market_resolve_purchase_item_unit(p_market_account_id, v_item.id);
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
                perform public.market_resolve_purchase_item_unit(p_market_account_id, v_item.id);
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

-- Confirma/corrige a conversão de embalagem de um item já conciliado. Sempre
-- deriva a unidade de estoque do produto atual (nunca aceita do cliente), e
-- opcionalmente memoriza o fator para reaproveitar em compras futuras
-- equivalentes (mesmo tenant; nunca compartilhado entre Markets).
create function public.market_save_purchase_item_conversion(
  p_market_account_id uuid, p_purchase_item_id uuid, p_conversion_factor numeric,
  p_expected_updated_at timestamptz, p_save_for_reuse boolean default false
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item public.market_purchase_items; v_purchase uuid; v_product public.market_products; v_supplier_document text;
begin
  select market_purchase_id into v_purchase from public.market_purchase_items
    where id = p_purchase_item_id and market_account_id = p_market_account_id;
  perform public.market_assert_purchase_review_access(p_market_account_id, v_purchase);
  select * into v_item from public.market_purchase_items
    where id = p_purchase_item_id and market_account_id = p_market_account_id for update;
  if not found then raise exception 'RECONCILE_ITEM_NOT_FOUND'; end if;
  if v_item.stock_entry_status <> 'pending' then raise exception 'RECONCILE_STOCK_ALREADY_ADVANCED'; end if;
  if p_expected_updated_at is null or v_item.updated_at <> p_expected_updated_at then raise exception 'PURCHASE_REVIEW_CONFLICT'; end if;
  if v_item.market_product_id is null then raise exception 'RECONCILE_PRODUCT_REQUIRED'; end if;
  if p_conversion_factor is null or p_conversion_factor::text in ('NaN','Infinity','-Infinity') or p_conversion_factor <= 0
    or p_conversion_factor <> round(p_conversion_factor,6) then raise exception 'PURCHASE_ITEM_CONVERSION_INVALID'; end if;
  select * into v_product from public.market_products where id = v_item.market_product_id and market_account_id = p_market_account_id;
  if not found then raise exception 'RECONCILE_PRODUCT_NOT_FOUND'; end if;
  update public.market_purchase_items set conversion_factor = p_conversion_factor, stock_unit = v_product.unit
    where id = v_item.id and market_account_id = p_market_account_id;
  if p_save_for_reuse and nullif(btrim(v_item.supplier_product_code), '') is not null then
    select supplier_document into v_supplier_document from public.market_purchases
      where id = v_purchase and market_account_id = p_market_account_id;
    insert into public.market_purchase_unit_conversions(
      market_account_id, supplier_document, supplier_product_code, barcode_normalized, description_normalized,
      source_unit, stock_unit, conversion_factor, created_by
    ) values (
      p_market_account_id, nullif(btrim(v_supplier_document),''), nullif(btrim(v_item.supplier_product_code),''),
      null, null, upper(btrim(v_item.unit)), v_product.unit, p_conversion_factor, auth.uid()
    )
    on conflict (
      market_account_id, coalesce(supplier_document,''), coalesce(supplier_product_code,''),
      coalesce(barcode_normalized,''), coalesce(description_normalized,''), source_unit
    )
    do update set conversion_factor = excluded.conversion_factor, stock_unit = excluded.stock_unit;
  end if;
  return jsonb_build_object(
    'purchaseItemId', v_item.id, 'conversionFactor', p_conversion_factor, 'stockUnit', v_product.unit
  );
end;
$$;

revoke all on function public.market_resolve_purchase_item_unit(uuid,uuid), public.market_save_purchase_item_conversion(uuid,uuid,numeric,timestamptz,boolean)
  from public, anon, authenticated;
grant execute on function public.market_save_purchase_item_conversion(uuid,uuid,numeric,timestamptz,boolean) to authenticated;

commit;
