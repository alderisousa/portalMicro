-- Reposicao Inteligente / Liberacao progressiva por loja
--
-- Problema: hoje existe UMA ordem consolidada por Market e a aprovacao e
-- global (market_approve_replenishment_order exige order.status='draft' e
-- valida TODAS as allocations de TODAS as lojas de uma vez). Isso obriga o
-- operador a revisar centenas de allocations de lojas que nao quer tocar
-- hoje so para poder comecar a comprar por UMA loja (ex.: Vitality).
--
-- Modelo adotado (menor mudanca segura, sem criar ordem por loja):
-- - Mantem-se UMA ordem/ciclo consolidado (market_replenishment_orders),
--   com approval_revision incrementando UMA UNICA VEZ por ciclo, na
--   PRIMEIRA liberacao (draft->approved), exatamente como ja acontecia na
--   aprovacao global. Liberacoes seguintes de outras lojas REUSAM essa
--   mesma approval_revision -- e o proprio trigger de consolidacao das
--   purchase_declarations (202609130002,
--   trg_market_replenishment_sync_purchase_declaration, chave
--   (order_id,product_id,approval_revision) com soma no ON CONFLICT) ja
--   soma corretamente entre lojas sem nenhuma alteracao: cada liberacao so
--   precisa inserir NOVAS operation_lines de compra para as allocations da
--   loja sendo liberada, e o trigger existente cuida do resto.
-- - A liberacao por loja passa a ser uma acao PROPRIA e ADITIVA:
--   market_release_replenishment_order_store. market_approve_replenishment_order
--   (aprovacao global, tudo de uma vez) continua exigindo status='draft' e
--   validando a ordem inteira, para quem nao quiser usar liberacao
--   progressiva -- mas precisou de UM ajuste minimo (item 2b abaixo): alem
--   do que ja fazia, tambem registra TODAS as lojas com allocation ativa em
--   market_replenishment_order_store_releases na nova revisao, porque a
--   nova market_replenishment_lifecycle_consistency_internal (item 4b) e
--   market_complete_replenishment_order_internal (item 8) passaram a
--   depender dessa tabela para saber o que ja foi operacionalizado. Regra
--   funcional: aprovacao global = todas as lojas da ordem liberadas naquela
--   revisao. As duas vias sao mutuamente exclusivas por ciclo: uma vez que
--   a primeira liberacao (por loja ou global) tira a ordem de 'draft', a
--   aprovacao global deixa de se aplicar a esse ciclo (comportamento ja
--   correto do guard existente, sem precisar de mudanca nele).
-- - "Liberado" e representado por uma tabela NOVA e explicita,
--   market_replenishment_order_store_releases (order_id,store_id unico),
--   nunca por market_replenishment_order_allocations.status (que continua
--   representando apenas o andamento fisico da allocation).
--
-- Contratos existentes que PRECISARAM ser adaptados (motivo objetivo):
-- 1) market_replenishment_guard_review_internal bloqueava QUALQUER escrita
--    em order_items/order_allocations quando order.status<>'draft'. Isso
--    tornaria uma loja ainda pendente IMEDIATAMENTE congelada assim que a
--    primeira loja fosse liberada -- o oposto do pedido. Adaptado para: em
--    order_allocations, UPDATE/DELETE de uma allocation cuja loja ja
--    conste em market_replenishment_order_store_releases (na revisao
--    atual) continua bloqueado (plano ja operacionalizado, congelado);
--    UPDATE/DELETE de allocation de loja AINDA NAO liberada continua
--    permitido mesmo com status in ('approved','in_progress'); INSERT
--    nunca e bloqueado por liberacao (item/allocation novos, ex.: inclusao
--    manual, nao conflitam com nada ja operacionalizado). Em order_items
--    (linha por produto, sem loja propria -- o rollup e recalculado a cada
--    revisao de UMA allocation, de QUALQUER loja), o gate passa a ser
--    "status nao terminal" (draft/approved/in_progress); a granularidade
--    fina por loja fica nas allocations e nas RPCs que tocam order_items
--    diretamente (abaixo).
-- 2) market_update_replenishment_allocation_review, market_add_replenishment_order_manual_item
--    e market_cancel_replenishment_order_item_review exigiam
--    status='draft' na propria RPC (antes mesmo do guard). Adaptadas: as
--    duas primeiras passam a aceitar status in
--    ('draft','approved','in_progress'); a revisao de allocation
--    adicionalmente barra loja ja liberada (mesma regra do guard, mensagem
--    dedicada REPLENISHMENT_ORDER_STORE_RELEASED); a retirada de item
--    passa a barrar explicitamente qualquer item que tenha allocation de
--    loja ja liberada (nao da para cancelar um item que ja virou operacao
--    real em outra loja).
-- 3) market_replenishment_guard_line_internal (trigger em operation_lines)
--    so permitia INSERT quando order.status='approved'. Isso bloquearia a
--    liberacao de uma segunda loja depois que a primeira ja tivesse
--    avancado para 'in_progress' (basta comecar a comprar/abastecer a
--    primeira loja). Adaptado para aceitar INSERT tambem com
--    status='in_progress', mantendo intactas as demais checagens
--    (approval_revision tem que bater com a da ordem, confirmed_quantity
--    tem que nascer em zero).
-- 4) market_complete_replenishment_order_internal so olhava se as
--    operation_lines JA CRIADAS estavam confirmadas -- uma loja nunca
--    liberada simplesmente nao tem operation_lines e passaria batido,
--    concluindo a ordem com necessidade real ainda pendente. Adicionado um
--    bloqueio explicito: nao completa enquanto existir allocation ativa de
--    loja ainda sem liberacao na revisao atual.
-- 4b) market_replenishment_lifecycle_consistency_internal e um CONSTRAINT
--    TRIGGER deferred em market_replenishment_orders (dispara no commit, ou
--    em SET CONSTRAINTS ALL IMMEDIATE) que, para qualquer status fora de
--    draft/cancelled, (a) roda market_replenishment_validate_plan_internal
--    para a ordem INTEIRA e (b) exige que operation_lines batam EXATAMENTE
--    com o esperado de TODAS as allocations ativas da ordem. Descoberto
--    durante os testes desta migration (nao estava no mapeamento inicial de
--    contratos lidos): com liberacao progressiva, uma loja pendente pode
--    legitimamente nao ter operation_lines nem revisao completa enquanto
--    outra ja foi liberada -- exatamente o que esse trigger, sem ajuste,
--    trata como corrupcao (REPLENISHMENT_ORDER_REVIEW_PENDING /
--    REPLENISHMENT_ORDER_TARGET_MISMATCH) a cada liberacao parcial. Sem
--    adaptar este trigger a liberacao progressiva simplesmente nao
--    funciona -- nao e um ajuste opcional.
--    Adaptado para o mesmo criterio ja usado nos demais pontos: a checagem
--    por allocation (equivalente a REVIEW_PENDING) e a comparacao
--    operation_lines-vs-esperado passam a considerar SOMENTE allocations de
--    lojas JA liberadas na revisao atual -- o que corresponde exatamente ao
--    que deve estar operacionalizado a essa altura. ALLOCATION_REQUIRED
--    (item sem nenhuma allocation ativa) e ALLOCATION_REVIEW_REQUIRED
--    (rollup do item vs soma de TODAS as allocations, incluindo lojas ainda
--    pendentes) saem do validate_plan_internal de dentro deste trigger por
--    dependerem de TODAS as lojas estarem revisadas -- ambos continuam
--    sendo aplicados integralmente por
--    market_approve_replenishment_order/market_complete_replenishment_order_internal,
--    que so chegam a chamar validate_plan_internal quando (por construcao)
--    todas as lojas relevantes ja estao liberadas.
create or replace function public.market_replenishment_lifecycle_consistency_internal()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders;
begin
    select * into v_order from public.market_replenishment_orders where id=new.id;
    if not found or v_order.status in ('draft','cancelled') then return null; end if;
    if exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        join public.market_replenishment_order_store_releases r on r.order_id=v_order.id and r.market_account_id=v_order.market_account_id
            and r.store_id=a.store_id and r.approval_revision=v_order.approval_revision
        where i.order_id=v_order.id and i.market_account_id=v_order.market_account_id and i.status<>'cancelled' and a.status<>'cancelled'
        and (
            coalesce(a.adjusted_quantity,a.suggested_quantity) is null or a.warehouse_allocated_quantity is null or a.purchase_needed_quantity is null
            or a.warehouse_allocated_quantity <> trunc(a.warehouse_allocated_quantity)
            or a.purchase_needed_quantity <> trunc(a.purchase_needed_quantity)
            or a.warehouse_allocated_quantity::text in ('NaN','Infinity','-Infinity')
            or a.purchase_needed_quantity::text in ('NaN','Infinity','-Infinity')
            or coalesce(a.adjusted_quantity,a.suggested_quantity) <> a.warehouse_allocated_quantity+a.purchase_needed_quantity
        )
    ) then raise exception 'REPLENISHMENT_ORDER_REVIEW_PENDING'; end if;
    if not exists (select 1 from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision) then
        raise exception 'REPLENISHMENT_ORDER_NO_OPERATION';
    end if;
    if exists (
        select 1 from (
            select a.id allocation_id,t.kind,t.quantity from public.market_replenishment_order_allocations a
            join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
            join public.market_replenishment_order_store_releases r on r.order_id=v_order.id and r.market_account_id=v_order.market_account_id
                and r.store_id=a.store_id and r.approval_revision=v_order.approval_revision
            cross join lateral (values ('warehouse',a.warehouse_allocated_quantity),('purchase',a.purchase_needed_quantity)) t(kind,quantity)
            where i.order_id=v_order.id and i.market_account_id=v_order.market_account_id and i.status<>'cancelled' and a.status<>'cancelled' and t.quantity>0
        ) expected
        full join (select * from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision) l
            on l.allocation_id=expected.allocation_id and l.operation_type=expected.kind
        where l.id is null or expected.allocation_id is null or l.target_quantity<>expected.quantity
    ) then raise exception 'REPLENISHMENT_ORDER_TARGET_MISMATCH'; end if;
    if v_order.status in ('in_progress','completed') and not exists (
        select 1 from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision
        and (started_at is not null or confirmed_quantity>0)
    ) then raise exception 'REPLENISHMENT_ORDER_EXECUTION_REQUIRED'; end if;
    if v_order.status='completed' and exists (
        select 1 from public.market_replenishment_operation_lines where order_id=v_order.id and approval_revision=v_order.approval_revision and confirmed_quantity<target_quantity
    ) then raise exception 'REPLENISHMENT_ORDER_INCOMPLETE'; end if;
    return null;
