-- Analise somente de leitura. Nao altera RLS, custos, precos ou fluxos existentes.
-- O custo e compartilhado no Market; preco/meta pertencem a loja autorizada.
begin;

create schema if not exists market_private;
revoke all on schema market_private from public, anon;
grant usage on schema market_private to authenticated;

create function market_private.sale_margin_analysis(p_market_account_id uuid, p_store_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare v_result jsonb;
begin
  if auth.uid() is null
     or not public.market_has_role(p_market_account_id, array['owner','admin','manager','operator'])
     or not public.market_can_access_store(p_store_id)
     or not exists (
       select 1 from public.market_stores s
       join public.market_accounts a on a.id = s.market_account_id
       where s.id = p_store_id and s.market_account_id = p_market_account_id
         and s.store_type = 'store' and s.status = 'active' and a.status in ('pilot','active')
     ) then
    raise exception 'SALE_MARGIN_ACCESS_DENIED' using errcode = '42501';
  end if;

  with inputs as (
    select p.id as product_id, p.name as product_name, p.ean,
      coalesce(nullif(p.sku, ''), d.external_product_id) as code,
      sp.minimum_margin_pct as desired_margin_pct, d.current_sale_price as sale_price,
      coalesce(c.unit_cost, d.current_cost) as cost,
      case when c.unit_cost is not null then 'COMPRA GIROMICRO' else 'ACCESYS' end as cost_source,
      c.purchase_date, c.supplier_name, c.invoice_number
    from public.market_store_products sp
    join public.market_products p on p.id = sp.product_id and p.market_account_id = sp.market_account_id
    -- Primeiro resolve o registro mais recente, depois valida os valores.
    -- Um preco atual ausente/zero nunca e substituido por preco antigo/outra loja.
    join lateral (
      select d.current_sale_price, d.current_cost, d.external_product_id
      from public.market_product_store_data d
      join public.market_integrations integration on integration.id = d.integration_id
        and integration.market_account_id = d.market_account_id and integration.provider = 'accesys'
      where d.market_account_id = p_market_account_id and d.market_store_id = p_store_id
        and d.product_id = p.id
      order by d.source_synced_at desc, d.updated_at desc, d.id desc
      limit 1
    ) d on true
    left join lateral (
      -- Mesmo criterio de ultima compra usado no ultimo fornecedor homologado:
      -- emissao, recebimento, movimento e ID. Sem filtro da loja de destino.
      select coalesce(m.unit_cost, i.stock_unit_cost) as unit_cost,
        coalesce(b.issued_at, i.received_at, m.occurred_at) as purchase_date,
        b.supplier_name, b.invoice_number
      from public.market_purchase_items i
      join public.market_purchases b on b.id = i.market_purchase_id
        and b.market_account_id = i.market_account_id and b.status in ('receiving','completed')
      join public.market_stock_movements m on m.market_account_id = i.market_account_id
        and m.market_store_id = b.destination_store_id and m.product_id = i.market_product_id
        and m.movement_type = 'PURCHASE' and m.direction = 'IN' and m.reference_type = 'PURCHASE'
        and m.reference_id = b.id and m.reference_item_id = i.id and m.quantity = i.stock_quantity
      where i.market_account_id = p_market_account_id and i.market_product_id = p.id
        and i.stock_entry_status = 'received' and i.received_at is not null
        and i.stock_quantity > 0 and i.stock_unit is not null
        and i.reconciliation_status in ('matched_auto','matched_manual','mapped')
        and coalesce(m.unit_cost, i.stock_unit_cost) > 0
        and coalesce(m.unit_cost, i.stock_unit_cost) < 'Infinity'::numeric
      order by coalesce(b.issued_at, i.received_at, m.occurred_at) desc nulls last,
        i.received_at desc nulls last, m.occurred_at desc nulls last, i.id desc
      limit 1
    ) c on true
    where sp.market_account_id = p_market_account_id and sp.market_store_id = p_store_id
      and sp.minimum_margin_pct is not null
  ), calculated as (
    select inputs.*, ((sale_price - cost) / sale_price) * 100 as current_margin_pct
    from inputs where sale_price > 0 and sale_price < 'Infinity'::numeric
      and cost > 0 and cost < 'Infinity'::numeric
  ), exceptions as (
    select calculated.*, desired_margin_pct - current_margin_pct as difference_pp
    from calculated where current_margin_pct < desired_margin_pct
  )
  select coalesce(jsonb_agg(to_jsonb(e) order by e.difference_pp desc, e.product_name, e.product_id), '[]'::jsonb)
    into v_result from exceptions e;
  -- JSON unico evita truncamento pelo limite de linhas da Data API no Excel.
  return v_result;
end;
$$;

revoke all on function market_private.sale_margin_analysis(uuid,uuid) from public, anon;
grant execute on function market_private.sale_margin_analysis(uuid,uuid) to authenticated;

create function public.market_get_sale_margin_analysis(p_market_account_id uuid, p_store_id uuid)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select market_private.sale_margin_analysis(p_market_account_id, p_store_id); $$;
revoke all on function public.market_get_sale_margin_analysis(uuid,uuid) from public, anon;
grant execute on function public.market_get_sale_margin_analysis(uuid,uuid) to authenticated;

comment on function public.market_get_sale_margin_analysis(uuid,uuid) is
  'Excecoes de margem por loja autorizada. Custo recebido no Market, fallback Accesys local; somente leitura.';
commit;
