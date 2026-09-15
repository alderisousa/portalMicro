-- Reposicao Inteligente / Historico
--
-- Lacuna identificada: nao existe RPC para (a) listar as listas/ordens de
-- reposicao de uma conta com resumo de pendencia fisica, nem (b) obter,
-- para uma ordem especifica, quais necessidades (produto x loja) ja foram
-- efetivamente entregues Galpao->Loja. O unico calculo correto disso
-- (market_replenishment_physical_needs_internal) ja existe e ja e usado
-- pelo fluxo de abastecimento/supply, mas e uma funcao interna, revogada
-- de authenticated (202609120003), inacessivel ao cliente.
--
-- Por que nao dava para reconstruir isso so com RPCs/leituras existentes:
-- - market_get_replenishment_order(accountId, orderId) tem os itens/
--   allocations de UMA ordem, mas so campos comerciais (suggested/adjusted/
--   warehouseAllocated/purchaseNeeded) -- nenhuma quantidade efetivamente
--   entregue a loja.
-- - market_get_replenishment_purchasing(accountId, orderId) tem
--   deliveredQuantity/remainingPhysical por loja, mas SOMENTE para
--   allocations com operation_type='purchase' (purchase_needed_quantity>0).
--   Uma allocation 100% coberta por saldo de Galpao (warehouse_allocated_
--   quantity>0 e purchase_needed_quantity=0) nunca aparece nela.
-- - market_replenishment_operation_lines (linha 'warehouse') e legivel
--   direto e mede recebimento pela loja, mas so cobre a parcela do Galpao;
--   numa allocation mista (parte Galpao + parte compra) ela nao reflete a
--   entrega da parcela comprada.
-- - market_replenishment_supply_executions (evidencia real de entrega) e
--   revogada de authenticated -- sem RPC, nenhuma leitura client-side
--   cobre TODA allocation de forma uniforme.
-- - Nao existe nenhuma RPC/leitura para listar as ORDENS de uma conta com
--   contagem de pendencia -- necessario para a tela "relacao de listas".
--
-- Confirmado tambem que market_replenishment_orders.status='completed' NAO
-- garante entrega fisica: market_complete_replenishment_order_internal so
-- exige que os operation_lines (compra e Galpao) cheguem a
-- confirmed_quantity=target_quantity; para 'purchase', confirmed_quantity
-- mede COMPRADO, nunca entregue a loja. Uma ordem pode virar 'completed'
-- com necessidade fisica ainda pendente -- exatamente o que a regra
-- funcional pede para nao tratar como concluido.
--
-- Esta migration expoe uma unica RPC de leitura que reusa
-- market_replenishment_physical_needs_internal (sem alterar seu calculo)
-- para: (a) sem p_order_id, resumir cada ordem (itens totais/processados/
-- pendentes) para a tela de historico; (b) com p_order_id, detalhar as
-- necessidades (produto x loja) dessa ordem com status pending/processed.
-- p_store_id opcional preserva o mesmo escopo por loja ja usado pelo
-- Historico atual (getReplenishmentDeliveryHistory/getReplenishmentStoreSupply).
--
-- Nao altera batch, prioridades, 202609150001, nem os fluxos homologados de
-- compras/NF/abastecimento -- apenas leitura nova sobre dados existentes.

begin;

create or replace function public.market_get_replenishment_order_history(
    p_market_account_id uuid,
    p_order_id uuid default null,
    p_store_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
    if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
    perform public.market_replenishment_assert_access_internal(p_market_account_id);

    if p_order_id is null then
        with needs as (
            select *
            from public.market_replenishment_physical_needs_internal(p_market_account_id) p
            where p.target > 0
              and public.market_can_access_store(p.store_id)
              and (p_store_id is null or p.store_id = p_store_id)
        ),
        per_order as (
            select order_id, count(*) total, count(*) filter (where remaining <= 0) processed
            from needs
            group by order_id
        )
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', o.id,
            'status', o.status,
            'createdAt', o.created_at,
            'approvedAt', o.approved_at,
            'completedAt', o.completed_at,
            'totalItems', n.total,
            'processedItems', n.processed,
            'pendingItems', n.total - n.processed,
            'situation', case when n.total - n.processed = 0 then 'completed' else 'partial' end
        ) order by (n.total - n.processed) = 0, coalesce(o.approved_at, o.created_at) desc, o.id), '[]'::jsonb)
        into result
        from public.market_replenishment_orders o
        join per_order n on n.order_id = o.id
        where o.market_account_id = p_market_account_id
          and o.status in ('approved', 'in_progress', 'completed');
        return result;
    end if;

    with needs as (
        select *
        from public.market_replenishment_physical_needs_internal(p_market_account_id) p
        where p.order_id = p_order_id
          and p.target > 0
          and public.market_can_access_store(p.store_id)
          and (p_store_id is null or p.store_id = p_store_id)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
        'allocationId', n.allocation_id,
        'productId', n.product_id,
        'productName', pr.name,
        'storeId', n.store_id,
        'storeName', s.name,
        'targetQuantity', n.target,
        'deliveredQuantity', n.delivered,
        'remainingQuantity', n.remaining,
        'status', case when n.remaining <= 0 then 'processed' else 'pending' end
    ) order by pr.name, s.name, n.allocation_id), '[]'::jsonb)
    into result
    from needs n
    join public.market_products pr on pr.id = n.product_id and pr.market_account_id = p_market_account_id
    join public.market_stores s on s.id = n.store_id and s.market_account_id = p_market_account_id;
    return result;
end;
$$;

comment on function public.market_get_replenishment_order_history(uuid, uuid, uuid) is
'Historico de Reposicao: sem p_order_id resume ordens (approved/in_progress/completed) com pendencia fisica real (market_replenishment_physical_needs_internal); com p_order_id detalha as necessidades produto x loja dessa ordem com status pending/processed. p_store_id opcional escopa por loja.';

revoke all on function public.market_get_replenishment_order_history(uuid, uuid, uuid) from public, anon;
grant execute on function public.market_get_replenishment_order_history(uuid, uuid, uuid) to authenticated;

commit;
