-- Aplicação MANUAL. Fechamento da Sprint de Estoque: histórico de
-- inventários ("Últimos inventários" na tela inicial de Estoque). NÃO
-- altera nenhuma migration/RPC existente — market_get_inventory_draft,
-- market_save_inventory_draft/item, market_remove_inventory_item e
-- market_finalize_/cancel_inventory_draft continuam exatamente como estão.
--
-- Problema resolvido: market_inventory_sessions/market_inventory_session_items
-- nunca são apagadas por finalize/cancel (só o status muda para 'completed'/
-- 'cancelled' — ver 202609010002/202609010004) — os dados de inventários já
-- concluídos/cancelados continuam persistidos indefinidamente. Mas as duas
-- tabelas têm RLS habilitado SEM nenhuma policy e com "revoke all" explícito
-- (202609010002): acesso é exclusivamente por RPC security definer, e
-- nenhuma RPC existente lê sessão fora de status='draft'. Sem uma RPC nova,
-- não há como listar nem consultar inventários já concluídos — não é
-- possível reconstruir esse histórico a partir do saldo atual nem de
-- market_stock_movements (que só registra os itens que geraram ajuste,
-- nunca os sem diferença).
--
-- Solução: duas RPCs NOVAS, somente leitura (stable) — mesmo padrão de
-- autenticação/associação/acesso à loja já usado por market_get_stock_balance/
-- market_get_inventory_draft. Não bloqueiam role='viewer' (leitura, não
-- escrita), igual a market_get_inventory_draft.
--   1) market_list_inventory_sessions: sessões CONCLUÍDAS/CANCELADAS de uma
--      loja, mais recente primeiro (updated_at desc — já existe índice
--      ix_market_inventory_sessions_account_store_updated para isso), com a
--      contagem de produtos contados. O draft ativo nunca aparece aqui — já
--      é exibido pelo card "Inventário em andamento" (regra preservada).
--   2) market_get_inventory_session: uma sessão específica com seus itens,
--      já com nome/EAN/SKU/unidade do produto denormalizados (mesmo padrão
--      de market_get_stock_balance) — o histórico não pode depender do
--      catálogo ATUAL de produtos ativos, um produto pode ter sido
--      desativado depois do inventário. product_id referencia
--      market_products sem "on delete cascade"/"set null" (só
--      status='inactive'), então o join nunca perde uma linha de item.
begin;

create or replace function public.market_list_inventory_sessions(
    p_market_account_id uuid,
    p_market_store_id uuid,
    p_limit integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    select m.* into v_member
    from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;

    if not exists (
        select 1 from public.market_stores s
        where s.id = p_market_store_id and s.market_account_id = p_market_account_id
          and (v_member.all_stores or v_member.role in ('owner','admin') or exists (
              select 1 from public.market_member_stores ms
              where ms.market_account_member_id = v_member.id and ms.market_store_id = s.id
          ))
    ) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: loja inexistente ou sem acesso.'; end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', s.id, 'inventoryType', s.inventory_type, 'status', s.status,
            'startedAt', s.started_at, 'createdAt', s.created_at, 'updatedAt', s.updated_at,
            'completedAt', s.completed_at, 'cancelledAt', s.cancelled_at,
            'countedProducts', (
                select count(*) from public.market_inventory_session_items i
                where i.inventory_session_id = s.id and i.is_counted
            )
        ) order by s.updated_at desc)
        from (
            select * from public.market_inventory_sessions
            where market_account_id = p_market_account_id and market_store_id = p_market_store_id
              and status in ('completed','cancelled')
            order by updated_at desc
            limit greatest(1, least(coalesce(p_limit, 30), 100))
        ) s
    ), '[]'::jsonb);
end;
$$;

create or replace function public.market_get_inventory_session(
    p_inventory_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_session public.market_inventory_sessions;
    v_member public.market_account_members;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    select * into v_session from public.market_inventory_sessions where id = p_inventory_session_id;
    if not found then raise exception 'INVENTORY_SESSION_NOT_FOUND: inventario nao encontrado.'; end if;

    select m.* into v_member from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = v_session.market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;
    if not (v_member.all_stores or v_member.role in ('owner','admin') or exists (
        select 1 from public.market_member_stores ms
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_session.market_store_id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'inventoryType', v_session.inventory_type,
        'status', v_session.status, 'startedAt', v_session.started_at,
        'createdAt', v_session.created_at, 'updatedAt', v_session.updated_at,
        'completedAt', v_session.completed_at, 'cancelledAt', v_session.cancelled_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'productId', i.product_id, 'productName', p.name, 'ean', p.ean, 'sku', p.sku, 'unit', p.unit,
            'quantity', i.quantity, 'isCounted', i.is_counted,
            'reasonCode', i.reason_code, 'reasonNote', i.reason_note
        ) order by p.name, i.created_at)
        from public.market_inventory_session_items i
        join public.market_products p on p.id = i.product_id and p.market_account_id = v_session.market_account_id
        where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
end;
$$;

comment on function public.market_list_inventory_sessions(uuid,uuid,integer) is
  'Lista sessoes de inventario CONCLUIDAS/CANCELADAS de uma loja, mais recente primeiro (updated_at desc), com a contagem de produtos contados. Draft ativo nunca aparece aqui (ja exibido pelo card "Inventario em andamento"). Somente leitura; nao bloqueia role viewer.';
comment on function public.market_get_inventory_session(uuid) is
  'Le uma sessao de inventario especifica (qualquer status) com seus itens, ja com nome/EAN/SKU/unidade do produto denormalizados — historico nao depende do catalogo atual de produtos ativos. Somente leitura; nao bloqueia role viewer.';

revoke all on function public.market_list_inventory_sessions(uuid,uuid,integer) from public;
revoke all on function public.market_get_inventory_session(uuid) from public;
grant execute on function public.market_list_inventory_sessions(uuid,uuid,integer) to authenticated;
grant execute on function public.market_get_inventory_session(uuid) to authenticated;

commit;
