-- Aplicação MANUAL. Último item funcional da Sprint de Estoque: inventário
-- multiusuário. NÃO altera 202609080002/003/004 — is_counted, reason_code/
-- reason_note, regras 3/4/5 (obrigatoriedade e sentido do motivo) e toda a
-- reconciliação de saldo em market_finalize_inventory_draft continuam
-- exatamente como estão, porque esta migration NÃO recria essa função.
--
-- Problema resolvido: market_save_inventory_draft grava o rascunho como um
-- ARRAY COMPLETO (DELETE de todos os itens da sessão + INSERT do array
-- inteiro enviado pelo cliente). Dois operadores contando produtos
-- diferentes na MESMA sessão colidiam por causa disso: o autosave de A
-- nunca conhece o item que B acabou de adicionar (e vice-versa), então
-- qualquer um dos dois apagava o item do outro ao salvar — mitigado até
-- hoje só pelo conflito de version da SESSÃO inteira (que bloqueia os dois,
-- em vez de deixar cada produto coexistir).
--
-- Solução: concorrência por ITEM, não por sessão inteira.
--   1) market_inventory_session_items ganha uma coluna version própria
--      (independente de market_inventory_sessions.version, que continua
--      servindo só para started_at e para status/finalize/cancel).
--   2) market_save_inventory_item (NOVA): grava/atualiza UM produto por vez,
--      comparando a version esperada daquele item especificamente. Produtos
--      diferentes nunca disputam a mesma linha — sem lock cruzado entre eles.
--   3) market_remove_inventory_item (NOVA): remove um item específico da
--      contagem (usado só em inventário 'cycle', "Remover da contagem"),
--      mesma checagem de version.
--   4) market_get_inventory_draft: passa a devolver version por item, além
--      dos campos já existentes.
--   5) market_save_inventory_draft: PARA DE GRAVAR ITENS. Continua existindo
--      (criação da sessão e atualização de started_at, únicas finalidades
--      que ainda fazem sentido para uma RPC de escopo de sessão), mas agora
--      rejeita explicitamente qualquer payload não-vazio em p_items — em vez
--      de ignorá-lo silenciosamente, o que esconderia um cliente antigo
--      ainda tentando usar o fluxo de array completo. O retorno de 'items'
--      passa a ser sempre uma leitura do estado JÁ persistido na tabela
--      (nunca escreve/apaga nada em market_inventory_session_items).
--
-- Concorrência/locks: market_save_inventory_item e market_remove_inventory_item
-- travam (FOR UPDATE) a SESSÃO (não a loja — esta RPC nunca grava em
-- market_stock_movements nem cria sessão) e, quando a linha já existe, a
-- LINHA DO ITEM. Travar a sessão aqui não serializa item contra item (dois
-- produtos diferentes continuam sendo duas transações curtas e independentes
-- na fila do mesmo lock, sem conflito de version), mas fecha exatamente a
-- janela de corrida com market_finalize_inventory_draft/market_cancel_inventory_draft
-- (que também travam a sessão antes da loja): uma escrita de item que ganhe
-- a corrida do lock é ou totalmente vista pela finalização (se travar
-- primeiro) ou corretamente rejeitada com INVENTORY_DRAFT_UNAVAILABLE (se a
-- sessão já não estiver mais 'draft' quando finalmente travar).
--
-- Semântica definitiva de "contado zero" (revista nesta mesma migration,
-- ainda não aplicada — não é uma mudança retroativa em cima de 002/003):
-- "não contado" (is_counted=false) é produto ainda não conferido; "contado
-- como zero" (is_counted=true, quantity=0) é produto já conferido
-- fisicamente e encontrado com estoque zero. market_save_inventory_item
-- SEMPRE persiste os dois casos, em 'initial' ou 'cycle' — essencial no
-- multiusuário: é a única forma de outro operador distinguir os dois
-- estados ao sincronizar. market_finalize_inventory_draft (não alterada)
-- já filtra quantity>0 para decidir o que gera movimento; nenhum
-- movimento novo é gerado por causa desta mudança.
--
-- Compatibilidade com drafts existentes: version novo recebe DEFAULT 1 —
-- toda linha já existente passa a ter version=1 automaticamente, sem
-- backfill manual, mesmo padrão já usado em 202609080003.
begin;