end;
$$;

-- 5) market_replenishment_physical_needs_internal (usada por
--    market_get_replenishment_store_supply e
--    market_execute_replenishment_store_supply) le todas as allocations
--    ativas de uma ordem approved+, sem checar liberacao -- uma loja NUNCA
--    liberada ja apareceria pronta para abastecimento. Como essa mesma
--    funcao tambem alimenta o Historico (202609150002) e o Historico
--    precisa continuar mostrando a necessidade real da lista mesmo antes
--    de qualquer liberacao (mesmo principio ja usado para "comprado mas
--    nao recebido" = pendente), o FILTRO por loja liberada foi aplicado
--    SOMENTE nos dois consumidores de abastecimento
--    (market_replenishment_supply_queue_internal e
--    market_execute_replenishment_store_supply), nunca na funcao em si nem
--    no Historico. Adicionalmente, a coluna born passou a refletir o
--    released_at real da loja quando houver liberacao registrada (antes
--    caia sempre no instante da aprovacao da revisao inteira) -- sem isso,
--    duas lojas liberadas em momentos diferentes empatariam no FIFO do
--    Galpao por terem a mesma approval_revision.
--
-- Preservado sem alteracao: market_replenishment_validate_plan_internal,
-- market_replenishment_guard_order_internal (a transicao draft->approved
-- da PRIMEIRA liberacao ja e exatamente a transicao que esse guard ja
-- aceitava), market_get_replenishment_purchasing (ja trabalha só a partir
-- de operation_lines, que agora so existem para loja liberada -- nada a
-- mudar), o trigger de consolidacao de purchase_declarations, NF, recibo,
-- eventos, RLS. market_approve_replenishment_order recebeu o ajuste minimo
-- descrito no item 2b (grava a liberacao de todas as lojas da ordem),
-- preservando integralmente o restante do seu comportamento original.

begin;

-- 1) Liberacao por loja: estrutura explicita, nunca allocation.status.
create table public.market_replenishment_order_store_releases (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null
        references public.market_accounts(id) on delete cascade,
    order_id uuid not null,
    store_id uuid not null,
    -- Guarda a revisao em que a loja foi liberada. Nao entra na chave unica
    -- (pedida como order_id+store_id) de proposito: uma reabertura+nova
    -- aprovacao da mesma ordem incrementa approval_revision, e o UPSERT
    -- abaixo detecta a revisao desatualizada e re-libera para o novo ciclo
    -- em vez de deixar um registro de liberacao "fantasma" de um ciclo
    -- anterior.
    approval_revision integer not null check (approval_revision > 0),
    released_at timestamptz not null default now(),
    released_by uuid null references auth.users(id) on delete set null,
    request_id uuid null,
    created_at timestamptz not null default now(),
    unique (order_id, store_id),
    foreign key (order_id, market_account_id)
        references public.market_replenishment_orders(id, market_account_id) on delete restrict,
    foreign key (store_id, market_account_id)
        references public.market_stores(id, market_account_id) on delete restrict
);
comment on table public.market_replenishment_order_store_releases is
'Liberacao operacional por loja dentro de uma ordem consolidada de reposicao. Representa que as allocations ativas daquela loja foram revisadas e ganharam operation_lines -- nunca redefine market_replenishment_order_allocations.status, que continua sendo o andamento fisico da allocation.';
create index idx_market_replenishment_store_releases_order
    on public.market_replenishment_order_store_releases (market_account_id, order_id);
alter table public.market_replenishment_order_store_releases enable row level security;
revoke all on public.market_replenishment_order_store_releases from public, anon, authenticated, service_role;
grant select on public.market_replenishment_order_store_releases to authenticated, service_role;
create policy market_replenishment_order_store_releases_select
on public.market_replenishment_order_store_releases for select
to authenticated
using (public.market_is_member(market_account_id) and public.market_can_access_store(store_id));

-- 2) Novo tipo de evento para auditoria da liberacao por loja.
alter table public.market_replenishment_order_events drop constraint market_replenishment_order_events_event_type_check;
alter table public.market_replenishment_order_events add constraint market_replenishment_order_events_event_type_check check(event_type in (
 'ORDER_CREATED','ORDER_APPROVED','ORDER_REOPENED','ORDER_CANCELLED','ORDER_SUPERSEDED',
 'WAREHOUSE_SEPARATION_STARTED','WAREHOUSE_QUANTITY_CONFIRMED','WAREHOUSE_SEPARATION_COMPLETED',
 'PURCHASE_STARTED','PURCHASE_QUANTITY_CONFIRMED','PURCHASE_COMPLETED','ORDER_COMPLETED',
 'PURCHASE_DECLARATION_CHANGED','PURCHASE_NF_LINKED','PURCHASE_CORRECTED','SUPPLY_EXECUTED',
 'ORDER_STORE_RELEASED'));

