-- Aplicação MANUAL. Próxima evolução da Sprint de Estoque, sobre a 202609080003
-- (não alterada aqui — is_counted/reason_code/reason_note, coluna e regras 3/4
-- intactas). NÃO altera 202609080002 nem 202609080003.
--
-- Motivação: smoke real (Market Alderi / Galpão Market) mostrou ser possível
-- finalizar um ajuste ADJUSTMENT_IN (+5, sobra) com reason_code='DAMAGE'
-- ("Quebra / avaria") — funcional, mas sem sentido: quebra/avaria só explica
-- FALTA de mercadoria, nunca sobra. O registro real já gravado (ADJUSTMENT_IN
-- + DAMAGE, anterior a esta migration) NÃO é alterado retroativamente —
-- permanece como evidência histórica de homologação.
--
-- Regra adicionada (regra 5, mesma posição das regras 3/4 da 202609080003,
-- antes de qualquer ramo initial/cycle): quando a diferença já é conhecida e
-- diferente de zero, reason_code (se informado) precisa ser coerente com o
-- sentido do ajuste que ele vai gerar:
--   * OUT-only  (só explicam falta):  EXPIRED_LOSS, DAMAGE, THEFT_LOSS, INTERNAL_USE
--   * IN-only   (só explica sobra):   UNREGISTERED_PURCHASE
--   * BOTH      (fazem sentido nos dois sentidos, sem restrição):
--                PREVIOUS_COUNT_ERROR, UNREGISTERED_TRANSFER, OTHER
-- Diferença zero NUNCA é avaliada por esta regra (nem exige, nem valida
-- motivo) — mesmo critério de escopo já usado pela regra 4 (join contra
-- current_balance restringe a itens com diferença <> 0).
--
-- reason_note continua exigido somente para reason_code='OTHER' (regra 4,
-- inalterada). is_counted (regra 3, inalterada) continua bloqueando
-- finalização com item sem contagem informada.
--
-- Único objeto alterado: market_finalize_inventory_draft, via CREATE OR
-- REPLACE (mesma assinatura uuid,integer — substitui a função já aplicada
-- pela 202609080003, não cria uma nova). Toda a lógica de reconciliação de
-- saldo (202609080002) e de is_counted/reason obrigatório (202609080003)
-- é preservada integralmente; só a nova regra 5 é inserida, no mesmo bloco
-- de validações "antes de qualquer ramo" já existente.
--
-- Compatível com initial e cycle: a regra 5, assim como a regra 4, nunca
-- decide por inventory_type — só pelo sinal da diferença calculada contra o
-- saldo operacional conhecido (mesma CTE/subquery já usada pelas regras
-- anteriores e pelos dois ramos de reconciliação).
--
-- Não altera Compras, Transferências, inventário multiusuário, nem a coluna
-- reason_code em si (os 8 valores do CHECK da 202609080003 continuam os
-- mesmos) — nenhum ALTER TABLE nesta migration.
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

    -- Regra 3 (202609080003, inalterada): nenhum item pode ficar sem
    -- contagem informada.
    if exists (
        select 1 from public.market_inventory_session_items i
        where i.inventory_session_id = v_session.id and i.is_counted = false
    ) then
        raise exception 'INVENTORY_UNCOUNTED_ITEMS: ainda existem produtos sem contagem informada.';
    end if;

    -- Regra 4 (202609080003, inalterada): divergência com saldo operacional
    -- CONHECIDO exige motivo, nunca decidido por inventory_type.
    if exists (
        select 1 from public.market_inventory_session_items i
        join (
            select m.product_id,
                coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)::numeric as quantity
            from public.market_stock_movements m
            where m.market_account_id = v_session.market_account_id and m.market_store_id = v_session.market_store_id
            group by m.product_id
        ) b on b.product_id = i.product_id
        where i.inventory_session_id = v_session.id
          and i.quantity - b.quantity <> 0
          and (i.reason_code is null or (i.reason_code = 'OTHER' and nullif(btrim(i.reason_note), '') is null))
    ) then
        raise exception 'INVENTORY_REASON_REQUIRED: existem divergencias de saldo sem motivo informado.';
    end if;

    -- Regra 5 (NOVA, 202609080004): quando a diferença já é conhecida e
    -- diferente de zero, reason_code (se informado — regra 4 já garante que
    -- está, para quem chegou até aqui) precisa ser coerente com o sentido do
    -- ajuste que ele vai gerar. Diferenca zero nunca e avaliada (mesmo escopo
    -- da regra 4, via o mesmo join contra o saldo atual).
    if exists (
        select 1 from public.market_inventory_session_items i
        join (
            select m.product_id,
                coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)::numeric as quantity
            from public.market_stock_movements m
            where m.market_account_id = v_session.market_account_id and m.market_store_id = v_session.market_store_id
            group by m.product_id
        ) b on b.product_id = i.product_id
        where i.inventory_session_id = v_session.id
          and i.reason_code is not null
          and i.quantity - b.quantity <> 0
          and (
              (i.quantity - b.quantity > 0 and i.reason_code in ('EXPIRED_LOSS','DAMAGE','THEFT_LOSS','INTERNAL_USE'))
              or
              (i.quantity - b.quantity < 0 and i.reason_code = 'UNREGISTERED_PURCHASE')
          )
    ) then
        raise exception 'INVENTORY_REASON_SIGN_MISMATCH: motivo incompativel com o sentido do ajuste (entrada/saida).';
    end if;

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

        -- Separa produtos sem nenhum movimento anterior (permanecem no
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
        -- um movimento anterior — inclusive saldo conhecido igual a zero.
        -- reason_code/reason_note (já validados acima) viram uma descrição
        -- legível em notes; sem motivo (diferença 0), mantém o texto padrão.
        with current_balance as materialized (
            select m.product_id,
                coalesce(sum(case when m.direction = 'IN' then m.quantity else -m.quantity end), 0)::numeric as quantity
            from public.market_stock_movements m
            where m.market_account_id = v_session.market_account_id and m.market_store_id = v_session.market_store_id
            group by m.product_id
        ), initial_differences as materialized (
            select i.id item_id, i.product_id, i.quantity - b.quantity as difference,
                i.reason_code, i.reason_note
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
            coalesce(
                case d.reason_code
                    when 'EXPIRED_LOSS' then 'Inventário: perda / produto vencido'
                    when 'DAMAGE' then 'Inventário: quebra / avaria'
                    when 'THEFT_LOSS' then 'Inventário: furto / extravio'
                    when 'PREVIOUS_COUNT_ERROR' then 'Inventário: contagem anterior incorreta'
                    when 'UNREGISTERED_PURCHASE' then 'Inventário: compra / nota não registrada'
                    when 'UNREGISTERED_TRANSFER' then 'Inventário: transferência não registrada'
                    when 'INTERNAL_USE' then 'Inventário: consumo / uso interno'
                    when 'OTHER' then 'Inventário: outro — ' || d.reason_note
                    else null
                end,
                'Ajuste na finalizacao do inventario inicial (saldo operacional ja existente)'
            ),
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
            i.quantity - coalesce(b.quantity, 0) as difference,
            i.reason_code, i.reason_note
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
            coalesce(
                case d.reason_code
                    when 'EXPIRED_LOSS' then 'Inventário: perda / produto vencido'
                    when 'DAMAGE' then 'Inventário: quebra / avaria'
                    when 'THEFT_LOSS' then 'Inventário: furto / extravio'
                    when 'PREVIOUS_COUNT_ERROR' then 'Inventário: contagem anterior incorreta'
                    when 'UNREGISTERED_PURCHASE' then 'Inventário: compra / nota não registrada'
                    when 'UNREGISTERED_TRANSFER' then 'Inventário: transferência não registrada'
                    when 'INTERNAL_USE' then 'Inventário: consumo / uso interno'
                    when 'OTHER' then 'Inventário: outro — ' || d.reason_note
                    else null
                end,
                'Ajuste por inventario recorrente'
            ),
            now(), auth.uid()
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
  'Finaliza um rascunho de inventário. Bloqueia se houver item sem contagem informada (is_counted=false), item com saldo operacional conhecido cuja contagem diverge sem reason_code (e reason_note quando OTHER), ou item cujo reason_code seja incoerente com o sentido do ajuste (regra 5, 202609080004: OUT-only para EXPIRED_LOSS/DAMAGE/THEFT_LOSS/INTERNAL_USE, IN-only para UNREGISTERED_PURCHASE, sem restrição para PREVIOUS_COUNT_ERROR/UNREGISTERED_TRANSFER/OTHER). Cycle sempre reconciliou contra o saldo vigente; initial também reconcilia por produto (202609080002): sem movimento anterior estabelece o saldo, com saldo já existente gera somente o ADJUSTMENT_IN/OUT da diferença, com o motivo copiado para notes. stock_control_started_at continua sendo gravado uma única vez.';

-- Grants inalterados: já concedidos pelas migrations anteriores e não são
-- revogados por CREATE OR REPLACE (mesmo oid). Mesmo padrão já usado em
-- 202609070006_purchase_receiving_require_unit_cost.sql, 202609080002 e
-- 202609080003.

commit;