alter table public.market_inventory_session_items
  add column version integer not null default 1;

comment on column public.market_inventory_session_items.version is
  'Concorrência otimista POR ITEM (202609080005) — independente de market_inventory_sessions.version, que segue reservado para started_at e transições de status/finalize/cancel. Incrementado a cada update bem-sucedido deste item.';

-- Mesmo corpo de 202609080003, só acrescentando version por item no retorno.
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
            'reasonCode', i.reason_code, 'reasonNote', i.reason_note, 'version', i.version
        ) order by i.created_at, i.product_id)
        from public.market_inventory_session_items i where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
end;
$$;

-- Deixa de gravar itens. Mantida só para criar a sessão (session_id null) e
-- atualizar started_at de uma sessão existente — as duas únicas finalidades
-- de escopo de sessão que ainda fazem sentido aqui. Rejeita explicitamente
-- qualquer payload de itens não-vazio, em vez de ignorá-lo silenciosamente:
-- um cliente antigo tentando reusar o fluxo de array completo falha alto,
-- nunca escreve/apaga itens por engano.
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
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if p_started_at is null then raise exception 'INVENTORY_INVALID_DRAFT: data invalida.'; end if;
    if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
        raise exception 'INVENTORY_INVALID_DRAFT: uso do array completo de itens foi descontinuado; use market_save_inventory_item.';
    end if;

    -- A loja continua sendo o ponto de serializacao para criar a sessao e
    -- decidir inventory_type — nao para itens, que nao passam mais por aqui.
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
    end if;

    -- 'items' abaixo e sempre uma LEITURA do estado ja persistido — esta RPC
    -- nunca insere/atualiza/apaga linhas de market_inventory_session_items.
    return jsonb_build_object(
        'id', v_session.id, 'marketAccountId', v_session.market_account_id,
        'marketStoreId', v_session.market_store_id, 'inventoryType', v_session.inventory_type,
        'status', v_session.status, 'startedAt', v_session.started_at,
        'version', v_session.version, 'createdAt', v_session.created_at,
        'updatedAt', v_session.updated_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'productId', i.product_id, 'quantity', i.quantity, 'isCounted', i.is_counted,
            'reasonCode', i.reason_code, 'reasonNote', i.reason_note, 'version', i.version
        ) order by i.created_at, i.product_id) from public.market_inventory_session_items i
            where i.inventory_session_id = v_session.id), '[]'::jsonb)
    );
exception when unique_violation then
    raise exception 'INVENTORY_DRAFT_CONFLICT: ja existe inventario em andamento para esta loja.';
end;
$$;