-- 2b) Aprovacao global (fluxo legado, sem passar por
--    market_release_replenishment_order_store) precisa deixar TODAS as
--    lojas com allocation ativa registradas em
--    market_replenishment_order_store_releases na nova approval_revision.
--    Sem isso, a nova market_replenishment_lifecycle_consistency_internal
--    (item 4b abaixo) rejeita a propria aprovacao no commit com
--    REPLENISHMENT_ORDER_TARGET_MISMATCH (o lado "expected" do full join,
--    que so considera allocation de loja ja liberada, fica vazio, mas as
--    operation_lines criadas alguns comandos abaixo existem) e
--    market_complete_replenishment_order_internal (item 8) nunca
--    conseguiria concluir a ordem por considerar toda loja "ainda sem
--    liberacao". Regra funcional adotada: aprovacao global = todas as
--    lojas da ordem liberadas naquela revisao. Resto do comportamento
--    preservado integralmente (mesmas validacoes, mesma ordem das
--    operacoes, mesmo evento ORDER_APPROVED, mesma reconciliacao de
--    recibos); o UPSERT usa o mesmo padrao ja usado em
--    market_release_replenishment_order_store (item 12 abaixo).
create or replace function public.market_approve_replenishment_order(
    p_market_account_id uuid,p_order_id uuid,p_request_id uuid default gen_random_uuid()
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders; v_revision integer;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if public.market_replenishment_request_replayed_internal(p_market_account_id,p_order_id,p_request_id,'ORDER_APPROVED','{}') then return p_order_id; end if;
    if v_order.status <> 'draft' then raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT'; end if;
    perform public.market_replenishment_validate_plan_internal(p_market_account_id,p_order_id);
    if not exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where i.order_id=p_order_id and i.market_account_id=p_market_account_id and i.status<>'cancelled' and a.status<>'cancelled'
          and (a.warehouse_allocated_quantity>0 or a.purchase_needed_quantity>0)
    ) then raise exception 'REPLENISHMENT_ORDER_NO_OPERATION'; end if;
    v_revision := v_order.approval_revision+1;
    update public.market_replenishment_orders set status='approved',approved_at=now(),approved_by=auth.uid(),
        approval_revision=v_revision,updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    insert into public.market_replenishment_operation_lines(market_account_id,order_id,allocation_id,approval_revision,operation_type,target_quantity)
    select p_market_account_id,p_order_id,a.id,v_revision,t.kind,t.quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    cross join lateral (values ('warehouse',a.warehouse_allocated_quantity),('purchase',a.purchase_needed_quantity)) t(kind,quantity)
    where i.order_id=p_order_id and i.market_account_id=p_market_account_id and i.status<>'cancelled' and a.status<>'cancelled' and t.quantity>0;
    -- Regra funcional: aprovacao global = todas as lojas da ordem liberadas
    -- naquela revisao (mesmo padrao de UPSERT de market_release_replenishment_order_store).
    insert into public.market_replenishment_order_store_releases (market_account_id, order_id, store_id, approval_revision, released_at, released_by, request_id)
    select distinct p_market_account_id, p_order_id, a.store_id, v_revision, now(), auth.uid(), p_request_id
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    where i.order_id=p_order_id and i.market_account_id=p_market_account_id and i.status<>'cancelled' and a.status<>'cancelled'
    on conflict (order_id, store_id) do update
        set approval_revision = excluded.approval_revision, released_at = now(), released_by = auth.uid(), request_id = excluded.request_id
        where public.market_replenishment_order_store_releases.approval_revision <> excluded.approval_revision;
    perform public.market_replenishment_emit_event_internal(p_market_account_id,p_order_id,'ORDER_APPROVED',p_request_id,'draft','approved',null,null,'{}');
    perform public.market_reconcile_replenishment_receipts_internal(p_market_account_id,
      array(select product_id from market_replenishment_order_items where order_id=p_order_id and market_account_id=p_market_account_id));
    return p_order_id;
end;
$$;

-- 3) Guard de revisao: por loja em order_allocations, "status nao terminal" em order_items.
create or replace function public.market_replenishment_guard_review_internal()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_order uuid; v_account uuid; v_status text; v_store uuid; v_revision integer;
begin
    if tg_table_name='market_replenishment_order_items' then
        if tg_op='UPDATE' and (new.id,new.order_id,new.market_account_id,new.product_id) is distinct from (old.id,old.order_id,old.market_account_id,old.product_id) then
            raise exception 'REPLENISHMENT_REVIEW_IDENTITY_IMMUTABLE';
        end if;
        if tg_op='DELETE' then v_order:=old.order_id; v_account:=old.market_account_id;
        else v_order:=new.order_id; v_account:=new.market_account_id; end if;
        select status into v_status from public.market_replenishment_orders where id=v_order and market_account_id=v_account for update;
        if v_status not in ('draft','approved','in_progress') then raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT'; end if;
    else
        if tg_op='UPDATE' and (new.id,new.order_item_id,new.market_account_id,new.store_id,new.candidate_id) is distinct from (old.id,old.order_item_id,old.market_account_id,old.store_id,old.candidate_id) then
            raise exception 'REPLENISHMENT_REVIEW_IDENTITY_IMMUTABLE';
        end if;
        if tg_op='DELETE' then
            v_store:=old.store_id;
            select order_id,market_account_id into v_order,v_account from public.market_replenishment_order_items where id=old.order_item_id;
        else
            v_store:=new.store_id;
            select order_id,market_account_id into v_order,v_account from public.market_replenishment_order_items where id=new.order_item_id;
        end if;
        select status,approval_revision into v_status,v_revision from public.market_replenishment_orders where id=v_order and market_account_id=v_account for update;
        if v_status not in ('draft','approved','in_progress') then
            raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT';
        end if;
        -- INSERT nunca esbarra em liberacao: allocation nova nao conflita com
        -- nada ja operacionalizado (ex.: inclusao manual para loja pendente).
        -- A liberacao so congela a allocation se pertencer a REVISAO ATUAL da
        -- ordem: uma liberacao de uma revisao anterior (reopen + nova
        -- aprovacao) nao pode continuar congelando a loja.
        if v_status <> 'draft' and tg_op in ('UPDATE','DELETE') and exists (
            select 1 from public.market_replenishment_order_store_releases r
            where r.order_id=v_order and r.market_account_id=v_account and r.store_id=v_store and r.approval_revision=v_revision
        ) then
            raise exception 'REPLENISHMENT_ORDER_STORE_RELEASED: loja ja liberada; allocation nao pode mais ser alterada.';
        end if;
    end if;
    if tg_op='DELETE' then return old; end if;
    return new;
end;
$$;

