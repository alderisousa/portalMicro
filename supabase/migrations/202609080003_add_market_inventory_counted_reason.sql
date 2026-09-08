-- Aplicação MANUAL. Próxima evolução da Sprint de Estoque, sobre a correção
-- já aplicada em 202609080002 (não alterada aqui — mesma regra de
-- reconciliação de saldo, intocada).
--
-- 1) "Não contado" deixa de ser confundido com "contado como zero". Produto
--    recém-incluído na contagem (busca por nome, EAN/GTIN, SKU/código
--    externo ou scanner) entra com quantity=0 + is_counted=false. quantity
--    continua NOT NULL (contrato preservado) — is_counted é quem carrega o
--    significado de "ainda sem valor informado pelo operador".
-- 2) Itens não contados passam a sobreviver a autosave/Fechar
--    inventário/retomada (deixam de ser filtrados do payload salvo).
-- 3) market_finalize_inventory_draft bloqueia a finalização se existir
--    qualquer item is_counted=false.
-- 4) market_finalize_inventory_draft exige reason_code (e reason_note
--    quando reason_code='OTHER') para todo item com saldo operacional
--    conhecido cuja contagem diverge dele — usando o MESMO critério de
--    "known" já usado pelo frontend (compareStockCount) e pela correção
--    202609080002: existe pelo menos um movimento anterior do produto neste
--    local, independente de inventory_type ser 'initial' ou 'cycle'.
-- 5) O motivo é persistido no item do inventário (fonte primária) e copiado
--    como texto legível para market_stock_movements.notes no momento em que
--    o movimento de ajuste é gerado (rastreável também via reference_item_id,
--    já existente). Nenhuma coluna nova em market_stock_movements.
--
-- Objetos alterados: market_inventory_session_items (3 colunas novas,
-- nullable/default seguro para dados existentes), market_save_inventory_draft,
-- market_get_inventory_draft, market_finalize_inventory_draft — todas via
-- CREATE OR REPLACE (mesma assinatura de sempre). Nenhuma tabela nova.
-- Nenhuma migration antiga é alterada, incluindo 202609080002.
--
-- Não toca Compras, Transferências, nem a regra de reconciliação de saldo
-- já corrigida (current_balance/differences seguem com a mesma fórmula).
begin;

alter table public.market_inventory_session_items
  add column is_counted boolean not null default true,
  add column reason_code text null,
  add column reason_note text null;

comment on column public.market_inventory_session_items.is_counted is
  'false = produto selecionado na contagem mas ainda sem quantidade física informada pelo operador. Não confundir com quantity=0 (contagem explícita de zero, is_counted=true). Default true preserva o significado de todo registro criado antes desta coluna existir, que sempre representava uma contagem já informada.';
comment on column public.market_inventory_session_items.reason_code is
  'Motivo da divergência entre a contagem física e o saldo operacional conhecido, exigido por market_finalize_inventory_draft quando aplicável. Null quando não se aplica (sem divergência, ou saldo desconhecido estabelecendo a primeira referência do produto/local).';
comment on column public.market_inventory_session_items.reason_note is
  'Observação complementar do motivo. Obrigatória somente quando reason_code = OTHER — validado em market_finalize_inventory_draft, não por constraint de tabela, para não travar o autosave enquanto o operador ainda está digitando a observação.';

alter table public.market_inventory_session_items
  add constraint market_inventory_session_items_reason_code_check
  check (reason_code is null or reason_code in (
    'EXPIRED_LOSS','DAMAGE','THEFT_LOSS','PREVIOUS_COUNT_ERROR',
    'UNREGISTERED_PURCHASE','UNREGISTERED_TRANSFER','INTERNAL_USE','OTHER'
  ));

