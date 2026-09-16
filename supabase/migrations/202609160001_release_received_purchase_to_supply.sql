-- Reposicao Inteligente / libera para Abastecer a parcela comprada somente apos recebimento fisico no Galpao.
--
-- 202609150004/0005 permanecem imutaveis.
-- Regra:
--   1) a revisao continua separando Do Galpao x Comprar;
--   2) antes da entrada da NF, a parcela Comprar NAO pode aparecer em Abastecer;
--   3) depois do recebimento real (PURCHASE/IN) e da reconciliacao da NF com a allocation,
--      a quantidade recebida passa a compor a quantidade liberada para Abastecer;
--   4) somente market_execute_replenishment_store_supply movimenta Galpao -> Loja;
--   5) Historico continua considerando Processado somente pela entrega fisica.
--
-- Nao altera Compras/NF, reconciliacao, Historico, frontend nem migrations anteriores.

begin;

-- A fila passa a considerar como "liberado para abastecer":
--   parcela originalmente destinada ao Galpao
--   + parcela de compra efetivamente recebida e atribuida a esta allocation.
-- O total e limitado a necessidade fisica da allocation e desconta tudo que ja foi entregue.
create or replace function public.market_replenishment_supply_queue_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,warehouse_line_id uuid,
 source_store_id uuid,target numeric,delivered numeric,remaining numeric,balance numeric,ready boolean)
language plpgsql stable set search_path=public as $$
declare
 n record;
 w record;
 v_balances jsonb:='{}';
 v_blocked uuid[]:='{}';
 v_available numeric;
 v_ready boolean;
begin
 for n in
   select q.*,
          coalesce((
            select sum(ra.quantity)
            from market_replenishment_receipt_allocations ra
            where ra.market_account_id=p_account
              and ra.order_id=q.order_id
              and ra.allocation_id=q.allocation_id
          ),0) received_purchase,
          least(
            q.target,
            q.warehouse_target + coalesce((
              select sum(ra.quantity)
              from market_replenishment_receipt_allocations ra
              where ra.market_account_id=p_account
                and ra.order_id=q.order_id
                and ra.allocation_id=q.allocation_id
            ),0)
          ) supply_target
   from public.market_replenishment_physical_needs_internal(p_account) q
   where exists (
     select 1
     from market_replenishment_order_store_releases r
     where r.order_id=q.order_id
       and r.market_account_id=p_account
       and r.store_id=q.store_id
       and r.approval_revision=q.revision
   )
   order by q.product_id,q.born,q.order_id,q.allocation_id
 loop
   -- Nada foi destinado originalmente ao Galpao e nenhuma compra foi recebida:
   -- continua fora de Abastecer, preservando a decisao da revisao.
   if greatest(0,n.supply_target-n.delivered)<=0 then
     continue;
   end if;

   if n.product_id=any(v_blocked) then continue; end if;
   v_ready:=false;

   for w in
     select s.id,coalesce(b.quantity_on_hand,0) qty
     from market_stores s
     left join market_stock_balance b
       on b.market_store_id=s.id
      and b.market_account_id=s.market_account_id
      and b.product_id=n.product_id
     where s.market_account_id=p_account
       and s.store_type='warehouse'
       and s.status='active'
     order by s.id
   loop
     v_available:=coalesce(
       (v_balances->>(n.product_id::text||':'||w.id::text))::numeric,
       greatest(0,w.qty)
     );

     if v_available>=greatest(0,n.supply_target-n.delivered) then
       v_balances:=jsonb_set(
         v_balances,
         array[n.product_id::text||':'||w.id::text],
         to_jsonb(v_available-greatest(0,n.supply_target-n.delivered))
       );

       allocation_id:=n.allocation_id;
       order_id:=n.order_id;
       product_id:=n.product_id;
       store_id:=n.store_id;
       warehouse_line_id:=n.warehouse_line_id;
       source_store_id:=w.id;
       target:=n.supply_target;
       delivered:=least(n.supply_target,n.delivered);
       remaining:=greatest(0,n.supply_target-n.delivered);
       balance:=w.qty;
       ready:=true;
       v_ready:=true;
       return next;
       exit;
     end if;
   end loop;

   -- Preserva a protecao FIFO/projecao por produto: se a necessidade mais antiga
   -- liberada nao cabe no saldo, as posteriores do mesmo produto nao furam a fila.
   if not v_ready then v_blocked:=array_append(v_blocked,n.product_id); end if;
 end loop;