-- 4) operation_lines: liberar a segunda (ou N-esima) loja precisa poder
--    inserir novas linhas mesmo depois que a primeira ja colocou a ordem em
--    'in_progress' (bastou comecar a comprar/abastecer a loja ja liberada).
create or replace function public.market_replenishment_guard_line_internal()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders;
begin
    if tg_op='DELETE' then raise exception 'REPLENISHMENT_OPERATION_HISTORY_IMMUTABLE'; end if;
    select * into v_order from public.market_replenishment_orders where id=new.order_id and market_account_id=new.market_account_id for update;
    if not found or not exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where a.id=new.allocation_id and a.market_account_id=new.market_account_id and i.order_id=new.order_id
    ) then raise exception 'REPLENISHMENT_OPERATION_INVALID_ALLOCATION'; end if;
    if tg_op='INSERT' then
        if v_order.status not in ('approved','in_progress') or new.approval_revision <> v_order.approval_revision or new.confirmed_quantity <> 0 then
            raise exception 'REPLENISHMENT_OPERATION_INVALID_REVISION';
        end if;
        new.created_at := now(); new.created_by := auth.uid();
    else
        if (new.id,new.market_account_id,new.order_id,new.allocation_id,new.approval_revision,new.operation_type,new.target_quantity,new.created_at)
            is distinct from (old.id,old.market_account_id,old.order_id,old.allocation_id,old.approval_revision,old.operation_type,old.target_quantity,old.created_at) then
            raise exception 'REPLENISHMENT_OPERATION_TARGET_IMMUTABLE';
        end if;
        if (new.confirmed_quantity < old.confirmed_quantity and not (new.operation_type='purchase' and public.market_replenishment_correction_internal(new.market_account_id,new.order_id,new.id,new.confirmed_quantity))) or (old.started_at is not null and new.started_at is distinct from old.started_at) then
            raise exception 'REPLENISHMENT_OPERATION_PROGRESS_IMMUTABLE';
        end if;
        if v_order.status <> 'in_progress' or new.approval_revision <> v_order.approval_revision then raise exception 'REPLENISHMENT_OPERATION_INVALID_REVISION'; end if;
    end if;
    new.updated_at := now();
    return new;
end;
$$;

-- 5) Revisao de allocation: aceita status nao terminal, barra loja ja liberada.
create or replace function public.market_update_replenishment_allocation_review(
    p_market_account_id uuid,p_order_id uuid,p_allocation_id uuid,
    p_warehouse_quantity numeric,p_purchase_quantity numeric
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_order public.market_replenishment_orders; v_item uuid; v_store uuid; v_w numeric; v_p numeric;
begin
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order_id and market_account_id=p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;
    if v_order.status not in ('draft','approved','in_progress') then raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT'; end if;
    if p_warehouse_quantity is null or p_purchase_quantity is null or p_warehouse_quantity < 0 or p_purchase_quantity < 0
       or p_warehouse_quantity::text in ('NaN','Infinity','-Infinity') or p_purchase_quantity::text in ('NaN','Infinity','-Infinity') then
        raise exception 'REPLENISHMENT_ORDER_INVALID_QUANTITY';
    end if;
    v_w := ceil(p_warehouse_quantity); v_p := ceil(p_purchase_quantity);
    select i.id, a.store_id into v_item, v_store from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
    where a.id=p_allocation_id and i.order_id=p_order_id and i.market_account_id=p_market_account_id and a.status <> 'cancelled' and i.status <> 'cancelled';
    if not found then raise exception 'REPLENISHMENT_ORDER_ALLOCATION_NOT_FOUND'; end if;
    -- So congela se a liberacao pertencer a REVISAO ATUAL da ordem: uma
    -- liberacao de revisao anterior (reopen + nova aprovacao) nao pode
    -- continuar bloqueando a revisao desta allocation.
    if v_order.status <> 'draft' and exists (
        select 1 from public.market_replenishment_order_store_releases r
        where r.order_id=p_order_id and r.market_account_id=p_market_account_id and r.store_id=v_store and r.approval_revision=v_order.approval_revision
    ) then raise exception 'REPLENISHMENT_ORDER_STORE_RELEASED: loja ja liberada; plano nao pode mais ser alterado.'; end if;
    if v_w + coalesce((select sum(warehouse_allocated_quantity) from public.market_replenishment_order_allocations where order_item_id=v_item and id<>p_allocation_id and status<>'cancelled'),0)
        > (select greatest(coalesce(warehouse_stock_snapshot,0),0) from public.market_replenishment_order_items where id=v_item) then
        raise exception 'REPLENISHMENT_ORDER_WAREHOUSE_EXCEEDED';
    end if;
    update public.market_replenishment_order_allocations set adjusted_quantity=v_w+v_p,warehouse_allocated_quantity=v_w,purchase_needed_quantity=v_p,updated_at=now()
    where id=p_allocation_id and market_account_id=p_market_account_id;
    update public.market_replenishment_order_items i set
        total_suggested_quantity=t.need,suggested_purchase_quantity=t.purchase,adjusted_purchase_quantity=null,updated_at=now()
    from (
        select case when bool_or(coalesce(adjusted_quantity,suggested_quantity) is null) then null else sum(coalesce(adjusted_quantity,suggested_quantity)) end need,
            case when bool_or(purchase_needed_quantity is null) then null else sum(purchase_needed_quantity) end purchase
        from public.market_replenishment_order_allocations where order_item_id=v_item and market_account_id=p_market_account_id and status<>'cancelled'
    ) t where i.id=v_item and i.market_account_id=p_market_account_id;
    update public.market_replenishment_orders set updated_at=now(),updated_by=auth.uid() where id=p_order_id;
    return p_allocation_id;
end;
$$;

-- 6) Inclusao manual: aceita status nao terminal. Nao mexe em allocation
--    existente, entao nao precisa checar liberacao -- a nova allocation so
--    entra em operacao quando a loja for (re)liberada.
create or replace function public.market_add_replenishment_order_manual_item(
    p_market_account_id uuid,
    p_order_id uuid,
    p_product_id uuid,
    p_purchase_quantity numeric,
    p_store_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
    v_item_id uuid;
    v_warehouse_stock numeric(18,4);
    v_quantity numeric(18,4);
    v_from_warehouse numeric(18,4);
    v_purchase numeric(18,4);
begin
    if p_market_account_id is null or p_order_id is null or p_product_id is null or p_store_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id, order_id, product_id e store_id sao obrigatorios.';
    end if;

    if p_purchase_quantity is null or p_purchase_quantity < 0 or p_purchase_quantity::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'REPLENISHMENT_ORDER_INVALID_QUANTITY: quantidade manual deve ser maior ou igual a zero.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found or not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para revisar lista consolidada.';
        end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select o.* into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.id = p_order_id
    for update;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_NOT_FOUND: lista nao encontrada.';
    end if;

    if v_order.status not in ('draft','approved','in_progress') then
        raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT: lista nao esta em revisao.';
    end if;

    if not exists (
        select 1 from public.market_stores s
        where s.id = p_store_id
          and s.market_account_id = p_market_account_id
          and s.store_type = 'store'
          and s.status = 'active'
    ) then
        raise exception 'REPLENISHMENT_ORDER_STORE_UNAVAILABLE: loja nao encontrada ou inativa.';
    end if;

    if not exists (
        select 1
        from public.market_products p
        where p.market_account_id = p_market_account_id
          and p.id = p_product_id
          and p.status = 'active'
    ) then
        raise exception 'REPLENISHMENT_ORDER_PRODUCT_UNAVAILABLE: produto nao encontrado ou inativo.';
    end if;

    if exists (
        select 1
        from public.market_replenishment_order_items oi
        where oi.market_account_id = p_market_account_id
          and oi.order_id = p_order_id
          and oi.product_id = p_product_id
    ) then
        raise exception 'REPLENISHMENT_ORDER_DUPLICATE_PRODUCT: produto ja existe nesta lista.';
    end if;

    -- Mesma fonte e semantica do draft: snapshot desconhecido permanece NULL.
    select sum(b.quantity_on_hand)::numeric(18,4) into v_warehouse_stock
    from public.market_stock_balance b
    join public.market_stores s
      on s.id = b.market_store_id and s.market_account_id = b.market_account_id
    where b.market_account_id = p_market_account_id
      and b.product_id = p_product_id
      and s.store_type = 'warehouse';

    v_quantity := ceil(p_purchase_quantity)::numeric(18,4);
    v_from_warehouse := least(v_quantity, greatest(coalesce(v_warehouse_stock, 0), 0));
    v_purchase := v_quantity - v_from_warehouse;

    insert into public.market_replenishment_order_items (
        order_id,
        market_account_id,
        product_id,
        status,
        source,
        total_suggested_quantity,
        warehouse_stock_snapshot,
        suggested_purchase_quantity,
        adjusted_purchase_quantity
    ) values (
        p_order_id,
        p_market_account_id,
        p_product_id,
        'pending',
        'manual_review',
        v_quantity,
        v_warehouse_stock,
        v_purchase,
        null
    )
    returning id into v_item_id;

    insert into public.market_replenishment_order_allocations (
        order_item_id, market_account_id, store_id, candidate_id, status,
        suggested_quantity, warehouse_allocated_quantity, purchase_needed_quantity
    ) values (
        v_item_id, p_market_account_id, p_store_id, null, 'pending',
        v_quantity, v_from_warehouse, v_purchase
    );

    update public.market_replenishment_orders
    set updated_at = now(),
        updated_by = auth.uid()
    where id = p_order_id
      and market_account_id = p_market_account_id;

    return v_item_id;
end;
$$;

-- 7) Retirada de item: aceita status nao terminal, mas barra explicitamente
--    qualquer item que ja tenha allocation de loja liberada (nao da para
--    cancelar um item que ja virou operacao real em outra loja).
create or replace function public.market_cancel_replenishment_order_item_review(
    p_market_account_id uuid,
    p_order_id uuid,
    p_order_item_id uuid,
    p_cancellation_reason text default 'Retirado durante a revisao pre-compra'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
    v_reason text := nullif(btrim(coalesce(p_cancellation_reason, '')), '');
begin
    if p_market_account_id is null or p_order_id is null or p_order_item_id is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: market_account_id, order_id e order_item_id sao obrigatorios.';
    end if;

    if v_reason is null then
        raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: motivo de retirada e obrigatorio.';
    end if;

    if auth.uid() is not null then
        select m.* into v_member
        from public.market_account_members m
        where m.market_account_id = p_market_account_id
          and m.user_id = auth.uid()
          and m.status = 'active'
        order by m.created_at
        limit 1;

        if not found or not (
            v_member.role in ('owner','admin')
            or (v_member.role = 'manager' and v_member.all_stores = true)
        ) then
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para revisar lista consolidada.';
        end if;
    end if;

    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text,0));
    select o.* into v_order
    from public.market_replenishment_orders o
    where o.market_account_id = p_market_account_id
      and o.id = p_order_id
    for update;

    if not found then
        raise exception 'REPLENISHMENT_ORDER_NOT_FOUND: lista nao encontrada.';
    end if;

    if v_order.status not in ('draft','approved','in_progress') then
        raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT: lista nao esta em revisao.';
    end if;

    -- So barra a retirada se a loja estiver liberada na REVISAO ATUAL da
    -- ordem: uma liberacao de revisao anterior (reopen + nova aprovacao)
    -- nao pode continuar impedindo a retirada do item.
    if v_order.status <> 'draft' and exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_store_releases r
          on r.order_id = p_order_id and r.market_account_id = p_market_account_id and r.store_id = a.store_id
         and r.approval_revision = v_order.approval_revision
        where a.order_item_id = p_order_item_id and a.market_account_id = p_market_account_id and a.status <> 'cancelled'
    ) then
        raise exception 'REPLENISHMENT_ORDER_ITEM_PARTIALLY_RELEASED: existe loja ja liberada para este produto; a retirada do item inteiro nao e mais possivel.';
    end if;

    update public.market_replenishment_order_items
    set status = 'cancelled',
        review_cancelled_at = now(),
        review_cancelled_by = auth.uid(),
        review_cancellation_reason = v_reason,
        updated_at = now()
    where market_account_id = p_market_account_id
      and order_id = p_order_id
      and id = p_order_item_id
      and status <> 'cancelled';

    if not found then
        raise exception 'REPLENISHMENT_ORDER_ITEM_NOT_FOUND: item ativo nao encontrado.';
    end if;

    update public.market_replenishment_order_allocations
    set status = 'cancelled',
        cancelled_at = now(),
        cancellation_reason = v_reason,
        updated_at = now()
    where market_account_id = p_market_account_id
      and order_item_id = p_order_item_id
      and status <> 'cancelled';

    update public.market_replenishment_orders
    set updated_at = now(),
        updated_by = auth.uid()
    where id = p_order_id
      and market_account_id = p_market_account_id;

    return p_order_item_id;
