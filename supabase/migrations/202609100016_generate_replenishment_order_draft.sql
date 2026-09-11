-- GiroMicro Market
-- Reposicao Inteligente / Lista de Compras
-- Migration: gera lista draft consolidada a partir do ultimo batch efetivo
-- Data: 2026-09-10
--
-- Escopo:
-- - adiciona o rateio explicito Galpao x Compra nas allocations;
-- - cria a RPC que materializa uma lista draft a partir do ultimo run efetivo;
-- - nao altera o batch existente.

begin;

alter table public.market_replenishment_order_allocations
    alter column suggested_quantity drop not null;

alter table public.market_replenishment_order_allocations
    drop constraint if exists market_replenishment_order_allocations_suggested_check;

alter table public.market_replenishment_order_allocations
    add constraint market_replenishment_order_allocations_suggested_check
    check (suggested_quantity is null or suggested_quantity >= 0);

alter table public.market_replenishment_order_allocations
    add column if not exists warehouse_allocated_quantity numeric(18,4) null,
    add column if not exists purchase_needed_quantity numeric(18,4) null;

alter table public.market_replenishment_order_allocations
    add constraint market_replenishment_order_allocations_warehouse_allocated_check
    check (
        warehouse_allocated_quantity is null
        or warehouse_allocated_quantity >= 0
    ) not valid;

alter table public.market_replenishment_order_allocations
    add constraint market_replenishment_order_allocations_purchase_needed_check
    check (
        purchase_needed_quantity is null
        or purchase_needed_quantity >= 0
    ) not valid;

alter table public.market_replenishment_order_allocations
    add constraint market_replenishment_order_allocations_source_split_check
    check (
        (
            suggested_quantity is null
            and warehouse_allocated_quantity is null
            and purchase_needed_quantity is null
        )
        or
        (
            suggested_quantity is not null
            and warehouse_allocated_quantity is not null
            and purchase_needed_quantity is not null
            and warehouse_allocated_quantity <= suggested_quantity
            and suggested_quantity = warehouse_allocated_quantity + purchase_needed_quantity
        )
    ) not valid;

comment on column public.market_replenishment_order_allocations.warehouse_allocated_quantity is
'Quantidade da necessidade da loja atendida pelo saldo agregado do Galpao no momento da geracao da lista. NULL quando a necessidade original da loja e desconhecida.';

comment on column public.market_replenishment_order_allocations.purchase_needed_quantity is
'Quantidade da necessidade da loja que ainda precisa ser comprada apos o rateio do Galpao. NULL quando a necessidade original da loja e desconhecida.';

