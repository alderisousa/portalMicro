-- Aplicação MANUAL. Corrige bug confirmado em homologação: a finalização de
-- um inventário `initial` somava a quantidade contada inteira como um novo
-- movimento INVENTORY/IN, mesmo quando o produto já tinha saldo operacional
-- real vindo de Compras (PURCHASE/IN). Uma loja pode receber mercadoria antes
-- de qualquer inventário formal ser finalizado — `stock_control_started_at`
-- continua null nesse caso, então `inventory_type` continua 'initial' mesmo
-- havendo saldo real (ver 202609010004_add_market_cycle_inventory.sql:65-68
-- e 128, que já classificam por stock_control_started_at, não pelo saldo).
--
-- Caso real (Galpão Market): Galvani (saldo 1), Goma Dori (saldo 30) e Galak
-- (saldo 64) já tinham PURCHASE/IN. A tela mostrava corretamente
-- "Saldo 64 · Contagem 64 · Diferença 0" para o Galak, mas ao finalizar o
-- primeiro inventário do Galpão via market_start_stock_control, o saldo virou
-- 128 (64 contados + 64 já existentes), em vez de permanecer 64.
--
-- Único objeto alterado: market_finalize_inventory_draft, via CREATE OR
-- REPLACE (mesma assinatura uuid,integer — substitui a função já aplicada
-- pela 202609010004, não cria uma nova). market_start_stock_control
-- (202609010001) NÃO é alterada: seu contrato ("estabelece estas
-- quantidades como o estoque inicial, sem exceção") continua correto para
-- produtos que realmente nunca tiveram movimento — só passa a ser chamada
-- apenas com esse subconjunto. market_save_inventory_draft, market_stock_balance,
-- compareStockCount e o gate (isCycleInventory || comparison.known) do
-- frontend não são tocados.
--
-- Regra aplicada, por produto contado na finalização 'initial':
--   * sem nenhum movimento anterior no local -> comportamento 100% original:
--     entra em market_start_stock_control, gera INVENTORY/IN com a
--     quantidade contada inteira (estabelece o saldo pela primeira vez).
--   * com pelo menos um movimento anterior (mesmo net = 0, ex.: saldo
--     conhecido zero) -> reconciliado com a MESMA lógica de diferença já
--     homologada no bloco 'cycle' logo abaixo (mesma CTE materializada,
--     mesmas colunas de referência, mesmo índice único de idempotência):
--       diferença = 0            -> nenhum movimento é gerado.
--       diferença > 0 (sobra)    -> ADJUSTMENT_IN, quantidade = diferença.
--       diferença < 0 (falta)    -> ADJUSTMENT_OUT, quantidade = abs(diferença).
--
-- market_start_stock_control rejeita array de itens vazio (STOCK_INVALID_ITEMS,
-- linha 80-84 de 202609010001). Quando TODOS os produtos contados já têm
-- saldo anterior (ex.: Galpão), o subconjunto "novo" fica vazio — nesse caso
-- o marco stock_control_started_at é gravado diretamente aqui, com os mesmos
-- valores que market_start_stock_control gravaria, preservando a transição
-- initial -> controle iniciado -> próximos inventários cycle.
--
-- Atomicidade/concorrência: reaproveitada sem mudança. market_finalize_inventory_draft
-- já adquire FOR UPDATE em market_stores (linha ~238 da 202609010004) antes de
-- qualquer leitura/escrita em market_stock_movements desta loja — mesma regra
-- global de serialização já documentada nesse arquivo. A leitura do saldo
-- atual (CTE current_balance) e a escrita dos ajustes acontecem sob esse
-- mesmo lock, na mesma transação; nenhum lock novo foi necessário.
--
-- Não altera Compras, Transferências, migrations anteriores, is_counted ou
-- motivo de divergência (fora de escopo desta correção).
begin;

create or replace function public.market_finalize_inventory_draft(
    p_inventory_session_id uuid,
    p_expected_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_session public.market_inventory_sessions;
    v_store public.market_stores;
    v_member public.market_account_members;
    v_locator_account_id uuid;
    v_locator_store_id uuid;
    v_items jsonb;
    v_new_items jsonb;
    v_stock_result jsonb;
    v_adjustment_in_count integer := 0;
    v_adjustment_out_count integer := 0;
    v_unchanged_count integer := 0;
    v_adjustment_in_quantity numeric := 0;
    v_adjustment_out_quantity numeric := 0;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    -- Leitura localizadora, sem valor de estado: serve exclusivamente para
    -- descobrir qual loja deve ser bloqueada. Nada da sessao e confiado aqui.
    select market_account_id, market_store_id
    into v_locator_account_id, v_locator_store_id
    from public.market_inventory_sessions
    where id = p_inventory_session_id;
    if not found then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.';
    end if;

    -- REGRA GLOBAL DE SERIALIZACAO:
    -- Toda operacao que grava market_stock_movements de uma loja deve adquirir
    -- primeiro FOR UPDATE da mesma market_stores. A ordem e sempre loja ->
    -- sessao; nunca sessao -> loja.
    select * into v_store from public.market_stores
    where id = v_locator_store_id and market_account_id = v_locator_account_id
      and status = 'active' for update;
    if not found then raise exception 'INVENTORY_STORE_UNAVAILABLE: loja indisponivel.'; end if;

    -- Somente depois do lock da loja a sessao e relida, bloqueada e passa a ser
    -- considerada estado confiavel.
    select * into v_session from public.market_inventory_sessions
    where id = p_inventory_session_id and market_account_id = v_store.market_account_id
      and market_store_id = v_store.id for update;
    if not found or v_session.status <> 'draft' then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.';
    end if;
    if p_expected_version is null or v_session.version <> p_expected_version then
        raise exception 'INVENTORY_VERSION_CONFLICT: rascunho atualizado em outro dispositivo.';
    end if;
    if v_session.inventory_type not in ('initial','cycle') then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: tipo de inventario invalido.';
    end if;

    select m.* into v_member from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = v_session.market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;
    if v_member.role = 'viewer' then raise exception 'INVENTORY_PERMISSION_DENIED: perfil somente leitura.'; end if;
    if not (v_member.all_stores or v_member.role in ('owner','admin') or exists (
        select 1 from public.market_member_stores ms
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_store.id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    if v_session.inventory_type = 'initial' then
        if v_store.stock_control_started_at is not null then
            raise exception 'INVENTORY_DRAFT_UNAVAILABLE: estoque ja iniciado para esta loja.';
        end if;
        select jsonb_agg(jsonb_build_object('productId', i.product_id, 'quantity', i.quantity)
            order by i.created_at, i.product_id) into v_items
        from public.market_inventory_session_items i
        where i.inventory_session_id = v_session.id and i.quantity > 0;
        if v_items is null or jsonb_array_length(v_items) = 0 then
            raise exception 'INVENTORY_EMPTY: informe ao menos um produto.';
        end if;

        -- NOVO: separa produtos sem nenhum movimento anterior (permanecem no
        -- caminho original, market_start_stock_control) dos que já têm saldo
        -- operacional real (reconciliados abaixo, mesma lógica do 'cycle').
        select coalesce(jsonb_agg(jsonb_build_object('productId', i.product_id, 'quantity', i.quantity)
            order by i.created_at, i.product_id), '[]'::jsonb)
        into v_new_items
        from public.market_inventory_session_items i
        where i.inventory_session_id = v_session.id and i.quantity > 0
          and not exists (
              select 1 from public.market_stock_movements m
              where m.market_account_id = v_session.market_account_id
                and m.market_store_id = v_session.market_store_id
                and m.product_id = i.product_id
          );

        if jsonb_array_length(v_new_items) > 0 then
            v_stock_result := public.market_start_stock_control(v_store.id, v_session.started_at, v_new_items);
        else
            -- market_start_stock_control rejeita array vazio (STOCK_INVALID_ITEMS).
            -- Todo produto contado já tinha saldo anterior (ex.: Galpão Market,
            -- que só recebeu por Compras) — não há item "novo" a estabelecer,
            -- mas o marco formal de início do controle de estoque da loja ainda
            -- precisa ser gravado, com os mesmos campos que a RPC gravaria.
            update public.market_stores set stock_control_started_at = v_session.started_at, updated_at = now()
                where id = v_store.id;
            v_stock_result := jsonb_build_object(
                'marketAccountId', v_store.market_account_id, 'marketStoreId', v_store.id,
                'stockControlStartedAt', v_session.started_at, 'inventoryItems', 0
            );
        end if;

        -- Mesma CTE materializada de diferença já homologada no bloco 'cycle'
        -- abaixo: um único cálculo, sem segunda implementação. O join contra
        -- current_balance já restringe este bloco aos produtos com pelo menos
        -- um movimento anterior (current_balance só existe para quem tem
        -- alguma linha em market_stock_movements) — inclusive saldo conhecido
        -- igual a zero, que conta como "conhecido" aqui.
        with current_balance as materialized (
            select m.product_id,
                coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)::numeric as quantity
            from public.market_stock_movements m
            where m.market_account_id = v_session.market_account_id and m.market_store_id = v_session.market_store_id
            group by m.product_id
        ), initial_differences as materialized (
            select i.id item_id, i.product_id, i.quantity - b.quantity as difference
            from public.market_inventory_session_items i
            join current_balance b on b.product_id = i.product_id
            where i.inventory_session_id = v_session.id and i.quantity > 0
        )
        insert into public.market_stock_movements (
            market_account_id, market_store_id, product_id, movement_type,
            direction, quantity, reference_type, reference_id, reference_item_id,
            notes, occurred_at, created_by
        )
        select v_session.market_account_id, v_session.market_store_id, d.product_id,
            case when d.difference > 0 then 'ADJUSTMENT_IN' else 'ADJUSTMENT_OUT' end,
            case when d.difference > 0 then 'IN' else 'OUT' end,
            abs(d.difference), 'INVENTORY_SESSION', v_session.id, d.item_id,
            'Ajuste na finalizacao do inventario inicial (saldo operacional ja existente)',
            v_session.started_at, auth.uid()
        from initial_differences d where d.difference <> 0;

        update public.market_inventory_sessions set status = 'completed', completed_at = now(),
            updated_at = now(), version = version + 1 where id = v_session.id returning * into v_session;
        return v_stock_result || jsonb_build_object(
            'inventoryType', v_session.inventory_type,
            'inventorySessionId', v_session.id, 'inventorySessionStatus', v_session.status,
            'inventorySessionVersion', v_session.version
        );
    end if;

    if v_session.inventory_type <> 'cycle' or v_store.stock_control_started_at is null then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: inventario incompativel com o estado da loja.';
    end if;
    if not exists (select 1 from public.market_inventory_session_items i where i.inventory_session_id = v_session.id) then
        raise exception 'INVENTORY_EMPTY: informe ao menos um produto contado.';
    end if;

    -- O mesmo conjunto materializado de diferencas origina os movimentos e
    -- todos os totais retornados. Nao ha uma segunda avaliacao da reconciliacao.
    with current_balance as materialized (
        select m.product_id,
            coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)::numeric as quantity
        from public.market_stock_movements m
        where m.market_account_id = v_session.market_account_id and m.market_store_id = v_session.market_store_id
        group by m.product_id
    ), differences as materialized (
        select i.id item_id, i.product_id,
            i.quantity - coalesce(b.quantity, 0) as difference
        from public.market_inventory_session_items i
        left join current_balance b on b.product_id = i.product_id
        where i.inventory_session_id = v_session.id
    ), inserted_movements as (
        insert into public.market_stock_movements (
            market_account_id, market_store_id, product_id, movement_type,
            direction, quantity, reference_type, reference_id, reference_item_id,
            notes, occurred_at, created_by
        )
        select v_session.market_account_id, v_session.market_store_id, d.product_id,
            case when d.difference > 0 then 'ADJUSTMENT_IN' else 'ADJUSTMENT_OUT' end,
            case when d.difference > 0 then 'IN' else 'OUT' end,
            abs(d.difference), 'INVENTORY_SESSION', v_session.id, d.item_id,
            'Ajuste por inventario recorrente', now(), auth.uid()
        from differences d where d.difference <> 0
        returning direction, quantity
    )
    select movement_totals.adjustment_in_count,
           movement_totals.adjustment_out_count,
           difference_totals.unchanged_count,
           movement_totals.adjustment_in_quantity,
           movement_totals.adjustment_out_quantity
    into v_adjustment_in_count, v_adjustment_out_count, v_unchanged_count,
         v_adjustment_in_quantity, v_adjustment_out_quantity
    from (
        select count(*) filter (where direction = 'IN') adjustment_in_count,
               count(*) filter (where direction = 'OUT') adjustment_out_count,
               coalesce(sum(quantity) filter (where direction = 'IN'), 0) adjustment_in_quantity,
               coalesce(sum(quantity) filter (where direction = 'OUT'), 0) adjustment_out_quantity
        from inserted_movements
    ) movement_totals
    cross join (
        select count(*) filter (where difference = 0) unchanged_count
        from differences
    ) difference_totals;

    update public.market_inventory_sessions set status = 'completed', completed_at = now(),
        updated_at = now(), version = version + 1 where id = v_session.id returning * into v_session;

    return jsonb_build_object(
        'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id,
        'inventoryType', v_session.inventory_type,
        'inventorySessionId', v_session.id,
        'inventorySessionStatus', v_session.status,
        'inventorySessionVersion', v_session.version,
        'countedProducts', v_adjustment_in_count + v_adjustment_out_count + v_unchanged_count,
        'adjustmentInProducts', v_adjustment_in_count,
        'adjustmentOutProducts', v_adjustment_out_count,
        'unchangedProducts', v_unchanged_count,
        'adjustmentInQuantity', v_adjustment_in_quantity,
        'adjustmentOutQuantity', v_adjustment_out_quantity
    );
exception when unique_violation then
    raise exception 'INVENTORY_ALREADY_FINALIZED: ajustes deste inventario ja foram registrados.';
end;
$$;

comment on function public.market_finalize_inventory_draft(uuid,integer) is
  'Finaliza um rascunho de inventário. Cycle sempre reconciliou contra o saldo vigente. Initial agora também reconcilia por produto: sem movimento anterior estabelece o saldo (market_start_stock_control, INVENTORY/IN); com saldo operacional já existente (ex.: Compras), gera somente o ADJUSTMENT_IN/OUT da diferença, nunca duplicando o saldo já registrado. stock_control_started_at continua sendo gravado uma única vez, mesmo quando todos os produtos contados já tinham saldo anterior.';

-- Grants inalterados: já concedidos pela 202609010004 e não são revogados por
-- um CREATE OR REPLACE (a função mantém o mesmo oid). Reafirmar aqui não
-- corrige nada e só arriscaria uma janela sem permissão caso a ordem de
-- comandos importasse — por isso omitido de propósito (mesmo padrão já usado
-- em 202609070006_purchase_receiving_require_unit_cost.sql).

commit;