end;
$$;

-- 8) Conclusao: nao completa enquanto existir loja relevante (allocation
--    ativa) ainda sem liberacao na revisao atual.
create or replace function public.market_complete_replenishment_order_internal(p_account uuid,p_order uuid,p_request uuid)
returns boolean language plpgsql set search_path = public as $$
declare v_order public.market_replenishment_orders; v_ordinal integer;
begin
    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_account::text,0));
    select * into v_order from public.market_replenishment_orders where id=p_order and market_account_id=p_account for update;
    if not found or v_order.status<>'in_progress' then return false; end if;
    if not exists (select 1 from public.market_replenishment_operation_lines where order_id=p_order and market_account_id=p_account and approval_revision=v_order.approval_revision)
       or exists (select 1 from public.market_replenishment_operation_lines where order_id=p_order and market_account_id=p_account and approval_revision=v_order.approval_revision and confirmed_quantity<target_quantity) then return false; end if;
    if exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id=a.order_item_id and i.market_account_id=a.market_account_id
        where i.order_id=p_order and i.market_account_id=p_account and i.status<>'cancelled' and a.status<>'cancelled'
        and not exists (
            select 1 from public.market_replenishment_order_store_releases r
            where r.order_id=p_order and r.market_account_id=p_account and r.store_id=a.store_id and r.approval_revision=v_order.approval_revision
        )
    ) then return false; end if;
    perform public.market_replenishment_validate_plan_internal(p_account,p_order);
    if p_request is null or exists (
        select 1 from public.market_replenishment_order_events where market_account_id=p_account and request_id=p_request
        and (order_id<>p_order or actor_user_id is distinct from auth.uid())
    ) then raise exception 'REPLENISHMENT_ORDER_REQUEST_CONFLICT'; end if;
    select coalesce(max(request_ordinal),0)+1 into v_ordinal from public.market_replenishment_order_events where market_account_id=p_account and request_id=p_request;
    update public.market_replenishment_orders set status='completed',completed_at=now(),completed_by=auth.uid(),updated_at=now(),updated_by=auth.uid() where id=p_order;
    perform public.market_replenishment_emit_event_internal(p_account,p_order,'ORDER_COMPLETED',p_request,'in_progress','completed',null,null,'{}',v_ordinal);
    return true;
end;
$$;

-- 9) FIFO de abastecimento: born passa a refletir o released_at real da
--    loja (quando houver liberacao), preservando ordem justa entre lojas
--    liberadas em momentos diferentes dentro da mesma approval_revision.
--    Continua incluindo TODAS as allocations ativas (Historico depende
--    disso); a restricao a loja liberada fica nos dois consumidores de
--    abastecimento, nao aqui.
create or replace function public.market_replenishment_physical_needs_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,revision integer,born timestamptz,
 target numeric,delivered numeric,remaining numeric,warehouse_line_id uuid)
