-- Admin/Home production adjustments. No backfill or deletion of existing data.
begin;

-- Historical references are immutable identifiers used by sales/product data.
alter table public.market_store_external_refs
    add column is_active boolean not null default true;
comment on column public.market_store_external_refs.is_active is
    'Inactive references remain for history but cannot resolve incoming sales.';

create schema if not exists market_private;
revoke all on schema market_private from public, anon, authenticated;

-- Serialize store/integration configuration within one tenant, including the
-- case where the integration and the first store are created concurrently.
create function market_private.lock_mapping_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if tg_op = 'UPDATE' and new.market_account_id <> old.market_account_id then
        raise exception 'STORE_MAPPING_ACCOUNT_IMMUTABLE: nao e permitido mover este cadastro entre Markets.';
    end if;
    perform 1 from public.market_accounts where id = new.market_account_id for no key update;
    return new;
end;
$$;

create function market_private.reconcile_store_refs()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
    v_store_id uuid;
    v_integration_id uuid;
    v_mapping record;
    v_was_accesys boolean := false;
begin
    if tg_table_name = 'market_stores' then v_store_id := new.id;
    else
        v_integration_id := new.id;
        if tg_op = 'UPDATE' then v_was_accesys := old.provider = 'accesys'; end if;
    end if;

    -- Do not delete or reassign references: existing sales still point to them.
    update public.market_store_external_refs r set is_active = false
    from public.market_integrations i
    where i.id = r.integration_id and i.market_account_id = r.market_account_id
      and (i.provider = 'accesys' or v_was_accesys)
      and r.market_account_id = new.market_account_id
      and (v_store_id is null or r.market_store_id = v_store_id)
      and (v_integration_id is null or r.integration_id = v_integration_id)
      and r.is_active
      and not exists (
          select 1 from public.market_stores s
          where s.id = r.market_store_id and s.market_account_id = r.market_account_id
            and s.store_type = 'store' and s.status = 'active'
            and nullif(btrim(s.external_code), '') = r.external_store_id
            and i.provider = 'accesys'
      );

    for v_mapping in
        select s.id as store_id, s.name, btrim(s.external_code) as code, i.id as integration_id
        from public.market_stores s
        join public.market_integrations i on i.market_account_id = s.market_account_id and i.provider = 'accesys'
        where s.market_account_id = new.market_account_id
          and s.store_type = 'store' and s.status = 'active'
          and nullif(btrim(s.external_code), '') is not null
          and (v_store_id is null or s.id = v_store_id)
          and (v_integration_id is null or i.id = v_integration_id)
        order by s.id, i.id
    loop
        insert into public.market_store_external_refs as existing
            (market_account_id, market_store_id, integration_id, external_store_id, external_store_name, is_active)
        values (new.market_account_id, v_mapping.store_id, v_mapping.integration_id, v_mapping.code, v_mapping.name, true)
        on conflict (market_account_id, integration_id, external_store_id)
        do update set is_active = true, external_store_name = excluded.external_store_name
        where existing.market_store_id = excluded.market_store_id;
        if not found then
            raise exception 'STORE_MAPPING_CONFLICT: codigo Accesys ja vinculado a outra loja nesta integracao. Revise o cadastro.';
        end if;
    end loop;
    return new;
end;
$$;

create trigger market_stores_lock_mapping_account
before insert or update of external_code, status, store_type, market_account_id, name on public.market_stores
for each row execute function market_private.lock_mapping_account();
create trigger market_integrations_lock_mapping_account
before insert or update of provider, external_company_id, base_url, status, market_account_id on public.market_integrations
for each row execute function market_private.lock_mapping_account();
create trigger market_stores_reconcile_refs
after insert or update of external_code, status, store_type, market_account_id, name on public.market_stores
for each row execute function market_private.reconcile_store_refs();
create trigger market_integrations_reconcile_refs
after insert or update of provider, external_company_id, base_url, status, market_account_id on public.market_integrations
for each row execute function market_private.reconcile_store_refs();

-- Recheck cached mappings at persistence time too. Does not change stock logic.
create function market_private.validate_sale_store_ref()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
    if new.source_type = 'api' then
        perform 1 from public.market_store_external_refs r
        join public.market_stores s on s.id = r.market_store_id and s.market_account_id = r.market_account_id
        where r.id = new.store_external_ref_id and r.market_account_id = new.market_account_id
          and r.integration_id = new.integration_id and r.market_store_id = new.market_store_id
          and r.is_active and s.status = 'active' and s.store_type = 'store'
        for share of r, s;
        if not found then
            raise exception 'SYNC_STORE_MAPPING_NOT_FOUND: referencia de loja inativa ou incompativel.';
        end if;
    end if;
    return new;
end;
$$;
create trigger market_sales_validate_active_ref
before insert or update of store_external_ref_id, market_store_id, integration_id on public.market_sales
for each row execute function market_private.validate_sale_store_ref();

