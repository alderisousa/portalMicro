-- GiroMicro Market - Sprint 3B.2A: lojas e galpoes como locais de estoque.
-- Preserva as lojas atuais, reutiliza o motor de inventario e impede que um
-- warehouse participe de fluxos comerciais ou receba movimentos SALE.
begin;

alter table public.market_stores
    add column store_type text not null default 'store';

alter table public.market_stores
    add constraint market_stores_store_type_check
    check (store_type in ('store','warehouse'));

comment on table public.market_stores is
    'Locais operacionais do Market. store representa loja com venda; warehouse representa galpao/deposito sem venda direta.';

comment on column public.market_stores.store_type is
    'Tipo do local de estoque: store (loja) ou warehouse (galpao/deposito).';

create index ix_market_stores_account_type_status
    on public.market_stores (market_account_id, store_type, status, name);

-- Uma unidade com historico comercial nao pode ser reclassificada como
-- warehouse. A protecao preserva os dashboards e importacoes ja confirmados.
create or replace function public.market_protect_store_type_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if old.store_type = 'store' and new.store_type = 'warehouse' and (
        exists (
            select 1 from public.market_sales_import_rows r
            where r.market_account_id = old.market_account_id
              and r.market_store_id = old.id
        )
        or exists (
            select 1 from public.market_stock_movements m
            where m.market_account_id = old.market_account_id
              and m.market_store_id = old.id
              and m.movement_type = 'SALE'
        )
    ) then
        raise exception 'STORE_TYPE_HAS_SALES: unidade com historico de vendas nao pode ser convertida em galpao.';
    end if;
    return new;
end;
$$;

create trigger market_stores_protect_type_change
before update of store_type on public.market_stores
for each row execute function public.market_protect_store_type_change();

-- Defesa final do ledger. INVENTORY, ADJUSTMENT_*, PURCHASE e TRANSFER_*
-- continuam permitidos para warehouse; somente SALE exige uma loja.
create or replace function public.market_reject_warehouse_sale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_store_type text;
begin
    if new.movement_type = 'SALE' then
        -- FOR KEY SHARE nao conflita com um UPDATE que altere somente
        -- store_type. FOR SHARE conflita com FOR NO KEY UPDATE, serializando
        -- a venda contra store -> warehouse sem bloquear outras vendas.
        select s.store_type into v_store_type
        from public.market_stores s
        where s.id = new.market_store_id
          and s.market_account_id = new.market_account_id
        for share;

        if not found then
            raise exception 'SALE_STORE_NOT_FOUND: local inexistente ou pertencente a outra conta.';
        end if;
        if v_store_type <> 'store' then
            raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: galpao nao pode receber movimento de venda.';
        end if;
    end if;
    return new;
end;
$$;

create trigger market_stock_movements_reject_warehouse_sale
before insert or update of movement_type, market_store_id, market_account_id
on public.market_stock_movements
for each row execute function public.market_reject_warehouse_sale();

-- A tabela de linhas importadas possui escrita protegida por RLS, mas a regra
-- comercial deve valer mesmo fora das RPCs. Linhas ainda nao mapeadas, com
-- market_store_id nulo, continuam validas.
create or replace function public.market_reject_warehouse_sales_import_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_store_type text;
begin
    if new.market_store_id is not null then
        -- Mesmo lock do ledger: conflita com a alteracao de store_type e faz a
        -- transacao que esperar revalidar o estado confirmado mais recente.
        select s.store_type into v_store_type
        from public.market_stores s
        where s.id = new.market_store_id
          and s.market_account_id = new.market_account_id
        for share;

        if not found then
            raise exception 'SALE_STORE_NOT_FOUND: local inexistente ou pertencente a outra conta.';
        end if;
        if v_store_type <> 'store' then
            raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: galpao nao pode receber linha de venda.';
        end if;
    end if;
    return new;
end;
$$;

create trigger market_sales_import_rows_reject_warehouse
before insert or update of market_account_id, market_store_id
on public.market_sales_import_rows
for each row execute function public.market_reject_warehouse_sales_import_row();

revoke all on function public.market_protect_store_type_change() from public, anon, authenticated;
revoke all on function public.market_reject_warehouse_sale() from public, anon, authenticated;
revoke all on function public.market_reject_warehouse_sales_import_row() from public, anon, authenticated;

-- Mantem a implementacao comercial validada na Sprint 3A e adiciona uma
-- fronteira publica que rejeita warehouse e remove galpoes da lista de lojas.
alter function public.market_get_commercial_dashboard(uuid,uuid)
    rename to market_get_commercial_dashboard_all_locations;

revoke all on function public.market_get_commercial_dashboard_all_locations(uuid,uuid)
    from public, anon, authenticated;

create or replace function public.market_get_commercial_dashboard(
    p_market_account_id uuid,
    p_market_store_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_result jsonb;
    v_stores jsonb;
begin
    -- A funcao interna valida conta, membership e escopo antes de qualquer
    -- informacao sobre o tipo do local ser exposta.
    v_result := public.market_get_commercial_dashboard_all_locations(
        p_market_account_id, p_market_store_id
    );

    if p_market_store_id is not null and exists (
        select 1 from public.market_stores s
        where s.id = p_market_store_id
          and s.market_account_id = p_market_account_id
          and s.store_type = 'warehouse'
    ) then
        raise exception 'DASHBOARD_STORE_TYPE_NOT_ALLOWED: galpao nao participa do Dashboard Comercial.';
    end if;

    select coalesce(jsonb_agg(entry.value order by entry.value->>'name'), '[]'::jsonb)
    into v_stores
    from jsonb_array_elements(coalesce(v_result->'stores', '[]'::jsonb)) entry
    join public.market_stores s
      on s.id = (entry.value->>'id')::uuid
     and s.market_account_id = p_market_account_id
     and s.store_type = 'store';

    return jsonb_set(v_result, '{stores}', v_stores, true);
end;
$$;

revoke all on function public.market_get_commercial_dashboard(uuid,uuid) from public;
grant execute on function public.market_get_commercial_dashboard(uuid,uuid) to authenticated;

-- As implementacoes validadas da Sprint 2 permanecem intactas e passam a ser
-- chamadas somente por wrappers que aceitam exclusivamente lojas comerciais.
alter function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean)
    rename to market_begin_sales_import_all_locations;