language sql stable set search_path=public as $$
 select a.id,o.id,i.product_id,a.store_id,o.approval_revision,
 coalesce(
   (select r.released_at from market_replenishment_order_store_releases r
    where r.order_id=o.id and r.market_account_id=p_account and r.store_id=a.store_id and r.approval_revision=o.approval_revision),
   public.market_replenishment_approval_time_internal(p_account,o.id,o.approval_revision)
 ),
 coalesce(a.adjusted_quantity,a.suggested_quantity),coalesce(e.quantity,0),
 greatest(0,coalesce(a.adjusted_quantity,a.suggested_quantity)-coalesce(e.quantity,0)),w.id
 from market_replenishment_orders o join market_replenishment_order_items i on i.order_id=o.id and i.market_account_id=o.market_account_id
 join market_replenishment_order_allocations a on a.order_item_id=i.id and a.market_account_id=i.market_account_id
 left join market_replenishment_operation_lines w on w.allocation_id=a.id and w.approval_revision=o.approval_revision and w.operation_type='warehouse'
 left join lateral(select sum(quantity) quantity from market_replenishment_supply_executions where allocation_id=a.id and market_account_id=p_account) e on true
 where o.market_account_id=p_account and o.status in ('approved','in_progress','completed') and i.status<>'cancelled' and a.status<>'cancelled'
 and not exists(select 1 from market_replenishment_candidates c where c.id=a.candidate_id and c.priority_level='low');
$$;

create or replace function public.market_replenishment_supply_queue_internal(p_account uuid)
returns table(allocation_id uuid,order_id uuid,product_id uuid,store_id uuid,warehouse_line_id uuid,
 source_store_id uuid,target numeric,delivered numeric,remaining numeric,balance numeric,ready boolean)
language plpgsql stable set search_path=public as $$
declare n record; w record; v_balances jsonb:='{}'; v_blocked uuid[]:='{}'; v_available numeric; v_ready boolean;
begin
 for n in select q.* from public.market_replenishment_physical_needs_internal(p_account) q where q.remaining>0
   and exists (
     select 1 from market_replenishment_order_store_releases r
     where r.order_id=q.order_id and r.market_account_id=p_account and r.store_id=q.store_id and r.approval_revision=q.revision
   )
   order by q.product_id,q.born,q.order_id,q.allocation_id loop
   if n.product_id=any(v_blocked) then continue; end if;
   v_ready:=false;
   for w in select s.id,coalesce(b.quantity_on_hand,0) qty from market_stores s left join market_stock_balance b
     on b.market_store_id=s.id and b.market_account_id=s.market_account_id and b.product_id=n.product_id
     where s.market_account_id=p_account and s.store_type='warehouse' and s.status='active' order by s.id loop
     v_available:=coalesce((v_balances->>(n.product_id::text||':'||w.id::text))::numeric,greatest(0,w.qty));
     if v_available>=n.remaining then
       v_balances:=jsonb_set(v_balances,array[n.product_id::text||':'||w.id::text],to_jsonb(v_available-n.remaining));
       allocation_id:=n.allocation_id;order_id:=n.order_id;product_id:=n.product_id;store_id:=n.store_id;warehouse_line_id:=n.warehouse_line_id;
       source_store_id:=w.id;target:=n.target;delivered:=n.delivered;remaining:=n.remaining;balance:=w.qty;ready:=true;
       v_ready:=true; return next; exit;
     end if;
   end loop;
   if not v_ready then v_blocked:=array_append(v_blocked,n.product_id); end if;
 end loop;
end;
$$;

-- 10) Execucao do abastecimento: as duas leituras de physical_needs_internal
--     passam a exigir loja liberada, para que nao seja possivel abastecer
--     (nem via FIFO check) uma allocation de loja ainda pendente, mesmo
--     chamando a RPC diretamente com o allocation_id.
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
 if n.allocation_id is distinct from (
   select q.allocation_id from market_replenishment_physical_needs_internal(p_market_account_id) q
   where q.product_id=n.product_id and q.remaining>0
     and exists (select 1 from market_replenishment_order_store_releases r where r.order_id=q.order_id and r.market_account_id=p_market_account_id and r.store_id=q.store_id and r.approval_revision=q.revision)
   order by q.born,q.order_id,q.allocation_id limit 1
 ) then raise exception 'REPLENISHMENT_SUPPLY_FIFO_BLOCKED'; end if;
 if p_quantity<>n.remaining then raise exception 'REPLENISHMENT_SUPPLY_FULL_NEED_REQUIRED'; end if;
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

