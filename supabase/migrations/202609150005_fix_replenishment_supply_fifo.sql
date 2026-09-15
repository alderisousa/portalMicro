-- Reposicao Inteligente / Corrige o bloqueio indevido de FIFO na execucao
-- do Abastecer (202609150003 e 202609150004 ja foram aplicadas em
-- homologacao e sao imutaveis -- esta migration so redefine, por cima
-- delas, exatamente o necessario para esta correcao pontual).
--
-- Bug confirmado no smoke: ao tentar abastecer Manhattan (LACTA BIS
-- CHOCOLATE BRANCO), a RPC retornava REPLENISHMENT_SUPPLY_FIFO_BLOCKED
-- mesmo sem falta de estoque -- Galpao fisico=10, Sal da Terra (allocation
-- mais antiga do mesmo produto) warehouse_remaining=1, Manhattan
-- warehouse_remaining=1, total necessario=2. Na mesma leitura,
-- market_replenishment_supply_queue_internal ja apresentava as DUAS
-- allocations como abasteciveis (ready=true).
--
-- Causa raiz: market_execute_replenishment_store_supply (202609150004)
-- exigia que a allocation sendo executada fosse LITERALMENTE a unica mais
-- antiga (order by born,... limit 1) entre as allocations do produto com
-- warehouse_remaining>0 -- uma regra mais restritiva do que a propria fila
-- (market_replenishment_supply_queue_internal), que ja calcula
-- corretamente quais allocations cabem no saldo disponivel via simulacao
-- incremental (processa em ordem de born, decrementando um saldo simulado
-- a cada uma marcada pronta, nunca deixando esse saldo ficar negativo).
-- Resultado pratico: a fila dizia "pode abastecer", a execucao dizia "nao
-- pode" para a MESMA allocation, na MESMA leitura de dados.
--
-- Regra funcional pedida: nao obrigar o operador a abastecer fisicamente
-- as lojas na ordem de liberacao quando ha saldo suficiente para atender
-- os compromissos ja considerados pela projecao. A protecao necessaria e
-- so impedir consumo acima do saldo disponivel/comprometido -- nao exigir
-- que a allocation mais antiga seja executada primeiro.
--
-- Correcao (menor mudanca segura, sem tocar 0003/0004): a checagem de FIFO
-- deixa de reimplementar sua propria regra "tem que ser a mais antiga" e
-- passa a perguntar diretamente para market_replenishment_supply_queue_internal
-- (ja STABLE, reconsultada sob o mesmo lock por produto+galpao+conta logo
-- acima) se a allocation e o galpao de origem informados fazem parte do
-- conjunto ATUALMENTE pronto para abastecer. Como essa funcao processa as
-- necessidades do produto em ordem de born decrementando um saldo simulado
-- a cada uma marcada pronta, ela ja garante -- em qualquer ordem real de
-- execucao -- que a soma das allocations prontas nunca excede o saldo do
-- galpao de origem, e que uma necessidade mais antiga so fica sem saldo se
-- o saldo real (sempre recalculado na chamada, ja refletindo entregas
-- anteriores) de fato nao alcancar para todas. Isso permite executar
-- Manhattan antes de Sal da Terra quando ha saldo para ambas, sem abrir mao
-- da protecao: se so houvesse saldo para uma, a fila (e portanto esta
-- checagem) so marcaria a mais antiga como pronta, preservando o
-- compromisso dela. Nenhuma outra checagem desta funcao foi alterada
-- (permissao, liberacao da loja, warehouse_operation_line correta,
-- p_quantity=warehouse_remaining exato, idempotencia por request_id,
-- transicao de status, conclusao da ordem) -- o proprio "if
-- v_balance<p_quantity" logo abaixo, sob o mesmo lock, continua sendo a
-- barreira final e atomica contra estoque negativo.
--
-- Preservado sem alteracao: market_replenishment_physical_needs_internal e
-- market_replenishment_supply_queue_internal (202609150004, intactas),
-- Historico, Comprar, Aguardando entrada, liberacao progressiva por loja,
-- frontend.

begin;

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
 -- Revalida sob o lock, contra a fila atual (ja balanceada por saldo, sem
 -- exigir que seja a allocation mais antiga): a allocation e o galpao de
 -- origem informados precisam constar como prontos AGORA.
 if not exists (
   select 1 from market_replenishment_supply_queue_internal(p_market_account_id) q
   where q.allocation_id=n.allocation_id and q.source_store_id=p_source_store_id
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
