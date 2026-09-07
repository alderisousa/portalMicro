-- Aplicação MANUAL. Recebimento de compras: gera entrada REAL de estoque a
-- partir de itens já conciliados + conversão resolvida + conferidos. Uma
-- linha é indivisível nesta etapa (recebe inteira ou não recebe). Reaproveita
-- a arquitetura de estoque já existente (market_stock_movements append-only +
-- market_stock_balance como view derivada) — não cria mecanismo paralelo.
-- Não implementa estorno/devolução/recebimento parcial de quantidade.
-- Depende de 202609070001/002/003/004 (já aplicadas). Não as altera.
begin;

-- Provenance do recebimento por item, no mesmo padrão de reviewed_at/reviewed_by
-- já usado para a conferência humana. "Quantidade recebida" não precisa de
-- coluna própria: é sempre 100% de stock_quantity nesta etapa (linha indivisível).
alter table public.market_purchase_items
  add column received_at timestamptz null,
  add column received_by uuid null references auth.users(id) on delete set null,
  add constraint purchase_item_received_actor check ((received_at is null) = (received_by is null));

comment on column public.market_purchase_items.received_at is
  'Quando a linha gerou entrada real de estoque. Junto de stock_entry_status=received, torna a linha imutável (RPCs de edição já checam stock_entry_status).';

-- Larguras originais (numeric(14,3)/numeric(14,4)) truncavam silenciosamente a
-- 4ª casa de stock_quantity (numeric(18,4)) e a 6ª de stock_unit_cost
-- (numeric(18,6)). Alargamento é compatível: valores existentes (sempre com
-- menos casas) são preservados; nenhuma outra origem de movimento (venda,
-- transferência, inventário) é afetada pela mudança. A view precisa ser
-- derrubada antes: Postgres recusa ALTER COLUMN TYPE em coluna referenciada
-- por view/rule ("cannot alter type of a column used by a view or rule").
drop view public.market_stock_balance;

alter table public.market_stock_movements
  alter column quantity type numeric(18,4),
  alter column unit_cost type numeric(18,6);

create view public.market_stock_balance as
select
    m.market_account_id,
    m.market_store_id,
    m.product_id,
    sum(
        case
            when m.direction = 'IN' then m.quantity
            else -m.quantity
        end
    )::numeric(18,4) as quantity_on_hand,
    max(m.occurred_at) as last_movement_at
from public.market_stock_movements m
group by
    m.market_account_id,
    m.market_store_id,
    m.product_id;

alter view public.market_stock_balance set (security_invoker = true);
revoke all on public.market_stock_balance from public, anon, authenticated;

-- 'receiving' (compra parcialmente recebida) precisa continuar editável para
-- os itens AINDA não recebidos: a imutabilidade do item já recebido é
-- garantida à parte, por linha, via stock_entry_status <> 'pending' (checado
-- em toda RPC de edição de item). Sem este ajuste, receber o 1º item travaria
-- a edição dos demais itens da MESMA compra ainda pendentes de trabalho. Duas
-- funções têm essa mesma checagem duplicada (histórico do projeto): o guard
-- de UPDATE em market_purchase_items e a função de acesso chamada por toda
-- RPC de edição/conciliação/conversão. As duas precisam do mesmo ajuste.
-- 'completed' continua fora da lista: compra 100% recebida vai para o
-- Histórico e não deve aceitar nenhuma edição, nem de itens teoricamente
-- pendentes (não deveria haver nenhum, mas o bloqueio é defesa em profundidade).
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
      and p.status in ('imported','reconciling','pending','ready','receiving') and a.status in ('pilot','active')) then
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

create or replace function public.market_assert_purchase_review_access(p_account uuid, p_purchase uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_purchase public.market_purchases;
begin
  if not public.market_has_role(p_account, array['owner','admin','manager']) then raise exception 'RECONCILE_PERMISSION_DENIED'; end if;
  select * into v_purchase from public.market_purchases where id = p_purchase and market_account_id = p_account for update;
  if not found or not public.market_can_access_store(v_purchase.destination_store_id) then raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE'; end if;
  if v_purchase.status not in ('imported','reconciling','pending','ready','receiving') or not exists (
    select 1 from public.market_accounts where id = p_account and status in ('pilot','active')
  ) then raise exception 'PURCHASE_REVIEW_LOCKED'; end if;
end;
$$;

-- "Dar entrada": processa automaticamente TODOS os itens ainda não recebidos
-- que estejam conciliados + com conversão resolvida + conferidos (mesmo
-- critério já exigido para confirmar a conferência em
-- market_save_purchase_item_review/market_complete_purchase_review). Sem
-- seleção manual de linha, sem recebimento parcial de quantidade: cada linha
-- pronta entra 100% ou não entra. Idempotente via o índice único já existente
-- em market_stock_movements (reference_type/reference_id/reference_item_id) +
-- FOR UPDATE por item, que também resolve concorrência entre operadores.
create function public.market_receive_purchase_items(
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

-- "Excluir nota": só quando NENHUM item da compra tiver saído do estado
-- intocado (nem conciliado, nem conferido, nem recebido). Cascade em
-- market_purchase_items já existe (foreign key on delete cascade, migration
-- inicial) — apagar a compra remove os itens atomicamente. Nunca toca
-- market_purchase_product_mappings/market_purchase_unit_conversions (de/para
-- e conversões globais por fornecedor, sem FK para a compra) nem produtos.
create function public.market_delete_purchase_staging(
  p_market_account_id uuid, p_purchase_id uuid
) returns void language plpgsql security definer set search_path = public as $$
declare v_purchase public.market_purchases;
begin
  if not public.market_has_role(p_market_account_id, array['owner','admin','manager']) then
    raise exception 'RECONCILE_PERMISSION_DENIED';
  end if;
  select * into v_purchase from public.market_purchases
    where id = p_purchase_id and market_account_id = p_market_account_id for update;
  if not found or not public.market_can_access_store(v_purchase.destination_store_id) then
    raise exception 'RECONCILE_PURCHASE_NOT_ACCESSIBLE';
  end if;
  if exists (
    select 1 from public.market_purchase_items i
    where i.market_purchase_id = p_purchase_id and i.market_account_id = p_market_account_id
      and (i.reconciliation_status <> 'pending' or i.reviewed_at is not null or i.stock_entry_status <> 'pending')
    for update
  ) then
    raise exception 'PURCHASE_DELETE_NOT_ALLOWED';
  end if;
  delete from public.market_purchases where id = p_purchase_id and market_account_id = p_market_account_id;
end;
$$;

revoke all on function public.market_receive_purchase_items(uuid,uuid), public.market_delete_purchase_staging(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.market_receive_purchase_items(uuid,uuid), public.market_delete_purchase_staging(uuid,uuid) to authenticated;

comment on function public.market_receive_purchase_items(uuid,uuid) is
  'Gera entrada de estoque (market_stock_movements, tipo PURCHASE) para os itens da compra já conciliados+conversão resolvida+conferidos e ainda pendentes. Linha indivisível; sem estorno. Conclui a compra automaticamente quando 100% dos itens forem recebidos.';
comment on function public.market_delete_purchase_staging(uuid,uuid) is
  'Exclui uma nota importada e seus itens, somente enquanto nenhum item tiver sido conciliado, conferido ou recebido. Não afeta mappings/conversões globais nem outras compras.';

commit;
