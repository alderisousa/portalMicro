-- Aplicação MANUAL. Corrige bug de market_resolve_purchase_item_unit: quando
-- as unidades divergiam e não havia conversão conhecida, a função zerava
-- também stock_unit (não só conversion_factor), fazendo a UI mostrar
-- "Unidade de estoque: ?" mesmo com produto já conciliado (visto no smoke
-- test JF/ean_exact; o mesmo bug também explica o "?" transitório relatado no
-- fluxo manual da Carmel antes de salvar). stock_unit é sempre conhecida a
-- partir do produto conciliado, independente de o fator já estar confirmado.
-- Depende de 202609070001 e 202609070002 (já aplicadas). Não altera nenhuma
-- das duas. Não gera ledger, não mexe em estoque.
begin;

create or replace function public.market_resolve_purchase_item_unit(p_market_account_id uuid, p_purchase_item_id uuid)
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

    -- Defensivo: unit é not null default 'UN' hoje, mas se o produto sincronizado
    -- chegar com unidade vazia não fingimos conhecer o destino da conversão.
    if nullif(v_target, '') is null then
        update public.market_purchase_items set conversion_factor = null, stock_unit = null where id = v_item.id;
        return;
    end if;

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

    -- Ambíguo (>1) ou inexistente: não escolhe nem infere o FATOR, fica
    -- pendente de confirmação humana explícita. Mas a unidade de estoque já é
    -- conhecida (é a do produto conciliado) e não deve ficar nula/"?" só
    -- porque o fator ainda não foi informado — este era o bug.
    if v_count = 1 and upper(btrim(v_conv_stock_unit)) = v_target then
        update public.market_purchase_items set conversion_factor = v_factor, stock_unit = v_product.unit where id = v_item.id;
    else
        update public.market_purchase_items set conversion_factor = null, stock_unit = v_product.unit where id = v_item.id;
    end if;
end;
$$;

-- Defesa equivalente na gravação manual: nunca aceitar fator quando a unidade
-- de estoque do produto realmente não é conhecida (mesmo caso defensivo acima).
create or replace function public.market_save_purchase_item_conversion(
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
  if nullif(btrim(v_product.unit), '') is null then raise exception 'RECONCILE_PRODUCT_UNIT_MISSING'; end if;
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

-- Backfill: itens já conciliados que ficaram com stock_unit=null só por causa
-- do bug (conversion_factor também null, unidades divergentes) recebem agora
-- a unidade de estoque do produto conciliado. Fator continua pendente.
update public.market_purchase_items i
set stock_unit = pr.unit
from public.market_products pr
where pr.id = i.market_product_id
  and pr.market_account_id = i.market_account_id
  and i.market_product_id is not null
  and i.conversion_factor is null
  and i.stock_unit is null
  and nullif(btrim(pr.unit), '') is not null;

commit;
