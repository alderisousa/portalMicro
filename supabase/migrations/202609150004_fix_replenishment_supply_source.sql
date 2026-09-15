-- Reposicao Inteligente / Corrige Abastecer para respeitar a decisao
-- Galpao x Comprar da revisao (202609150003 ja foi aplicada em homologacao
-- e e imutavel -- esta migration so redefine, por cima dela, exatamente o
-- necessario para esta correcao pontual).
--
-- Bug confirmado no smoke da Vitality: uma allocation com necessidade 6,
-- warehouse_allocated_quantity=0, purchase_needed_quantity=6 (so existe
-- operation_line 'purchase', nenhuma 'warehouse') aparecia na aba Abastecer
-- sempre que o Galpao tivesse saldo fisico suficiente para a NECESSIDADE
-- TOTAL (6), mesmo a decisao do operador tendo sido "nao usar Galpao, so
-- comprar". Outro caso identico: necessidade 10, Galpao=0/Comprar=10, so
-- operation_line purchase=10, mesmo assim apareceu em Abastecer por haver
-- saldo fisico no Galpao.
--
-- Causa raiz: market_replenishment_physical_needs_internal (202609150003)
-- expunha somente target/delivered/remaining, que representam a
-- NECESSIDADE FISICA TOTAL da allocation (Galpao + Compra) -- correto e
-- necessario para o Historico (202609150002), que precisa ver a necessidade
-- inteira para aplicar a regra "comprado mas nao recebido = pendente". Os
-- dois consumidores de abastecimento
-- (market_replenishment_supply_queue_internal e
-- market_execute_replenishment_store_supply) reaproveitavam esse mesmo
-- "remaining" total para decidir o que entra na fila e quanto pode ser
-- abastecido do Galpao -- sem nenhum vinculo com a warehouse operation_line
-- realmente criada pela revisao/liberacao. Resultado: saldo existente no
-- Galpao (de qualquer origem) alterava, de fato, a origem que o operador
-- havia decidido explicitamente.
--
-- Regra funcional: saldo existente no Galpao e informacao para o operador,
-- nunca decisao automatica. Uma allocation so pode ser abastecida do Galpao
-- ate o limite que o proprio operador destinou a ele na revisao/liberacao
-- (warehouse_allocated_quantity, materializado como a warehouse
-- operation_line da approval_revision corrente) -- nunca acima disso, e
-- nunca quando essa parcela for zero/inexistente, mesmo com saldo fisico
-- disponivel.
--
-- Correcao (menor mudanca segura, sem tocar a 0003 nem o Historico):
-- market_replenishment_physical_needs_internal MANTEM target/delivered/
-- remaining exatamente como estavam (necessidade fisica total -- o
-- Historico continua dependendo disso sem nenhuma alteracao de contrato) e
-- GANHA duas colunas novas, warehouse_target/warehouse_remaining, isolando
-- especificamente a parcela operacional de Galpao: warehouse_target vem da
-- warehouse operation_line da revisao corrente (0 quando ela nao existe, ou
-- seja, quando a decisao foi "nao usar Galpao"); warehouse_remaining e essa
-- parcela menos o que ja foi efetivamente entregue a essa parcela (capado
-- em warehouse_target, entrega de compra nao "empresta" contra ela).
-- market_replenishment_supply_queue_internal e
-- market_execute_replenishment_store_supply passam a usar SOMENTE
-- warehouse_target/warehouse_remaining -- nunca mais target/remaining --
-- para elegibilidade, quantidade da fila e validacao de execucao. Uma
-- allocation sem warehouse operation_line positiva tem warehouse_target=0 e
-- warehouse_remaining=0, portanto nunca fica elegivel para Abastecer so por
-- existir saldo fisico no Galpao.
--
-- Preservado sem nenhuma alteracao: liberacao progressiva por loja
-- (mesmo filtro de store release por approval_revision), FIFO (mesma
-- ordenacao por born), lock/revalidacao sob transacao, supply_executions,
-- idempotencia por request_id, partial supply (continua exigindo
-- p_quantity = warehouse_remaining exato, igual ao contrato anterior com
-- remaining), Historico (202609150002, que so le target/delivered/remaining
-- e nunca warehouse_target/warehouse_remaining), purchase declarations, NF
-- e recebimento (market_get_replenishment_purchasing e
-- market_reconcile_replenishment_receipts_internal nunca leem
-- physical_needs_internal). market_get_replenishment_store_supply
-- (202609140005) tambem nao precisa ser tocada: ela so projeta as colunas
-- de saida de market_replenishment_supply_queue_internal, que ja chegam
-- corrigidas.