create or replace function public.market_generate_replenishment_order_draft(
    p_market_account_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_run public.market_replenishment_runs;
    v_order_id uuid;
    v_candidate_count integer;
begin
    if p_market_account_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id e obrigatorio.';
    end if;

    if not exists (
        select 1
        from public.market_accounts a
        where a.id = p_market_account_id
          and a.status in ('pilot','active')
    ) then
        raise exception 'REPLENISHMENT_ORDER_ACCOUNT_UNAVAILABLE: conta Market indisponivel.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: vinculo ativo nao encontrado.';
        end if;

        if not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para gerar lista consolidada.';
        end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended(
        'market-replenishment-order-draft:' || p_market_account_id::text, 0));

    select r.* into v_run
    from public.market_replenishment_runs r
    where r.market_account_id = p_market_account_id
      and r.status = 'completed'
      and r.is_effective = true
    order by r.reference_date desc, r.started_at desc
    limit 1;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_EFFECTIVE_RUN_NOT_FOUND: nenhum batch efetivo concluido foi encontrado.';
    end if;

    select o.id into v_order_id
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.run_id = v_run.id
      and o.status <> 'cancelled'
    order by o.created_at
    limit 1;

    if found then
        return v_order_id;
    end if;

    select count(*) into v_candidate_count
    from public.market_replenishment_candidates c
    where c.market_account_id = p_market_account_id
      and c.run_id = v_run.id;

    if v_candidate_count = 0 then
        raise exception 'REPLENISHMENT_ORDER_NO_CANDIDATES: o batch efetivo nao possui candidatos selecionados.';
    end if;

    insert into public.market_replenishment_orders (
        market_account_id, run_id, status, created_by, updated_by
    ) values (
        p_market_account_id, v_run.id, 'draft', auth.uid(), auth.uid()
    )
    returning id into v_order_id;

    with product_totals as (
        select
            c.product_id,
            coalesce(
                sum(c.suggested_quantity) filter (where c.suggested_quantity is not null),
                0
            )::numeric(18,4) as total_suggested_quantity
        from public.market_replenishment_candidates c
        where c.market_account_id = p_market_account_id
          and c.run_id = v_run.id
        group by c.product_id
    ),
    warehouse_stock as (
        select
            b.product_id,
            sum(b.quantity_on_hand)::numeric(18,4) as warehouse_stock_snapshot
        from public.market_stock_balance b
        join public.market_stores s
          on s.id = b.market_store_id
         and s.market_account_id = b.market_account_id
        where b.market_account_id = p_market_account_id
          and s.store_type = 'warehouse'
        group by b.product_id
    )
    insert into public.market_replenishment_order_items (
        order_id,
        market_account_id,
        product_id,
        status,
        total_suggested_quantity,
        warehouse_stock_snapshot,
        suggested_purchase_quantity
    )
    select
        v_order_id,
        p_market_account_id,
        pt.product_id,
        'pending',
        pt.total_suggested_quantity,
        ws.warehouse_stock_snapshot,
        greatest(
            pt.total_suggested_quantity
            - greatest(coalesce(ws.warehouse_stock_snapshot, 0), 0),
            0
        )::numeric(18,4)
    from product_totals pt
    left join warehouse_stock ws on ws.product_id = pt.product_id;

    with ordered_candidates as (
        select
            c.id as candidate_id,
            c.store_id,
            c.product_id,
            c.suggested_quantity,
            oi.id as order_item_id,
            greatest(coalesce(oi.warehouse_stock_snapshot, 0), 0) as warehouse_available,
            coalesce(
                sum(c.suggested_quantity) over (
                    partition by c.product_id
                    order by
                        case c.priority_level
                            when 'critical' then 1
                            when 'high' then 2
                            when 'medium' then 3
                            else 4
                        end,
                        c.rank_position,
                        c.id
                    rows between unbounded preceding and 1 preceding
                ),
                0
            ) as previous_known_need
        from public.market_replenishment_candidates c
        join public.market_replenishment_order_items oi
          on oi.order_id = v_order_id
         and oi.market_account_id = c.market_account_id
         and oi.product_id = c.product_id
        where c.market_account_id = p_market_account_id
          and c.run_id = v_run.id
    ),
    split as (
        select
            oc.*,
            case
                when oc.suggested_quantity is null then null
                else least(
                    oc.suggested_quantity,
                    greatest(oc.warehouse_available - oc.previous_known_need, 0)
                )::numeric(18,4)
            end as warehouse_allocated_quantity
        from ordered_candidates oc
    )
    insert into public.market_replenishment_order_allocations (
        order_item_id,
        market_account_id,
        store_id,
        candidate_id,
        status,
        suggested_quantity,
        warehouse_allocated_quantity,
        purchase_needed_quantity
    )
    select
        s.order_item_id,
        p_market_account_id,
        s.store_id,
        s.candidate_id,
        'pending',
        s.suggested_quantity,
        s.warehouse_allocated_quantity,
        case
            when s.suggested_quantity is null then null
            else (s.suggested_quantity - s.warehouse_allocated_quantity)::numeric(18,4)
        end
    from split s;

    return v_order_id;
end;
$$;

revoke all on function public.market_generate_replenishment_order_draft(uuid) from public, anon;
grant execute on function public.market_generate_replenishment_order_draft(uuid) to authenticated;
grant execute on function public.market_generate_replenishment_order_draft(uuid) to service_role;

comment on function public.market_generate_replenishment_order_draft(uuid) is
'Gera de forma idempotente a lista draft de reposicao/compra a partir do ultimo run efetivo do Market. Consolida por produto, usa o saldo agregado atual dos warehouses uma unica vez e preserva o rateio por loja em market_replenishment_order_allocations.';

commit;
