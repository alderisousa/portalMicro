-- Aplicação MANUAL. Ajuste sobre 202609070005 (já aplicada): "Dar entrada" não
-- pode gerar movimento de estoque sem custo unitário de aquisição conhecido.
--
-- Caso real que motivou o ajuste (compra NORAC): itens com conversion_factor=1,
-- stock_unit resolvido e conferência já feita, mas net_amount ausente no
-- documento (comum no Texto IA, que por desenho não promove gross_amount a
-- net_amount sozinho) — stock_unit_cost (coluna gerada) ficava null mesmo com
-- a conversão 100% resolvida, e o item ainda assim contava como pronto para
-- receber. Isso geraria entrada de estoque sem custo de aquisição.
--
-- Único objeto alterado: market_receive_purchase_items, via CREATE OR REPLACE
-- (mesma assinatura uuid,uuid — substitui a função já aplicada pela 005, não
-- cria uma nova). Corpo idêntico ao da 005, só acrescentando
-- "and i.stock_unit_cost is not null" ao critério de seleção dos itens
-- prontos. Nenhuma coluna, índice, view, grant ou outra função é recriada
-- aqui — tudo isso já existe e não muda.
--
-- Não depende de nenhuma migration além da 202609070005 (já aplicada). Não
-- altera 001/002/003/004/005.
begin;

create or replace function public.market_receive_purchase_items(
  p_market_account_id uuid, p_purchase_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_purchase public.market_purchases;
  v_item record;
  v_inserted integer;
  v_received_now integer := 0;
  v_total_items integer;
  v_received_items integer;
  v_new_status text;
begin
  if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
    raise exception 'RECONCILE_PERMISSION_DENIED';
  end if;
  select * into v_purchase from public.market_purchases
    where id = p_purchase_id and market_account_id = p_market_account_id for update;
  if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
    raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
  end if;
  if v_purchase.status in ('completed','cancelled','failed') or not exists (
    select 1 from public.market_accounts where id = p_market_account_id and status in ('pilot','active')
  ) then
    raise exception 'PURCHASE_REVIEW_LOCKED';
  end if;

  for v_item in
    select i.* from public.market_purchase_items i
    where i.market_purchase_id = p_purchase_id
      and i.market_account_id = p_market_account_id
      and i.stock_entry_status = 'pending'
      and i.market_product_id is not null
      and i.reconciliation_status in ('matched_auto','matched_manual','mapped')
      and i.conversion_factor is not null
      and i.stock_unit is not null
      -- NOVO nesta migration: sem custo unitário de aquisição, o item não
      -- entra automaticamente — mesmo com conversão resolvida e conferido.
      and i.stock_unit_cost is not null
      and i.reviewed_at is not null
      and i.reviewed_by is not null
    for update
  loop
    -- Revalida o produto no instante da entrada (pode ter mudado desde a
    -- conferência): item permanece pendente, sem travar os demais.
    if not exists (
      select 1 from public.market_products pr
      where pr.id = v_item.market_product_id and pr.market_account_id = p_market_account_id
        and pr.status = 'active' and public.market_is_accesys_current_product(p_market_account_id, pr.id)
    ) then
      continue;
    end if;

    insert into public.market_stock_movements(
      market_account_id, market_store_id, product_id, movement_type, direction,
      quantity, unit_cost, reference_type, reference_id, reference_item_id, notes, occurred_at, created_by
    ) values (
      p_market_account_id, v_purchase.destination_store_id, v_item.market_product_id, 'PURCHASE', 'IN',
      v_item.stock_quantity, v_item.stock_unit_cost, 'PURCHASE', v_purchase.id, v_item.id,
      'Recebimento da compra' || case when v_purchase.invoice_number is not null then ' ' || v_purchase.invoice_number else '' end,
      now(), auth.uid()
    )
    -- ux_market_stock_movements_source_item é parcial: o arbitro do ON CONFLICT
    -- só resolve para ela se o predicado for repetido aqui (não basta citar as colunas).
    on conflict (market_account_id, movement_type, reference_type, reference_id, reference_item_id)
      where reference_type is not null and reference_id is not null and reference_item_id is not null
      do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      continue;
    end if;

    update public.market_purchase_items
      set stock_entry_status = 'received', received_at = now(), received_by = auth.uid()
      where id = v_item.id and market_account_id = p_market_account_id;
    v_received_now := v_received_now + 1;
  end loop;

  if v_received_now = 0 then
    raise exception 'PURCHASE_RECEIVE_NO_READY_ITEMS';
  end if;

  select count(*), count(*) filter (where stock_entry_status = 'received')
    into v_total_items, v_received_items
    from public.market_purchase_items
    where market_purchase_id = p_purchase_id and market_account_id = p_market_account_id;

  if v_received_items = v_total_items then
    v_new_status := 'completed';
    update public.market_purchases set status = 'completed', received_at = now()
      where id = p_purchase_id and market_account_id = p_market_account_id;
  else
    v_new_status := 'receiving';
    update public.market_purchases set status = 'receiving'
      where id = p_purchase_id and market_account_id = p_market_account_id;
  end if;

  return jsonb_build_object(
    'purchaseId', p_purchase_id,
    'itemsReceivedNow', v_received_now,
    'itemsReceivedTotal', v_received_items,
    'itemsTotal', v_total_items,
    'purchaseStatus', v_new_status
  );
end;
$$;

comment on function public.market_receive_purchase_items(uuid,uuid) is
  'Gera entrada de estoque (market_stock_movements, tipo PURCHASE) para os itens da compra já conciliados+conversão resolvida+custo unitário de estoque resolvido+conferidos e ainda pendentes. Linha indivisível; sem estorno. Conclui a compra automaticamente quando 100% dos itens forem recebidos.';

-- Grants inalterados: já concedidos pela 202609070005 e não são revogados por
-- um CREATE OR REPLACE (a função mantém o mesmo oid). Reafirmar aqui não
-- corrige nada e só arriscaria uma janela sem permissão caso a ordem de
-- comandos importasse — por isso omitido de propósito.

commit;