begin;

-- Postgres nao aceita CREATE OR REPLACE para acrescentar colunas de saida a
-- uma RETURNS TABLE existente ("cannot change return type of existing
-- function"/42P13) -- precisa dropar e recriar. A funcao ja era revogada de
-- public/anon/authenticated/service_role (202609140005); a revogacao e
-- reaplicada logo apos o create, senao o novo objeto nasceria com o
-- privilegio padrao (EXECUTE para PUBLIC).
drop function if exists public.market_replenishment_physical_needs_internal(uuid);
create function public.market_replenishment_physical_needs_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,revision integer,born timestamptz,
 target numeric,delivered numeric,remaining numeric,warehouse_line_id uuid,warehouse_target numeric,warehouse_remaining numeric)
language sql stable set search_path=public as $$
 select a.id,o.id,i.product_id,a.store_id,o.approval_revision,
 coalesce(
   (select r.released_at from market_replenishment_order_store_releases r
    where r.order_id=o.id and r.market_account_id=p_account and r.store_id=a.store_id and r.approval_revision=o.approval_revision),
   public.market_replenishment_approval_time_internal(p_account,o.id,o.approval_revision)
 ),
 coalesce(a.adjusted_quantity,a.suggested_quantity),coalesce(e.quantity,0),
 greatest(0,coalesce(a.adjusted_quantity,a.suggested_quantity)-coalesce(e.quantity,0)),w.id,
 coalesce(w.target_quantity,0),
 greatest(0,coalesce(w.target_quantity,0)-least(coalesce(w.target_quantity,0),coalesce(e.quantity,0)))
 from market_replenishment_orders o join market_replenishment_order_items i on i.order_id=o.id and i.market_account_id=o.market_account_id
 join market_replenishment_order_allocations a on a.order_item_id=i.id and a.market_account_id=i.market_account_id
 left join market_replenishment_operation_lines w on w.allocation_id=a.id and w.approval_revision=o.approval_revision and w.operation_type='warehouse'
 left join lateral(select sum(quantity) quantity from market_replenishment_supply_executions where allocation_id=a.id and market_account_id=p_account) e on true
 where o.market_account_id=p_account and o.status in ('approved','in_progress','completed') and i.status<>'cancelled' and a.status<>'cancelled'
 and not exists(select 1 from market_replenishment_candidates c where c.id=a.candidate_id and c.priority_level='low');
$$;
revoke all on function public.market_replenishment_physical_needs_internal(uuid) from public,anon,authenticated,service_role;

-- Elegibilidade e quantidade da fila vem de warehouse_remaining (decisao
-- operacional de Galpao da revisao corrente), nunca da necessidade total.
create or replace function public.market_replenishment_supply_queue_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,warehouse_line_id uuid,
 source_store_id uuid,target numeric,delivered numeric,remaining numeric,balance numeric,ready boolean)
