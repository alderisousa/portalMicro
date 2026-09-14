-- GiroMicro Market: backfill de coerencia comercial para declaracoes de compra
-- da Reposicao registradas antes da 202609140004 (integrate_replenishment_
-- purchase_progress). Ate essa integracao, salvar a quantidade comprada
-- (market_replenishment_purchase_declarations.purchased_quantity) nao refletia
-- em market_replenishment_operation_lines.confirmed_quantity das linhas de
-- compra; a partir da 004/005 os dois avancam juntos. Este backfill apenas
-- alinha o progresso comercial legado ao que ja havia sido declarado.
--
-- Aplicacao manual. 003/004/005 permanecem imutaveis e nao sao alteradas aqui.
--
-- Nao cria PURCHASE/IN, stock movement, purchase_nf_link, receipt_allocation
-- ou supply execution. Nao altera purchased_quantity, purchase_version, saldo,
-- batch, sugestao ou UI. Nao reabre ordem e nao muda status manualmente: o
-- unico efeito sobre market_replenishment_orders vem do helper oficial
-- market_complete_replenishment_order_internal, chamado apenas quando o
-- proprio helper decide que a ordem ja esta comercial e fisicamente coerente
-- para conclusao (ele mesmo confere e nao faz nada caso contrario).
--
-- Escopo deliberadamente restrito a ordens 'in_progress': e o unico status em
-- que market_replenishment_guard_line_internal aceita elevar confirmed_quantity
-- nas operation_lines, e e o status esperado para uma declaracao com
-- purchased_quantity preenchido por esse fluxo legado. Uma inconsistencia
-- equivalente encontrada fora de 'in_progress' fica deliberadamente fora deste
-- backfill (risco residual documentado no resumo da tarefa), em vez de
-- contornar o guard ou alterar status manualmente.
--
-- Escopo tambem restrito a declaracoes com soma(confirmed_quantity)=0 nas suas
-- purchase operation_lines. Redistribuir por FIFO quando ja existe progresso
-- parcial (por exemplo confirmed=[0,2] com targets=[2,2] e purchased=2) exige
-- decidir o que fazer com um excedente ja confirmado acima do proprio total
-- comprado -- uma correcao mais delicada, fora dos dois casos legados reais
-- identificados (Cafe e Guarana, ambos com soma atual zero). Uma declaracao
-- com qualquer confirmed_quantity>0 fica deliberadamente intocada por esta
-- migration (risco residual documentado no resumo da tarefa).
--
-- Idempotente: na segunda execucao nao ha mais declaracao elegivel com soma
-- zero (as tratadas na primeira passagem ja tem confirmed_quantity>0), entao
-- a UPDATE nao afeta nenhuma linha.
begin;

do $$
declare
  v_order record;
begin
  for v_order in
    with eligible_declarations as (
      select d.id declaration_id, d.market_account_id, d.order_id, d.approval_revision,
        d.product_id, d.purchased_quantity
      from public.market_replenishment_purchase_declarations d
      join public.market_replenishment_orders o
        on o.id = d.order_id and o.market_account_id = d.market_account_id
      where d.purchased_quantity is not null
        and d.purchased_quantity > 0
        and o.status = 'in_progress'
        and o.approval_revision = d.approval_revision
        and exists (
          select 1
          from public.market_replenishment_operation_lines l
          join public.market_replenishment_order_allocations a
            on a.id = l.allocation_id and a.market_account_id = l.market_account_id
          join public.market_replenishment_order_items i
            on i.id = a.order_item_id and i.market_account_id = a.market_account_id
          where l.market_account_id = d.market_account_id
            and l.order_id = d.order_id
            and l.approval_revision = d.approval_revision
            and l.operation_type = 'purchase'
            and i.product_id = d.product_id
        )
        and not exists (
          select 1
          from public.market_replenishment_operation_lines l
          join public.market_replenishment_order_allocations a
            on a.id = l.allocation_id and a.market_account_id = l.market_account_id
          join public.market_replenishment_order_items i
            on i.id = a.order_item_id and i.market_account_id = a.market_account_id
          where l.market_account_id = d.market_account_id
            and l.order_id = d.order_id
            and l.approval_revision = d.approval_revision
            and l.operation_type = 'purchase'
            and i.product_id = d.product_id
            and l.confirmed_quantity > 0
        )
    ),
    purchase_lines as (
      select
        l.id line_id, l.market_account_id, l.order_id, l.approval_revision,
        l.target_quantity, l.confirmed_quantity,
        ed.declaration_id, ed.purchased_quantity,
        sum(l.target_quantity) over (
          partition by ed.declaration_id
          order by public.market_replenishment_approval_time_internal(l.market_account_id, l.order_id, l.approval_revision),
            l.order_id, l.allocation_id
          rows between unbounded preceding and current row
        ) cumulative_target
      from public.market_replenishment_operation_lines l
      join public.market_replenishment_order_allocations a
        on a.id = l.allocation_id and a.market_account_id = l.market_account_id
      join public.market_replenishment_order_items i
        on i.id = a.order_item_id and i.market_account_id = a.market_account_id
      join eligible_declarations ed
        on ed.market_account_id = l.market_account_id
       and ed.order_id = l.order_id
       and ed.approval_revision = l.approval_revision
       and ed.product_id = i.product_id
      where l.operation_type = 'purchase'
    ),
    targets as (
      select line_id, market_account_id, order_id, target_quantity, confirmed_quantity,
        -- Todas as linhas elegiveis partem de confirmed_quantity=0 (garantido
        -- pelo filtro acima); soma preenchida ate purchased_quantity, na ordem
        -- born/order_id/allocation_id, sem ultrapassar o alvo de cada linha.
        least(target_quantity, greatest(0, purchased_quantity - (cumulative_target - target_quantity))) new_confirmed_quantity
      from purchase_lines
    ),
    updated as (
      update public.market_replenishment_operation_lines l
      set confirmed_quantity = t.new_confirmed_quantity,
          started_at = coalesce(l.started_at, now()),
          completed_at = case when t.new_confirmed_quantity = t.target_quantity then coalesce(l.completed_at, now()) else l.completed_at end,
          updated_at = now()
      from targets t
      where l.id = t.line_id
        and t.new_confirmed_quantity <> t.confirmed_quantity
      returning l.market_account_id, l.order_id
    )
    select distinct market_account_id, order_id from updated
  loop
    -- So conclui pelo contrato oficial; sem no-op esse helper nem toca status
    -- nem emite ORDER_COMPLETED (confere de novo confirmed_quantity=target em
    -- todas as linhas, warehouse inclusive, antes de qualquer efeito).
    perform public.market_complete_replenishment_order_internal(v_order.market_account_id, v_order.order_id, gen_random_uuid());
  end loop;
end;
$$;

commit;