-- Mesmo corpo de 202609010004, com três mudanças: (a) o INSERT passa a
-- gravar is_counted/reason_code/reason_note; (b) o filtro de persistência
-- passa a preservar itens não contados também em sessões 'initial' (a regra
-- antiga de sessão 'initial' descartar item com quantity=0 continua valendo
-- só para item JÁ contado como zero — is_counted=false nunca é descartado,
-- em nenhum tipo de sessão); (c) o retorno passa a incluir os três campos
-- por item.
create or replace function public.market_save_inventory_draft(
  p_market_store_id uuid,
  p_inventory_session_id uuid,
  p_expected_version integer,
  p_started_at timestamptz,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_store public.market_stores;
    v_member public.market_account_members;
    v_session public.market_inventory_sessions;
    v_inventory_type text;
    v_item_count integer;
    v_distinct_count integer;
    v_valid_count integer;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if p_started_at is null or p_items is null or jsonb_typeof(p_items) <> 'array'
       or jsonb_array_length(p_items) > 5000 then
        raise exception 'INVENTORY_INVALID_DRAFT: data e lista de itens invalidas.';
    end if;

    -- A loja e o ponto de serializacao de toda operacao que altera seu ledger.
    select s.* into v_store from public.market_stores s
    join public.market_accounts a on a.id = s.market_account_id and a.status in ('pilot','active')
    where s.id = p_market_store_id and s.status = 'active' for update of s;
    if not found then raise exception 'INVENTORY_STORE_UNAVAILABLE: loja indisponivel.'; end if;
    v_inventory_type := case when v_store.stock_control_started_at is null then 'initial' else 'cycle' end;

    select m.* into v_member from public.market_account_members m
    where m.market_account_id = v_store.market_account_id and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;
    if v_member.role = 'viewer' then raise exception 'INVENTORY_PERMISSION_DENIED: perfil somente leitura.'; end if;
    if not (v_member.all_stores or v_member.role in ('owner','admin') or exists (
        select 1 from public.market_member_stores ms
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_store.id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    select count(*), count(distinct (item->>'productId')::uuid)
    into v_item_count, v_distinct_count from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) = 'object'
      and btrim(item->>'productId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and btrim(item->>'quantity') ~ '^[0-9]+([.][0-9]+)?$'
      and (item->>'quantity')::numeric >= 0;
    if v_item_count <> jsonb_array_length(p_items) or v_distinct_count <> v_item_count then
        raise exception 'INVENTORY_INVALID_ITEMS: produtos unicos e quantidades nao negativas sao obrigatorios.';
    end if;

    select count(*) into v_valid_count from public.market_products p
    join (select distinct (item->>'productId')::uuid product_id from jsonb_array_elements(p_items) item) requested
      on requested.product_id = p.id
    where p.market_account_id = v_store.market_account_id and p.status = 'active';
    if v_valid_count <> v_item_count then raise exception 'INVENTORY_INVALID_PRODUCT: produto invalido ou de outra conta.'; end if;

    if p_inventory_session_id is null then
        if p_expected_version is not null then raise exception 'INVENTORY_VERSION_CONFLICT: versao inesperada para novo rascunho.'; end if;
        insert into public.market_inventory_sessions (
            market_account_id, market_store_id, inventory_type, started_at, created_by
        ) values (v_store.market_account_id, v_store.id, v_inventory_type, p_started_at, auth.uid())
        returning * into v_session;
    else
        select * into v_session from public.market_inventory_sessions
        where id = p_inventory_session_id and market_account_id = v_store.market_account_id
          and market_store_id = v_store.id for update;
        if not found or v_session.status <> 'draft' or v_session.inventory_type <> v_inventory_type then
            raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente, encerrado ou incompativel com o estado da loja.';
        end if;
        if p_expected_version is null or v_session.version <> p_expected_version then
            raise exception 'INVENTORY_VERSION_CONFLICT: rascunho atualizado em outro dispositivo.';
        end if;
        update public.market_inventory_sessions set started_at = p_started_at,
            version = version + 1, updated_at = now()
        where id = v_session.id returning * into v_session;
        delete from public.market_inventory_session_items where inventory_session_id = v_session.id;
    end if;

    -- "não contado" (is_counted=false) sempre persiste, em qualquer tipo de
    -- sessão — é exatamente o dado que precisa sobreviver a autosave/Fechar
    -- inventário/retomada. A regra antiga (sessão 'initial' não persiste
    -- item com quantity=0) continua valendo, mas só se aplica a item JÁ
    -- contado como zero (is_counted=true); nunca a item ainda não contado.
    insert into public.market_inventory_session_items (
        market_account_id, inventory_session_id, product_id, quantity, is_counted, reason_code, reason_note
    ) select v_store.market_account_id, v_session.id, (item->>'productId')::uuid,
        (item->>'quantity')::numeric, coalesce((item->>'isCounted')::boolean, true),
        nullif(btrim(item->>'reasonCode'), ''), nullif(btrim(item->>'reasonNote'), '')
    from jsonb_array_elements(p_items) item
    where v_session.inventory_type = 'cycle'
       or coalesce((item->>'isCounted')::boolean, true) = false
       or (item->>'quantity')::numeric > 0;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'inventoryType', v_session.inventory_type,
        'status', v_session.status, 'startedAt', v_session.started_at,
        'version', v_session.version, 'createdAt', v_session.created_at,
        'updatedAt', v_session.updated_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'productId', i.product_id, 'quantity', i.quantity, 'isCounted', i.is_counted,
            'reasonCode', i.reason_code, 'reasonNote', i.reason_note
        ) order by i.created_at, i.product_id) from public.market_inventory_session_items i
            where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
exception when unique_violation then
    raise exception 'INVENTORY_DRAFT_CONFLICT: ja existe inventario em andamento para esta loja.';
end;
$$;

-- Mesmo corpo de 202609010004, só devolvendo is_counted/reason_code/reason_note
-- por item, para a retomada preservar exatamente o que foi salvo.
create or replace function public.market_get_inventory_draft(
    p_market_account_id uuid,
    p_market_store_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_session public.market_inventory_sessions;
    v_inventory_type text;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;

    select m.* into v_member
    from public.market_account_members m
    join public.market_accounts a on a.id = m.market_account_id and a.status in ('pilot','active')
    where m.market_account_id = p_market_account_id
      and m.user_id = auth.uid() and m.status = 'active'
    order by m.created_at limit 1;
    if not found then raise exception 'INVENTORY_MEMBERSHIP_REQUIRED: vinculo ativo nao encontrado.'; end if;

    select case when s.stock_control_started_at is null then 'initial' else 'cycle' end
    into v_inventory_type
    from public.market_stores s
    where s.id = p_market_store_id and s.market_account_id = p_market_account_id
      and s.status = 'active'
      and (v_member.all_stores or v_member.role in ('owner','admin') or exists (
          select 1 from public.market_member_stores ms
          where ms.market_account_member_id = v_member.id and ms.market_store_id = s.id
      ));
    if not found then raise exception 'INVENTORY_STORE_NOT_ALLOWED: loja inexistente ou sem acesso.'; end if;

    select * into v_session from public.market_inventory_sessions
    where market_account_id = p_market_account_id and market_store_id = p_market_store_id
      and inventory_type = v_inventory_type and status = 'draft'
    limit 1;
    if not found then return null; end if;

    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'inventoryType', v_session.inventory_type,
        'status', v_session.status, 'startedAt', v_session.started_at,
        'version', v_session.version, 'createdAt', v_session.created_at,
        'updatedAt', v_session.updated_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'productId', i.product_id, 'quantity', i.quantity, 'isCounted', i.is_counted,
            'reasonCode', i.reason_code, 'reasonNote', i.reason_note
        ) order by i.created_at, i.product_id)
        from public.market_inventory_session_items i where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