-- 11) Leitura da ordem: expoe releasedAt por allocation, para o front saber
--     o que esta liberado (congelado) e o que ainda esta em revisao.
create or replace function public.market_get_replenishment_order(
    p_market_account_id uuid,
    p_order_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_member public.market_account_members;
    v_order public.market_replenishment_orders;
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
            raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED: perfil sem autorizacao para ler lista consolidada.';
        end if;
    end if;

    if p_order_id is null then
        select o.* into v_order
        from public.market_replenishment_orders o
        where o.market_account_id = p_market_account_id
          and o.status in ('draft','approved','in_progress')
        order by o.created_at desc, o.id desc
        limit 1;
    else
        select o.* into v_order
        from public.market_replenishment_orders o
        where o.market_account_id = p_market_account_id
          and o.id = p_order_id;
    end if;

    if not found then
        return null;
    end if;

    return public.market_replenishment_order_contract_internal(p_market_account_id, v_order.id) || (
        with order_products as (
            select distinct oi.product_id
            from public.market_replenishment_order_items oi
            where oi.market_account_id = p_market_account_id
              and oi.order_id = v_order.id
        ),
        last_supplier_ranked as (
            select
                i.market_product_id as product_id,
                p.id as purchase_id,
                i.id as purchase_item_id,
                p.supplier_name,
                p.supplier_document,
                p.invoice_number,
                p.invoice_series,
                p.issued_at,
                i.received_at,
                m.occurred_at as operational_at,
                coalesce(m.unit_cost, i.stock_unit_cost) as unit_cost,
                row_number() over (
                    partition by i.market_product_id
                    order by
                        coalesce(p.issued_at, i.received_at, m.occurred_at) desc nulls last,
                        i.received_at desc nulls last,
                        m.occurred_at desc nulls last,
                        i.id desc
                ) as rn
            from order_products op
            join public.market_purchase_items i
              on i.market_account_id = p_market_account_id
             and i.market_product_id = op.product_id
             and i.stock_entry_status = 'received'
            join public.market_purchases p
              on p.id = i.market_purchase_id
             and p.market_account_id = i.market_account_id
             and p.status in ('receiving','completed')
            join public.market_stock_movements m
              on m.market_account_id = i.market_account_id
             and m.movement_type = 'PURCHASE'
             and m.reference_type = 'PURCHASE'
             and m.reference_id = p.id
             and m.reference_item_id = i.id
        ),
        last_supplier as (
            select *
            from last_supplier_ranked
            where rn = 1
        ),
        item_priority as (
            select
                oi.id as order_item_id,
                count(*) filter (where c.priority_level = 'critical') as critical_count,
                count(*) filter (where c.priority_level = 'high') as high_count,
                count(*) filter (where c.priority_level = 'medium') as medium_count,
                count(*) filter (where c.priority_level = 'low') as low_count,
                min(case c.priority_level
                    when 'critical' then 1
                    when 'high' then 2
                    when 'medium' then 3
                    else 4
                end) as priority_sort,
                min(c.rank_position) as best_rank_position
            from public.market_replenishment_order_items oi
            left join public.market_replenishment_order_allocations a
              on a.order_item_id = oi.id
             and a.market_account_id = oi.market_account_id
            left join public.market_replenishment_candidates c
              on c.id = a.candidate_id
             and c.market_account_id = a.market_account_id
            where oi.market_account_id = p_market_account_id
              and oi.order_id = v_order.id
            group by oi.id
        ),
        item_rows as (
            select
                oi.id,
                oi.product_id,
                pr.name as product_name,
                pr.sku,
                pr.ean,
                pr.unit,
                oi.status,
                oi.source,
                oi.total_suggested_quantity,
                oi.warehouse_stock_snapshot,
                oi.suggested_purchase_quantity,
                oi.adjusted_purchase_quantity,
                oi.purchased_quantity,
                oi.warehouse_surplus_quantity,
                oi.review_cancelled_at,
                oi.review_cancelled_by,
                oi.review_cancellation_reason,
                oi.created_at,
                oi.updated_at,
                coalesce(ip.critical_count, 0) as critical_count,
                coalesce(ip.high_count, 0) as high_count,
                coalesce(ip.medium_count, 0) as medium_count,
                coalesce(ip.low_count, 0) as low_count,
                coalesce(ip.priority_sort, 5) as priority_sort,
                ip.best_rank_position,
                ls.purchase_id,
                ls.purchase_item_id,
                ls.supplier_name,
                ls.supplier_document,
                ls.invoice_number,
                ls.invoice_series,
                ls.issued_at,
                ls.received_at,
                ls.operational_at,
                ls.unit_cost
            from public.market_replenishment_order_items oi
            join public.market_products pr
              on pr.id = oi.product_id
             and pr.market_account_id = oi.market_account_id
            left join item_priority ip on ip.order_item_id = oi.id
            left join last_supplier ls on ls.product_id = oi.product_id
            where oi.market_account_id = p_market_account_id
              and oi.order_id = v_order.id
        )
        select jsonb_build_object(
            'order', jsonb_build_object(
                'id', v_order.id,
                'marketAccountId', v_order.market_account_id,
                'runId', v_order.run_id,
                'status', v_order.status,
                'createdAt', v_order.created_at,
                'updatedAt', v_order.updated_at,
                'approvedAt', v_order.approved_at,
                'completedAt', v_order.completed_at,
                'cancelledAt', v_order.cancelled_at
            ),
            'items', coalesce((
                select jsonb_agg(
                    jsonb_build_object(
                        'id', ir.id,
                        'productId', ir.product_id,
                        'productName', ir.product_name,
                        'sku', ir.sku,
                        'ean', ir.ean,
                        'unit', ir.unit,
                        'status', ir.status,
                        'source', ir.source,
                        'totalSuggestedQuantity', ir.total_suggested_quantity,
                        'warehouseStockSnapshot', ir.warehouse_stock_snapshot,
                        'suggestedPurchaseQuantity', ir.suggested_purchase_quantity,
                        'adjustedPurchaseQuantity', ir.adjusted_purchase_quantity,
                        'effectivePurchaseQuantity', coalesce(ir.adjusted_purchase_quantity, ir.suggested_purchase_quantity),
                        'purchasedQuantity', ir.purchased_quantity,
                        'warehouseSurplusQuantity', ir.warehouse_surplus_quantity,
                        'reviewCancelledAt', ir.review_cancelled_at,
                        'reviewCancelledBy', ir.review_cancelled_by,
                        'reviewCancellationReason', ir.review_cancellation_reason,
                        'priority', jsonb_build_object(
                            'criticalCount', ir.critical_count,
                            'highCount', ir.high_count,
                            'mediumCount', ir.medium_count,
                            'lowCount', ir.low_count,
                            'prioritySort', ir.priority_sort,
                            'bestRankPosition', ir.best_rank_position
                        ),
                        'lastSupplier', case
                            when ir.purchase_item_id is null then null
                            else jsonb_build_object(
                                'supplierName', ir.supplier_name,
                                'supplierDocument', ir.supplier_document,
                                'invoiceNumber', ir.invoice_number,
                                'invoiceSeries', ir.invoice_series,
                                'issuedAt', ir.issued_at,
                                'receivedAt', ir.received_at,
                                'operationalAt', ir.operational_at,
                                'unitCost', ir.unit_cost,
                                'purchaseId', ir.purchase_id,
                                'purchaseItemId', ir.purchase_item_id
                            )
                        end,
                        'allocations', coalesce((
                            select jsonb_agg(
                                jsonb_build_object(
                                    'id', a.id,
                                    'storeId', a.store_id,
                                    'storeName', s.name,
                                    'candidateId', a.candidate_id,
                                    'status', a.status,
                                    'suggestedQuantity', a.suggested_quantity,
                                    'adjustedQuantity', a.adjusted_quantity,
                                    'warehouseAllocatedQuantity', a.warehouse_allocated_quantity,
                                    'purchaseNeededQuantity', a.purchase_needed_quantity,
                                    'priorityLevel', c.priority_level,
                                    'rankPosition', c.rank_position,
                                    'releasedAt', rel.released_at
                                )
                                order by
                                    case c.priority_level
                                        when 'critical' then 1
                                        when 'high' then 2
                                        when 'medium' then 3
                                        else 4
                                    end,
                                    c.rank_position,
                                    s.name,
                                    a.id
                            )
                            from public.market_replenishment_order_allocations a
                            join public.market_stores s
                              on s.id = a.store_id
                             and s.market_account_id = a.market_account_id
                            left join public.market_replenishment_candidates c
                              on c.id = a.candidate_id
                             and c.market_account_id = a.market_account_id
                            left join public.market_replenishment_order_store_releases rel
                              on rel.order_id = v_order.id
                             and rel.market_account_id = p_market_account_id
                             and rel.store_id = a.store_id
                             and rel.approval_revision = v_order.approval_revision
                            where a.market_account_id = p_market_account_id
                              and a.order_item_id = ir.id
                        ), '[]'::jsonb)
                    )
                    order by ir.priority_sort, ir.best_rank_position nulls last, ir.product_name, ir.id
                )
                from item_rows ir
            ), '[]'::jsonb)
        )
    );
end;
$$;

-- 12) Nova RPC: libera UMA loja dentro da ordem consolidada.
create or replace function public.market_release_replenishment_order_store(
    p_market_account_id uuid,
    p_order_id uuid,
    p_store_id uuid,
    p_request_id uuid default gen_random_uuid()
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_order public.market_replenishment_orders;
    v_revision integer;
    v_first_release boolean := false;
    v_alloc record;
    v_product record;
begin
    if auth.uid() is null then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;
    perform public.market_replenishment_assert_access_internal(p_market_account_id);
    if p_store_id is null then raise exception 'REPLENISHMENT_ORDER_INVALID_INPUT: store_id e obrigatorio.'; end if;

    perform pg_advisory_xact_lock(hashtextextended('market-replenishment-order-draft:' || p_market_account_id::text, 0));

    select * into v_order from public.market_replenishment_orders where id = p_order_id and market_account_id = p_market_account_id for update;
    if not found then raise exception 'REPLENISHMENT_ORDER_NOT_FOUND'; end if;

    if public.market_replenishment_request_replayed_internal(p_market_account_id, p_order_id, p_request_id, 'ORDER_STORE_RELEASED', jsonb_build_object('storeId', p_store_id)) then
        return p_order_id;
    end if;

    if v_order.status not in ('draft','approved','in_progress') then
        raise exception 'REPLENISHMENT_ORDER_NOT_DRAFT: lista nao esta em estado compativel com liberacao.';
    end if;

    if not exists (select 1 from public.market_stores s where s.id = p_store_id and s.market_account_id = p_market_account_id and s.store_type = 'store') then
        raise exception 'REPLENISHMENT_ORDER_STORE_UNAVAILABLE';
    end if;
    if not public.market_can_access_store(p_store_id) then raise exception 'REPLENISHMENT_ORDER_PERMISSION_DENIED'; end if;

    v_revision := v_order.approval_revision;
    v_first_release := v_order.status = 'draft';

    if not exists (
        select 1 from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id = a.order_item_id and i.market_account_id = a.market_account_id
        where a.market_account_id = p_market_account_id and i.order_id = p_order_id and a.store_id = p_store_id
          and i.status <> 'cancelled' and a.status <> 'cancelled'
    ) then
        raise exception 'REPLENISHMENT_ORDER_STORE_NO_ALLOCATIONS: loja sem necessidades ativas nesta lista.';
    end if;

    -- 4/6: cada allocation ativa da loja precisa estar totalmente revisada
    -- (necessidade conhecida, Galpao e Compra definidos, inteiros, somando
    -- exatamente a necessidade). Detalhe estruturado (allocationId/storeId/
    -- productId) para o front navegar direto ao item com problema.
    for v_alloc in
        select a.id as allocation_id, i.product_id
        from public.market_replenishment_order_allocations a
        join public.market_replenishment_order_items i on i.id = a.order_item_id and i.market_account_id = a.market_account_id
        where a.market_account_id = p_market_account_id and i.order_id = p_order_id and a.store_id = p_store_id
          and i.status <> 'cancelled' and a.status <> 'cancelled'
          and (
            coalesce(a.adjusted_quantity, a.suggested_quantity) is null
            or a.warehouse_allocated_quantity is null
            or a.purchase_needed_quantity is null
            or a.warehouse_allocated_quantity <> trunc(a.warehouse_allocated_quantity)
            or a.purchase_needed_quantity <> trunc(a.purchase_needed_quantity)
            or a.warehouse_allocated_quantity::text in ('NaN','Infinity','-Infinity')
            or a.purchase_needed_quantity::text in ('NaN','Infinity','-Infinity')
            or coalesce(a.adjusted_quantity, a.suggested_quantity) <> a.warehouse_allocated_quantity + a.purchase_needed_quantity
          )
        order by i.product_id, a.id
        limit 1
    loop
        raise exception 'REPLENISHMENT_RELEASE_REVIEW_PENDING: existe necessidade sem revisao completa nesta loja.'
            using detail = jsonb_build_object('allocationId', v_alloc.allocation_id, 'storeId', p_store_id, 'productId', v_alloc.product_id)::text;
    end loop;

    -- 6: saldo de Galpao consolidado (lojas ja liberadas nesta revisao + esta
    -- loja), por produto relevante para a loja sendo liberada.
    for v_product in
        select i.id as item_id, i.product_id, i.warehouse_stock_snapshot,
            coalesce(sum(a.warehouse_allocated_quantity) filter (where a.store_id = p_store_id), 0) as this_store_warehouse,
            coalesce(sum(a.warehouse_allocated_quantity) filter (
                where a.store_id <> p_store_id and exists (
                    select 1 from public.market_replenishment_order_store_releases r
                    where r.order_id = p_order_id and r.market_account_id = p_market_account_id
                      and r.store_id = a.store_id and r.approval_revision = v_revision
                )
            ), 0) as other_released_warehouse
        from public.market_replenishment_order_items i
        join public.market_replenishment_order_allocations a on a.order_item_id = i.id and a.market_account_id = i.market_account_id
        where i.market_account_id = p_market_account_id and i.order_id = p_order_id and i.status <> 'cancelled' and a.status <> 'cancelled'
          and i.product_id in (
              select i2.product_id from public.market_replenishment_order_items i2
              join public.market_replenishment_order_allocations a2 on a2.order_item_id = i2.id and a2.market_account_id = i2.market_account_id
              where i2.market_account_id = p_market_account_id and i2.order_id = p_order_id and a2.store_id = p_store_id
                and i2.status <> 'cancelled' and a2.status <> 'cancelled'
          )
        group by i.id, i.product_id, i.warehouse_stock_snapshot
        having coalesce(sum(a.warehouse_allocated_quantity) filter (where a.store_id = p_store_id), 0)
             + coalesce(sum(a.warehouse_allocated_quantity) filter (
                 where a.store_id <> p_store_id and exists (
                     select 1 from public.market_replenishment_order_store_releases r
                     where r.order_id = p_order_id and r.market_account_id = p_market_account_id
                       and r.store_id = a.store_id and r.approval_revision = v_revision
                 )
               ), 0)
           > greatest(coalesce(i.warehouse_stock_snapshot, 0), 0)
        limit 1
    loop
        raise exception 'REPLENISHMENT_RELEASE_WAREHOUSE_EXCEEDED: saldo do Galpao insuficiente para as lojas ja liberadas mais esta liberacao.'
            using detail = jsonb_build_object('productId', v_product.product_id, 'storeId', p_store_id,
                'requestedWarehouse', v_product.this_store_warehouse + v_product.other_released_warehouse,
                'availableWarehouse', greatest(coalesce(v_product.warehouse_stock_snapshot, 0), 0))::text;
    end loop;

    if v_first_release then
        update public.market_replenishment_orders
        set status = 'approved', approved_at = now(), approved_by = auth.uid(),
            approval_revision = approval_revision + 1, updated_at = now(), updated_by = auth.uid()
        where id = p_order_id;
        v_revision := v_revision + 1;
    else
        update public.market_replenishment_orders set updated_at = now(), updated_by = auth.uid() where id = p_order_id;
    end if;

    -- 7/8: operation_lines somente para o que ainda nao existe nesta
    -- revisao -- cobre tanto a primeira liberacao da loja quanto uma
    -- re-liberacao para pegar allocation nova (ex.: item manual incluido
    -- depois), sem duplicar em retry.
    insert into public.market_replenishment_operation_lines(market_account_id, order_id, allocation_id, approval_revision, operation_type, target_quantity)
    select p_market_account_id, p_order_id, a.id, v_revision, t.kind, t.quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id = a.order_item_id and i.market_account_id = a.market_account_id
    cross join lateral (values ('warehouse', a.warehouse_allocated_quantity), ('purchase', a.purchase_needed_quantity)) t(kind, quantity)
    where i.order_id = p_order_id and i.market_account_id = p_market_account_id and a.store_id = p_store_id
      and i.status <> 'cancelled' and a.status <> 'cancelled' and t.quantity > 0
      and not exists (
          select 1 from public.market_replenishment_operation_lines ol
          where ol.allocation_id = a.id and ol.approval_revision = v_revision and ol.operation_type = t.kind
      );

    insert into public.market_replenishment_order_store_releases (market_account_id, order_id, store_id, approval_revision, released_at, released_by, request_id)
    values (p_market_account_id, p_order_id, p_store_id, v_revision, now(), auth.uid(), p_request_id)
    on conflict (order_id, store_id) do update
        set approval_revision = excluded.approval_revision, released_at = now(), released_by = auth.uid(), request_id = excluded.request_id
        where public.market_replenishment_order_store_releases.approval_revision <> excluded.approval_revision;

    perform public.market_replenishment_emit_event_internal(p_market_account_id, p_order_id, 'ORDER_STORE_RELEASED', p_request_id, null, null, null, null,
        jsonb_build_object('storeId', p_store_id), 1);
    if v_first_release then
        perform public.market_replenishment_emit_event_internal(p_market_account_id, p_order_id, 'ORDER_APPROVED', p_request_id, 'draft','approved', null, null, '{}', 2);
    end if;

    return p_order_id;
end;
$$;

revoke all on function public.market_release_replenishment_order_store(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.market_release_replenishment_order_store(uuid, uuid, uuid, uuid) to authenticated;

commit;