-- NOVA: unidade de concorrência = UM produto. Nunca substitui a coleção
-- inteira; nunca toca em outro product_id da mesma sessão. Retorna sempre
-- jsonb estruturado (nunca "raise" para conflito de version — conflito é
-- resultado normal do fluxo, não erro): {"conflict": false, "item": {...|null}}
-- em sucesso, {"conflict": true, "serverItem": {...|null}} quando a version
-- informada não bate com a atual (serverItem null = item foi removido por
-- outro usuário desde a última leitura do chamador).
create or replace function public.market_save_inventory_item(
    p_inventory_session_id uuid,
    p_product_id uuid,
    p_quantity numeric,
    p_is_counted boolean,
    p_reason_code text,
    p_reason_note text,
    p_expected_item_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_session public.market_inventory_sessions;
    v_member public.market_account_members;
    v_item public.market_inventory_session_items;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if p_product_id is null or p_is_counted is null or p_quantity is null or p_quantity < 0 then
        raise exception 'INVENTORY_ITEM_INVALID: produto ou quantidade invalidos.';
    end if;

    -- Trava a SESSAO (nao a loja: esta RPC nunca grava market_stock_movements
    -- nem cria sessao). Isso serializa contra finalize/cancel da mesma sessao
    -- (que tambem travam a sessao antes de qualquer coisa) sem serializar
    -- produtos diferentes entre si — cada chamada e uma transacao curta.
    select * into v_session from public.market_inventory_sessions
    where id = p_inventory_session_id for update;
    if not found or v_session.status <> 'draft' then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.';
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
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_session.market_store_id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    if not exists (
        select 1 from public.market_products p
        where p.id = p_product_id and p.market_account_id = v_session.market_account_id and p.status = 'active'
    ) then raise exception 'INVENTORY_INVALID_PRODUCT: produto invalido ou de outra conta.'; end if;

    -- Trava a linha do item (se existir) — checagem-e-escrita de version
    -- atomica, sem afetar nenhum outro produto da sessao.
    select * into v_item from public.market_inventory_session_items
    where inventory_session_id = v_session.id and product_id = p_product_id
    for update;

    if found then
        if p_expected_item_version is null or v_item.version <> p_expected_item_version then
            return jsonb_build_object('conflict', true, 'serverItem', jsonb_build_object(
                'productId', v_item.product_id, 'quantity', v_item.quantity, 'isCounted', v_item.is_counted,
                'reasonCode', v_item.reason_code, 'reasonNote', v_item.reason_note, 'version', v_item.version
            ));
        end if;
    elsif p_expected_item_version is not null then
        -- Cliente acreditava que ja existia uma versao deste item, mas ele
        -- nao existe mais (removido por outro usuario) — conflito explicito,
        -- nunca assume silenciosamente "entao e novo".
        return jsonb_build_object('conflict', true, 'serverItem', null);
    end if;

    -- Regra definitiva (revista nesta mesma migration, ainda nao aplicada):
    -- contado como zero (is_counted=true, quantity=0) SEMPRE e persistido,
    -- em 'initial' ou 'cycle' — e a unica forma de distinguir "ninguem
    -- contou este produto ainda" (is_counted=false, nunca grava linha) de
    -- "ja foi conferido fisicamente e o estoque e zero" (is_counted=true,
    -- quantity=0, precisa existir na tabela para outro usuario ver isso ao
    -- sincronizar). market_finalize_inventory_draft (202609080002/003, nao
    -- alterada) ja filtra quantity>0 para decidir o que entra em
    -- market_start_stock_control/na reconciliacao de 'initial' — nenhum
    -- movimento passa a ser gerado por causa desta mudanca, so o rascunho
    -- passa a registrar o zero contado tambem em sessoes 'initial'.
    if found then
        update public.market_inventory_session_items set
            quantity = p_quantity, is_counted = p_is_counted,
            reason_code = nullif(btrim(p_reason_code), ''), reason_note = nullif(btrim(p_reason_note), ''),
            version = version + 1, updated_at = now()
        where id = v_item.id
        returning * into v_item;
    else
        insert into public.market_inventory_session_items (
            market_account_id, inventory_session_id, product_id, quantity, is_counted, reason_code, reason_note
        ) values (
            v_session.market_account_id, v_session.id, p_product_id, p_quantity, p_is_counted,
            nullif(btrim(p_reason_code), ''), nullif(btrim(p_reason_note), '')
        ) returning * into v_item;
    end if;

    return jsonb_build_object('conflict', false, 'item', jsonb_build_object(
        'productId', v_item.product_id, 'quantity', v_item.quantity, 'isCounted', v_item.is_counted,
        'reasonCode', v_item.reason_code, 'reasonNote', v_item.reason_note, 'version', v_item.version
    ));
end;
$$;

-- NOVA: remove um item especifico da contagem (usado hoje só em 'cycle',
-- "Remover da contagem"). Idempotente quando o item ja nao existe (o estado
-- final desejado — item ausente — ja e verdade). Conflito quando a version
-- informada nao bate com a atual, nunca apaga silenciosamente uma
-- atualizacao mais nova feita por outro usuario.
create or replace function public.market_remove_inventory_item(
    p_inventory_session_id uuid,
    p_product_id uuid,
    p_expected_item_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_session public.market_inventory_sessions;
    v_member public.market_account_members;
    v_item public.market_inventory_session_items;
begin
    if auth.uid() is null then raise exception 'INVENTORY_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if p_product_id is null then raise exception 'INVENTORY_ITEM_INVALID: produto invalido.'; end if;

    select * into v_session from public.market_inventory_sessions
    where id = p_inventory_session_id for update;
    if not found or v_session.status <> 'draft' then
        raise exception 'INVENTORY_DRAFT_UNAVAILABLE: rascunho inexistente ou encerrado.';
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
        where ms.market_account_member_id = v_member.id and ms.market_store_id = v_session.market_store_id
    )) then raise exception 'INVENTORY_STORE_NOT_ALLOWED: usuario sem acesso a loja.'; end if;

    select * into v_item from public.market_inventory_session_items
    where inventory_session_id = v_session.id and product_id = p_product_id
    for update;

    if not found then
        return jsonb_build_object('conflict', false, 'removed', true);
    end if;

    if p_expected_item_version is null or v_item.version <> p_expected_item_version then
        return jsonb_build_object('conflict', true, 'serverItem', jsonb_build_object(
            'productId', v_item.product_id, 'quantity', v_item.quantity, 'isCounted', v_item.is_counted,
            'reasonCode', v_item.reason_code, 'reasonNote', v_item.reason_note, 'version', v_item.version
        ));
    end if;

    delete from public.market_inventory_session_items where id = v_item.id;
    return jsonb_build_object('conflict', false, 'removed', true);