end;
$$;

-- Mesmo corpo de 202609080002 (regra de reconciliação de saldo inalterada),
-- com três adições: (1) bloqueia a finalização se existir item is_counted=false;
-- (2) exige reason_code (e reason_note quando OTHER) para todo item com saldo
-- conhecido cuja contagem diverge, independente de inventory_type — validado
-- ANTES de qualquer insert, com a MESMA CTE de saldo atual já usada para
-- calcular a diferença (nenhum segundo cálculo); (3) copia uma descrição do
-- motivo para notes ao gerar ADJUSTMENT_IN/OUT, nos dois ramos (initial com
-- saldo conhecido e cycle).
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

    -- NOVO — validado uma única vez, igual para 'initial' e 'cycle', ANTES
    -- de qualquer ramo: nunca confia só no frontend.
    --
    -- Regra 3: nenhum item pode ficar sem contagem informada.
    if exists (
        select 1 from public.market_inventory_session_items i
        where i.inventory_session_id = v_session.id and i.is_counted = false
    ) then
        raise exception 'INVENTORY_UNCOUNTED_ITEMS: ainda existem produtos sem contagem informada.';
    end if;

    -- Regra 4: divergência com saldo operacional CONHECIDO exige motivo,
    -- nunca decidido por inventory_type. "Conhecido" = existe pelo menos um
    -- movimento anterior do produto neste local (mesmo critério de
    -- compareStockCount/known no frontend) — o INNER JOIN abaixo já restringe
    -- a esse subconjunto; produto sem nenhum movimento anterior nunca exige
    -- motivo (está estabelecendo a primeira referência).
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
  'Finaliza um rascunho de inventário. Bloqueia se houver item sem contagem informada (is_counted=false) ou item com saldo operacional conhecido cuja contagem diverge sem reason_code (e reason_note quando OTHER). Cycle sempre reconciliou contra o saldo vigente; initial também reconcilia por produto (202609080002): sem movimento anterior estabelece o saldo, com saldo já existente gera somente o ADJUSTMENT_IN/OUT da diferença, com o motivo copiado para notes. stock_control_started_at continua sendo gravado uma única vez.';

-- Grants inalterados: já concedidos pelas migrations anteriores e não são
-- revogados por CREATE OR REPLACE (mesmo oid). Mesmo padrão já usado em
-- 202609070006_purchase_receiving_require_unit_cost.sql e 202609080002.

commit;