-- Fail closed: only these administrative tables may contain rows. Every other
-- public table with market_account_id is protected, including future tables.
-- market_member_stores is the only current tenant-dependent table without that
-- column; it is removed explicitly via its member/store foreign keys below.
create function market_private.account_is_empty(p_account_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_table record; v_exists boolean;
begin
    -- Unknown indirect dependencies must be reviewed before any deletion is
    -- allowed, rather than disappearing through an uninspected CASCADE.
    if exists (
        with recursive dependencies(id) as (
            select 'public.market_accounts'::regclass::oid
            union
            select fk.conrelid from pg_catalog.pg_constraint fk
            join dependencies d on d.id = fk.confrelid where fk.contype = 'f'
        )
        select 1 from dependencies d
        join pg_catalog.pg_class c on c.oid = d.id
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where d.id <> 'public.market_accounts'::regclass
          and d.id <> 'public.market_member_stores'::regclass
          and (n.nspname <> 'public' or not exists (
              select 1 from pg_catalog.pg_attribute a
              where a.attrelid = d.id and a.attname = 'market_account_id' and not a.attisdropped
          ))
    ) then return false; end if;
    if exists (select 1 from public.market_stores
               where market_account_id = p_account_id and stock_control_started_at is not null) then
        return false;
    end if;
    for v_table in
        select c.relname from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        join pg_catalog.pg_attribute a on a.attrelid = c.oid
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and a.attname = 'market_account_id' and not a.attisdropped
          and c.relname <> all(array[
              'market_account_members', 'market_stores', 'market_integrations',
              'market_integration_credentials', 'market_store_external_refs',
              'market_external_store_mappings', 'market_replenishment_settings'
          ])
        order by c.relname
    loop
        execute format('select exists (select 1 from public.%I where market_account_id = $1)', v_table.relname)
            into v_exists using p_account_id;
        if v_exists then return false; end if;
    end loop;
    return true;
end;
$$;

create function public.admin_market_account_can_delete(p_market_account_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
    if auth.uid() is null or not public.market_is_platform_admin() then
        raise exception 'Acesso negado.' using errcode = '42501';
    end if;
    return exists (select 1 from public.market_accounts where id = p_market_account_id)
       and market_private.account_is_empty(p_market_account_id);
end;
$$;

create function public.admin_delete_empty_market_account(p_market_account_id uuid, p_confirmation_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_table record; v_name text;
begin
    if auth.uid() is null or not public.market_is_platform_admin() then
        raise exception 'Acesso negado.' using errcode = '42501';
    end if;
    -- Rare administrative operation: short, NOWAIT write locks prevent any
    -- concurrent insert (even into tenant tables without a direct account FK).
    -- No remote calls/waits while locked. Contention aborts without deleting.
    for v_table in
        select distinct c.relname from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        left join pg_catalog.pg_attribute a on a.attrelid = c.oid
            and a.attname = 'market_account_id' and not a.attisdropped
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and (a.attname is not null or c.relname in ('market_accounts', 'market_member_stores'))
        order by c.relname
    loop
        execute format('lock table public.%I in share row exclusive mode nowait', v_table.relname);
    end loop;
    select name into v_name from public.market_accounts where id = p_market_account_id for update;
    if not found then raise exception 'Conta Market nao encontrada.'; end if;
    if p_confirmation_name is distinct from v_name then raise exception 'MARKET_CONFIRMATION_REQUIRED: confirme o nome atual do Market.'; end if;
    if not market_private.account_is_empty(p_market_account_id) then
        raise exception 'MARKET_NOT_EMPTY: conta com dados operacionais, catalogo ou historico. Nenhum dado foi apagado.';
    end if;

    delete from public.market_member_stores l
    where exists (select 1 from public.market_account_members m where m.id = l.market_account_member_id and m.market_account_id = p_market_account_id)
       or exists (select 1 from public.market_stores s where s.id = l.market_store_id and s.market_account_id = p_market_account_id);
    delete from public.market_replenishment_settings where market_account_id = p_market_account_id;
    delete from public.market_external_store_mappings where market_account_id = p_market_account_id;
    delete from public.market_store_external_refs where market_account_id = p_market_account_id;
    delete from public.market_integration_credentials where market_account_id = p_market_account_id;
    delete from public.market_integrations where market_account_id = p_market_account_id;
    delete from public.market_account_members where market_account_id = p_market_account_id;
    delete from public.market_stores where market_account_id = p_market_account_id;
    delete from public.market_accounts where id = p_market_account_id;
end;
$$;

-- Remove the old generic frontend DELETE path; only the guarded RPC is exposed.
drop policy if exists market_accounts_admin_delete on public.market_accounts;
revoke delete on public.market_accounts from authenticated, anon;
-- Frontend edits go through stores/integrations, never a second partial write.
revoke insert, update, delete on public.market_store_external_refs from authenticated;
revoke all on all functions in schema market_private from public, anon, authenticated;
revoke all on function public.admin_market_account_can_delete(uuid) from public, anon;
revoke all on function public.admin_delete_empty_market_account(uuid, text) from public, anon;
grant execute on function public.admin_market_account_can_delete(uuid) to authenticated;
grant execute on function public.admin_delete_empty_market_account(uuid, text) to authenticated;
commit;