end;
$$;

comment on function public.market_save_inventory_draft(uuid,uuid,integer,timestamptz,jsonb) is
  'Cria a sessao de inventario (session_id null) ou atualiza started_at de uma sessao existente. Nao grava mais itens (202609080005) — rejeita explicitamente p_items nao-vazio. Itens sao geridos por market_save_inventory_item/market_remove_inventory_item, uma unidade de concorrencia por produto.';
comment on function public.market_save_inventory_item(uuid,uuid,numeric,boolean,text,text,integer) is
  'Grava UM item da sessao (unidade de concorrencia = produto). Compara version esperada da linha; sem conflito, insere ou atualiza e incrementa version; em conflito, devolve o estado atual do servidor (serverItem) sem alterar nada. Contado como zero (is_counted=true, quantity=0) SEMPRE e persistido, em initial ou cycle — e o que distingue "nao contado" de "contado e zero" para outro usuario ao sincronizar.';
comment on function public.market_remove_inventory_item(uuid,uuid,integer) is
  'Remove um item especifico da contagem (ex.: "Remover da contagem" em inventario cycle). Idempotente se o item ja nao existir; conflito se a version informada nao bater com a atual.';

-- Grants: market_save_inventory_draft e market_get_inventory_draft mantêm a
-- MESMA assinatura de sempre — mesmo oid, GRANTs já concedidos preservados
-- por CREATE OR REPLACE (mesmo padrão de 202609080002/003/004). As duas
-- funções novas precisam de grant explícito, por serem objetos novos.
revoke all on function public.market_save_inventory_item(uuid,uuid,numeric,boolean,text,text,integer) from public;
revoke all on function public.market_remove_inventory_item(uuid,uuid,integer) from public;
grant execute on function public.market_save_inventory_item(uuid,uuid,numeric,boolean,text,text,integer) to authenticated;
grant execute on function public.market_remove_inventory_item(uuid,uuid,integer) to authenticated;

commit;
