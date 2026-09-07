-- Aplicação MANUAL. Generaliza o staging estruturado de compras (hoje só PDF)
-- para aceitar também texto colado interpretado por IA externa (Texto IA).
-- Mesmo pipeline: staging -> conciliação -> conversão -> conferência humana.
-- Nenhum recebimento, nenhum ledger, nenhuma movimentação de estoque.
-- Depende de 202609070001/002/003 (já aplicadas). Não as altera.
begin;

alter table public.market_purchases
    drop constraint market_purchases_source_type_check,
    add constraint market_purchases_source_type_check check (
        source_type in ('qrcode','nfe','xml','pdf','image','import','api','ai_text')
    );

-- Idempotência equivalente à do PDF (hash do texto ORIGINAL colado pela IA,
-- calculado no cliente antes de qualquer correção humana — ver
-- src/components/PurchaseAiTextCapture.tsx), escopada por tenant e por
-- source_type para não colidir com referências de outras origens.
create unique index ux_market_purchase_ai_text_source
    on public.market_purchases(market_account_id, source_reference)
    where source_type = 'ai_text';

-- O corpo desta função já era agnóstico ao formato de origem; só o literal
-- 'pdf' estava fixo no INSERT e na busca de idempotência. Generalizado via
-- p_source_type (default 'pdf' preserva 100% o comportamento/chamadas atuais
-- do fluxo PDF, inclusive nos testes). Precisa DROP + CREATE (não "or
-- replace") porque a lista de parâmetros muda de tamanho.
drop function public.market_import_pdf_purchase_staging(uuid,uuid,text,jsonb,jsonb);

create function public.market_import_pdf_purchase_staging(
  p_market_account_id uuid, p_destination_store_id uuid, p_source_reference text, p_document jsonb, p_original jsonb,
  p_source_type text default 'pdf'
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_existing_store uuid; v_item jsonb; v_index integer:=0; v_key text; v_header jsonb:=p_document->'header'; v_barcode text;
begin
  if p_source_type not in ('pdf','ai_text') then raise exception 'PURCHASE_SOURCE_TYPE_INVALID'; end if;
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
    and ((v_key is not null and invoice_key=v_key) or (source_type=p_source_type and source_reference=p_source_reference));
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
    (v_header->>'freight')::numeric,(v_header->>'otherExpenses')::numeric,p_source_type,p_source_reference,
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

revoke all on function public.market_import_pdf_purchase_staging(uuid,uuid,text,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.market_import_pdf_purchase_staging(uuid,uuid,text,jsonb,jsonb,text) to authenticated;

comment on function public.market_import_pdf_purchase_staging(uuid,uuid,text,jsonb,jsonb,text) is
  'Staging estruturado de compras (PDF ou Texto IA); grava original e interpretação atomicamente, idempotente por tenant+source_type+source_reference.';

commit;