alter function public.market_append_sales_import_chunk(uuid,uuid,jsonb)
    rename to market_append_sales_import_chunk_all_locations;
alter function public.market_finalize_sales_import(uuid,uuid)
    rename to market_finalize_sales_import_all_locations;

revoke all on function public.market_begin_sales_import_all_locations(uuid,text,text,date,date,text,integer,text[],boolean)
    from public, anon, authenticated;
revoke all on function public.market_append_sales_import_chunk_all_locations(uuid,uuid,jsonb)
    from public, anon, authenticated;
revoke all on function public.market_finalize_sales_import_all_locations(uuid,uuid)
    from public, anon, authenticated;

create or replace function public.market_begin_sales_import(
    p_market_account_id uuid,
    p_file_name text,
    p_file_hash text,
    p_period_start date,
    p_period_end date,
    p_source_system text,
    p_total_rows integer,
    p_store_codes text[],
    p_accept_overlap boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_code text;
begin
    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager','operator']
    ) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuario sem permissao ou conta indisponivel.';
    end if;

    foreach v_code in array coalesce(p_store_codes, array[]::text[]) loop
        if exists (
            select 1 from public.market_stores s
            where s.market_account_id = p_market_account_id
              and btrim(s.external_code) = btrim(v_code)
              and s.store_type = 'warehouse'
        ) then
            raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: codigo % pertence a um galpao.', btrim(v_code);
        end if;
    end loop;

    return public.market_begin_sales_import_all_locations(
        p_market_account_id, p_file_name, p_file_hash, p_period_start,
        p_period_end, p_source_system, p_total_rows, p_store_codes,
        p_accept_overlap
    );
end;
$$;

create or replace function public.market_append_sales_import_chunk(
    p_market_account_id uuid,
    p_import_id uuid,
    p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if jsonb_typeof(p_rows) <> 'array'
       or jsonb_array_length(p_rows) = 0
       or jsonb_array_length(p_rows) > 500 then
        raise exception 'INVALID_CHUNK: cada lote deve conter entre 1 e 500 linhas.';
    end if;

    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager','operator']
    ) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuario sem permissao ou conta indisponivel.';
    end if;

    if exists (
        select 1
        from jsonb_array_elements(p_rows) item
        join public.market_stores s
          on s.market_account_id = p_market_account_id
         and btrim(s.external_code) = btrim(coalesce(item->>'externalStoreCode', ''))
        where s.store_type = 'warehouse'
    ) then
        raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: planilha referencia um galpao.';
    end if;

    return public.market_append_sales_import_chunk_all_locations(
        p_market_account_id, p_import_id, p_rows
    );
end;
$$;

create or replace function public.market_finalize_sales_import(
    p_market_account_id uuid,
    p_import_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
    if not public.market_has_role(
        p_market_account_id, array['owner','admin','manager','operator']
    ) then
        raise exception 'IMPORT_PERMISSION_DENIED: usuario sem permissao ou conta indisponivel.';
    end if;

    if exists (
        select 1
        from public.market_sales_import_rows r
        join public.market_stores s
          on s.id = r.market_store_id
         and s.market_account_id = r.market_account_id
        where r.market_account_id = p_market_account_id
          and r.import_id = p_import_id
          and s.store_type = 'warehouse'
    ) then
        raise exception 'SALES_WAREHOUSE_NOT_ALLOWED: importacao contem galpao.';
    end if;

    return public.market_finalize_sales_import_all_locations(
        p_market_account_id, p_import_id
    );
end;
$$;

revoke all on function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean) from public;
revoke all on function public.market_append_sales_import_chunk(uuid,uuid,jsonb) from public;
revoke all on function public.market_finalize_sales_import(uuid,uuid) from public;
grant execute on function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean) to authenticated;
grant execute on function public.market_append_sales_import_chunk(uuid,uuid,jsonb) to authenticated;
grant execute on function public.market_finalize_sales_import(uuid,uuid) to authenticated;

-- A selecao administrativa de escopo passa a identificar visualmente cada
-- local, sem alterar as regras de vinculo e permissao validadas anteriormente.
create or replace function public.admin_list_market_link_stores(
    p_market_account_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if auth.uid() is null then raise exception 'ADMIN_AUTH_REQUIRED: usuario nao autenticado.'; end if;
    if not coalesce(public.is_admin(), false) then raise exception 'ADMIN_PERMISSION_DENIED: acesso negado.'; end if;
    if p_market_account_id is null or not exists (
        select 1 from public.market_accounts a
        where a.id = p_market_account_id and a.status in ('pilot','active')
    ) then raise exception 'MARKET_LINK_ACCOUNT_UNAVAILABLE: conta Market inexistente ou indisponivel.'; end if;

    return coalesce((
        select jsonb_agg(jsonb_build_object(
            'id', s.id,
            'name', s.name,
            'externalCode', s.external_code,
            'storeType', s.store_type,
            'status', s.status
        ) order by s.name, s.id)
        from public.market_stores s
        where s.market_account_id = p_market_account_id
          and s.status = 'active'
    ), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_market_link_stores(uuid) from public;
grant execute on function public.admin_list_market_link_stores(uuid) to authenticated;

commit;