language plpgsql stable set search_path=public as $$
declare n record; w record; v_balances jsonb:='{}'; v_blocked uuid[]:='{}'; v_available numeric; v_ready boolean;
begin
 for n in select q.* from public.market_replenishment_physical_needs_internal(p_account) q where q.warehouse_remaining>0
   and exists (
     select 1 from market_replenishment_order_store_releases r
     where r.order_id=q.order_id and r.market_account_id=p_account and r.store_id=q.store_id and r.approval_revision=q.revision
   )
   order by q.product_id,q.born,q.order_id,q.allocation_id loop
   if n.product_id=any(v_blocked) then continue; end if;
   v_ready:=false;
   for w in select s.id,coalesce(b.quantity_on_hand,0) qty from market_stores s left join market_stock_balance b
     on b.market_store_id=s.id and b.market_account_id=s.market_account_id and b.product_id=n.product_id
     where s.market_account_id=p_account and s.store_type='warehouse' and s.status='active' order by s.id loop
     v_available:=coalesce((v_balances->>(n.product_id::text||':'||w.id::text))::numeric,greatest(0,w.qty));
     if v_available>=n.warehouse_remaining then
       v_balances:=jsonb_set(v_balances,array[n.product_id::text||':'||w.id::text],to_jsonb(v_available-n.warehouse_remaining));
       allocation_id:=n.allocation_id;order_id:=n.order_id;product_id:=n.product_id;store_id:=n.store_id;warehouse_line_id:=n.warehouse_line_id;
       source_store_id:=w.id;target:=n.warehouse_target;delivered:=least(n.warehouse_target,n.delivered);remaining:=n.warehouse_remaining;balance:=w.qty;ready:=true;
       v_ready:=true; return next; exit;
     end if;
   end loop;
   if not v_ready then v_blocked:=array_append(v_blocked,n.product_id); end if;
 end loop;
end;
$$;