end;
$$;

-- Mantem a correcao FIFO de 202609150005: a execucao revalida contra a propria
-- fila sob lock. A quantidade exigida agora e o remaining EFETIVAMENTE liberado
-- pela fila (Galpao original + compra recebida), e nao apenas warehouse_remaining.
create or replace function public.market_execute_replenishment_store_supply(
 p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,p_warehouse_operation_line_id uuid,p_source_store_id uuid,p_quantity numeric,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 e market_replenishment_supply_executions;
 o market_replenishment_orders;
 n record;
 q_ready record;
 w market_replenishment_operation_lines;
 v_balance numeric;
 v_delta numeric:=0;
begin
 if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
 perform market_replenishment_assert_access_internal(p_market_account_id);
 if p_request_id is null then raise exception 'REPLENISHMENT_SUPPLY_REQUEST_REQUIRED'; end if;
 if p_quantity is null or p_quantity<=0 or p_quantity<>trunc(p_quantity) or p_quantity::text in ('NaN','Infinity','-Infinity') then
   raise exception 'REPLENISHMENT_SUPPLY_INVALID_QUANTITY';
 end if;

 perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:'||p_market_account_id::text,0));

 select * into e
 from market_replenishment_supply_executions
 where market_account_id=p_market_account_id and request_id=p_request_id;
 if found then
  if (e.replenishment_order_id,e.allocation_id,e.warehouse_operation_line_id,e.source_store_id,e.quantity,e.created_by)
    is distinct from (p_order_id,p_allocation_id,p_warehouse_operation_line_id,p_source_store_id,p_quantity,auth.uid()) then
    raise exception 'REPLENISHMENT_SUPPLY_REQUEST_CONFLICT';
  end if;
  return market_replenishment_supply_result(e.id,p_market_account_id);
 end if;

 select * into o
 from market_replenishment_orders
 where id=p_order_id and market_account_id=p_market_account_id
 for update;
 if not found or o.status not in ('approved','in_progress','completed') then
   raise exception 'REPLENISHMENT_SUPPLY_ORDER_INVALID';
 end if;

 select * into n
 from market_replenishment_physical_needs_internal(p_market_account_id) x
 where x.allocation_id=p_allocation_id and x.order_id=p_order_id
   and exists (
     select 1 from market_replenishment_order_store_releases r
     where r.order_id=x.order_id
       and r.market_account_id=p_market_account_id
       and r.store_id=x.store_id
       and r.approval_revision=x.revision
   );
 if not found or not market_can_access_store(n.store_id) then
   raise exception 'REPLENISHMENT_SUPPLY_DESTINATION_INVALID';
 end if;

 -- Para allocation 100% compra, warehouse_line_id e legitimamente NULL.
 if p_warehouse_operation_line_id is distinct from n.warehouse_line_id then
   raise exception 'REPLENISHMENT_SUPPLY_OPERATION_INVALID';
 end if;

 if not exists(
   select 1 from market_stores
   where id=p_source_store_id
     and market_account_id=p_market_account_id
     and status='active'
     and store_type='warehouse'
     and market_can_access_store(id)
 ) then raise exception 'REPLENISHMENT_SUPPLY_SOURCE_INVALID'; end if;

 perform pg_advisory_xact_lock(hashtextextended(
   'market-replenishment-supply:'||p_market_account_id::text||':'||p_source_store_id::text||':'||n.product_id::text,0
 ));
 perform 1 from market_stores where id=p_source_store_id for update;

 -- Preserva 202609150005: a fila e a fonte unica da elegibilidade/FIFO.
 select * into q_ready
 from market_replenishment_supply_queue_internal(p_market_account_id) q
 where q.allocation_id=n.allocation_id
   and q.source_store_id=p_source_store_id;
 if not found then raise exception 'REPLENISHMENT_SUPPLY_FIFO_BLOCKED'; end if;

 if p_quantity<>q_ready.remaining then
   raise exception 'REPLENISHMENT_SUPPLY_FULL_NEED_REQUIRED';
 end if;

 select coalesce(sum(case when direction='IN' then quantity else -quantity end),0)
 into v_balance
 from market_stock_movements
 where market_account_id=p_market_account_id
   and market_store_id=p_source_store_id
   and product_id=n.product_id;
 if v_balance<p_quantity then
   raise exception 'REPLENISHMENT_SUPPLY_INSUFFICIENT_STOCK: saldo atual %',greatest(0,v_balance);
 end if;

 if o.status='approved' then
   update market_replenishment_orders
   set status='in_progress',started_at=now(),started_by=auth.uid(),updated_at=now()
   where id=o.id;
 end if;

 insert into market_replenishment_supply_executions(
   market_account_id,replenishment_order_id,allocation_id,warehouse_operation_line_id,
   source_store_id,destination_store_id,product_id,quantity,request_id,created_by
 ) values(
   p_market_account_id,o.id,n.allocation_id,n.warehouse_line_id,
   p_source_store_id,n.store_id,n.product_id,p_quantity,p_request_id,auth.uid()
 ) returning * into e;

 insert into market_stock_movements(
   market_account_id,market_store_id,product_id,movement_type,direction,quantity,
   reference_type,reference_id,reference_item_id
 ) values
 (p_market_account_id,p_source_store_id,n.product_id,'TRANSFER_OUT','OUT',p_quantity,'REPLENISHMENT_SUPPLY',e.id,e.id),
 (p_market_account_id,n.store_id,n.product_id,'TRANSFER_IN','IN',p_quantity,'REPLENISHMENT_SUPPLY',e.id,e.id);

 -- Se havia parcela originalmente destinada ao Galpao, mantem seu progresso
 -- operacional. Em allocation 100% compra, n.warehouse_line_id e NULL e este
 -- bloco nao roda; a entrega fisica continua registrada por supply_executions.
 if n.warehouse_line_id is not null then
  select * into w from market_replenishment_operation_lines where id=n.warehouse_line_id for update;
  v_delta:=least(w.target_quantity,n.delivered+p_quantity)-w.confirmed_quantity;
  if v_delta>0 then
    update market_replenishment_operation_lines
    set confirmed_quantity=confirmed_quantity+v_delta,
        started_at=coalesce(started_at,now()),
        started_by=coalesce(started_by,auth.uid()),
        completed_at=case when confirmed_quantity+v_delta=target_quantity then now() else null end,
        completed_by=case when confirmed_quantity+v_delta=target_quantity then auth.uid() else null end
    where id=w.id;
  end if;
 end if;

 insert into market_replenishment_order_events(
   market_account_id,order_id,event_type,approval_revision,operation_line_id,
   request_id,quantity_delta,metadata,actor_kind
 ) values(
   p_market_account_id,o.id,
   case when v_delta>0 then 'WAREHOUSE_QUANTITY_CONFIRMED' else 'SUPPLY_EXECUTED' end,
   o.approval_revision,n.warehouse_line_id,p_request_id,
   case when v_delta>0 then v_delta else p_quantity end,
   jsonb_build_object('executionId',e.id,'releasedByReceipt',q_ready.target>n.warehouse_target),
   'service'
 );

 perform market_complete_replenishment_order_internal(p_market_account_id,o.id,p_request_id);
 return market_replenishment_supply_result(e.id,p_market_account_id);
end;
$$;

commit;