-- As duas leituras de physical_needs_internal (busca da allocation e
-- recheck FIFO) passam a validar contra warehouse_remaining (decisao
-- operacional de Galpao) em vez de remaining (necessidade total): sem isso,
-- esta RPC aceitaria abastecer, usando saldo fisico do Galpao, uma
-- allocation cuja parcela toda foi decidida como Comprar (Do Galpao=0),
-- mesmo sem nenhuma compra feita. Nenhuma outra checagem desta funcao
-- (liberacao da loja, FIFO, lock, saldo fisico via market_stock_movements,
-- idempotencia por request_id, transicao de status, conclusao da ordem) foi
-- alterada.
create or replace function public.market_execute_replenishment_store_supply(
 p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,p_warehouse_operation_line_id uuid,p_source_store_id uuid,p_quantity numeric,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare e market_replenishment_supply_executions;o market_replenishment_orders; n record; w market_replenishment_operation_lines; v_balance numeric;v_delta numeric:=0;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 if p_request_id is null then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_REQUIRED'; end if;
 if p_quantity is null or p_quantity<=0 or p_quantity<>trunc(p_quantity) or p_quantity::text in ('NaN','Infinity','-Infinity') then raise exception 'REPLENISHMENT_SUPPLY_INVALID_QUANTITY'; end if;
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));
 select * into e from market_replenishment_supply_executions where market_account_id=p_market_account_id and request_id=p_request_id;
 if found then
  if (e.replenishment_order_id,e.allocation_id,e.warehouse_operation_line_id,e.source_store_id,e.quantity,e.created_by)
    is distinct from (p_order_id,p_allocation_id,p_warehouse_operation_line_id,p_source_store_id,p_quantity,auth.uid()) then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_CONFLICT'; end if;
  return market_replenishment_supply_result(e.id,p_market_account_id);
 end if;
 select * into o from market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
 if not found or o.status not in ('approved','in_progress','completed') then raise exception 'REPLENISHMENT_SUPPLY_ORDER_INVALID'; end if;
 select * into n from market_replenishment_physical_needs_internal(p_market_account_id) q
   where q.allocation_id=p_allocation_id and q.order_id=p_order_id
     and exists (select 1 from market_replenishment_order_store_releases r where r.order_id=q.order_id and r.market_account_id=p_market_account_id and r.store_id=q.store_id and r.approval_revision=q.revision);
 if not found or not market_can_access_store(n.store_id) then raise exception 'REPLENISHMENT_SUPPLY_DESTINATION_INVALID'; end if;
 if p_warehouse_operation_line_id is distinct from n.warehouse_line_id then raise exception 'REPLENISHMENT_SUPPLY_OPERATION_INVALID'; end if;
 if not exists(select 1 from market_stores where id=p_source_store_id and market_account_id=p_market_account_id and status='active' and store_type='warehouse' and market_can_access_store(id)) then raise exception 'REPLENISHMENT_SUPPLY_SOURCE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-supply:'||p_market_account_id::text||':'||p_source_store_id::text||':'||n.product_id::text,0));
 perform 1 from market_stores where id=p_source_store_id for update;
 if n.allocation_id is distinct from (
   select q.allocation_id from market_replenishment_physical_needs_internal(p_market_account_id) q
   where q.product_id=n.product_id and q.warehouse_remaining>0
     and exists (select 1 from market_replenishment_order_store_releases r where r.order_id=q.order_id and r.market_account_id=p_market_account_id and r.store_id=q.store_id and r.approval_revision=q.revision)
   order by q.born,q.order_id,q.allocation_id limit 1
 ) then raise exception 'REPLENISHMENT_SUPPLY_FIFO_BLOCKED'; end if;
 if p_quantity<>n.warehouse_remaining then raise exception 'REPLENISHMENT_SUPPLY_FULL_NEED_REQUIRED'; end if;
 select coalesce(sum(case when direction='IN' then quantity else -quantity end),0) into v_balance from market_stock_movements
   where market_account_id=p_market_account_id and market_store_id=p_source_store_id and product_id=n.product_id;
 if v_balance<p_quantity then raise exception 'REPLENISHMENT_SUPPLY_INSUFFICIENT_STOCK: saldo atual %',greatest(0,v_balance); end if;
 if o.status='approved' then
   update market_replenishment_orders set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now() where id=o.id;
 end if;
 insert into market_replenishment_supply_executions(market_account_id,replenishment_order_id,allocation_id,warehouse_operation_line_id,source_store_id,destination_store_id,product_id,quantity,request_id,created_by)
 values(p_market_account_id,o.id,n.allocation_id,n.warehouse_line_id,p_source_store_id,n.store_id,n.product_id,p_quantity,p_request_id,auth.uid()) returning * into e;
 insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id)
 values(p_market_account_id,p_source_store_id,n.product_id,'TRANSFER_OUT','OUT',p_quantity,'REPLENISHMENT_SUPPLY',e.id,e.id),
 (p_market_account_id,n.store_id,n.product_id,'TRANSFER_IN','IN',p_quantity,'REPLENISHMENT_SUPPLY',e.id,e.id);
 if n.warehouse_line_id is not null then
  select * into w from market_replenishment_operation_lines where id=n.warehouse_line_id for update;
  v_delta:=least(w.target_quantity,n.delivered+p_quantity)-w.confirmed_quantity;
  if v_delta>0 then
    update market_replenishment_operation_lines set confirmed_quantity=confirmed_quantity+v_delta,started_at=coalesce(started_at,now()),started_by=coalesce(started_by,auth.uid()),
      completed_at=case when confirmed_quantity+v_delta=target_quantity then now() else null end,completed_by=case when confirmed_quantity+v_delta=target_quantity then auth.uid() else null end where id=w.id;
  end if;
 end if;
 insert into market_replenishment_order_events(market_account_id,order_id,event_type,approval_revision,operation_line_id,request_id,quantity_delta,metadata,actor_kind)
 values(p_market_account_id,o.id,case when v_delta>0 then 'WAREHOUSE_QUANTITY_CONFIRMED' else 'SUPPLY_EXECUTED' end,o.approval_revision,n.warehouse_line_id,p_request_id,case when v_delta>0 then v_delta else p_quantity end,jsonb_build_object('executionId',e.id),'service');
 perform market_complete_replenishment_order_internal(p_market_account_id,o.id,p_request_id);
 return market_replenishment_supply_result(e.id,p_market_account_id);
end;
$$;

commit;
