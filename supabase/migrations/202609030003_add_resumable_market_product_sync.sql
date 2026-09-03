-- GiroMicro Market: catálogo Accesys resumível, sem estoque e sem vínculo de loja.
begin;

create table public.market_product_sync_runs (
    id uuid primary key default gen_random_uuid(),
    market_account_id uuid not null,
    integration_id uuid not null,
    status text not null check (status in ('running','completed','partial','failed','cancelled')),
    source text not null default 'admin' check (source in ('admin','inventory','scheduled')),
    current_page integer not null default 0 check (current_page >= 0),
    total_pages integer null check (total_pages is null or total_pages >= 0),
    page_size integer not null check (page_size between 1 and 200),
    total_records integer null check (total_records is null or total_records >= 0),
    received_count integer not null default 0 check (received_count >= 0),
    created_count integer not null default 0 check (created_count >= 0),
    updated_count integer not null default 0 check (updated_count >= 0),
    unchanged_count integer not null default 0 check (unchanged_count >= 0),
    ignored_count integer not null default 0 check (ignored_count >= 0),
    error_code text null,
    error_message text null,
    requested_by uuid null references auth.users(id) on delete set null,
    started_at timestamptz not null default now(),
    heartbeat_at timestamptz null,
    finished_at timestamptz null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (id, market_account_id),
    foreign key (integration_id, market_account_id)
        references public.market_integrations(id, market_account_id),
    check (
        (status = 'running' and heartbeat_at is not null and finished_at is null)
        or (status in ('completed','partial','failed','cancelled') and finished_at is not null)
    ),
    check (finished_at is null or finished_at >= started_at),
    check (total_pages is null or current_page <= total_pages)
);

create unique index ux_market_product_sync_runs_one_running
    on public.market_product_sync_runs (market_account_id, integration_id)
    where status = 'running';
create index ix_market_product_sync_runs_history
    on public.market_product_sync_runs (market_account_id, integration_id, started_at desc);

create trigger market_product_sync_runs_set_updated_at
before update on public.market_product_sync_runs
for each row execute function public.set_updated_at();

alter table public.market_product_mappings
    add column integration_id uuid null,
    add column external_product_id text null,
    add column external_sku text null,
    add column external_gtin text null,
    add column external_is_inactive boolean null,
    add column last_seen_run_id uuid null,
    add column updated_at timestamptz not null default now(),
    add foreign key (integration_id, market_account_id)
        references public.market_integrations(id, market_account_id) on delete cascade,
    add foreign key (last_seen_run_id, market_account_id)
        references public.market_product_sync_runs(id, market_account_id),
    add constraint market_product_mappings_integration_identity_check check (
        (integration_id is null and external_product_id is null)
        or (integration_id is not null and external_product_id is not null
            and external_product_id = btrim(external_product_id) and external_product_id <> '')
    );

create unique index ux_market_product_mappings_integration_product
    on public.market_product_mappings (market_account_id, integration_id, external_product_id)
    where integration_id is not null and external_product_id is not null;

alter table public.market_product_sync_runs enable row level security;
revoke all on table public.market_product_sync_runs from public, anon, authenticated;
grant all on public.market_product_sync_runs to service_role;
revoke insert, update, delete on table public.market_product_mappings from anon, authenticated;

create function public.market_begin_product_sync(
    p_market_account_id uuid, p_integration_id uuid, p_requested_by uuid, p_page_size integer
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_running public.market_product_sync_runs%rowtype;
    v_id uuid;
begin
    if p_page_size not between 1 and 200 then raise exception 'PRODUCT_SYNC_INVALID_PAGE_SIZE'; end if;
    perform pg_advisory_xact_lock(hashtextextended(
        'market-product-sync:' || p_market_account_id::text || ':' || p_integration_id::text, 0));
    if not exists (select 1 from public.market_integrations i join public.market_accounts a
        on a.id=i.market_account_id and a.status in ('pilot','active')
        where i.id=p_integration_id and i.market_account_id=p_market_account_id
          and i.provider='accesys' and i.status='active') then
        raise exception 'PRODUCT_SYNC_INTEGRATION_UNAVAILABLE';
    end if;
    select * into v_running from public.market_product_sync_runs
      where market_account_id=p_market_account_id and integration_id=p_integration_id and status='running'
      for update;
    if found and coalesce(v_running.heartbeat_at,v_running.started_at) > v_now - interval '30 minutes' then
        raise exception 'PRODUCT_SYNC_ALREADY_RUNNING';
    elsif found then
        update public.market_product_sync_runs set status='failed', finished_at=v_now, updated_at=v_now,
          error_code='STALE_RUN', error_message='Execução encerrada por ausência de heartbeat.' where id=v_running.id;
    end if;
    insert into public.market_product_sync_runs
      (market_account_id,integration_id,status,source,page_size,requested_by,heartbeat_at)
    values (p_market_account_id,p_integration_id,'running','admin',p_page_size,p_requested_by,v_now)
    returning id into v_id;
    return v_id;
end;
$$;

create function public.market_apply_product_sync_page(
    p_run_id uuid, p_market_account_id uuid, p_page integer, p_total_pages integer,
    p_total_records integer, p_products jsonb
) returns void
language plpgsql security invoker set search_path = public
as $$
declare
    v_run public.market_product_sync_runs%rowtype;
    v_item jsonb;
    v_product_id uuid;
    v_mapping_id uuid;
    v_external_id text;
    v_sku text;
    v_gtin text;
    v_promoted_gtin text;
    v_description text;
    v_unit text;
    v_inactive boolean;
    v_changed boolean;
    v_mapping_changed boolean;
    v_conflict boolean;
    v_created integer := 0; v_updated integer := 0; v_unchanged integer := 0; v_ignored integer := 0;
    v_now timestamptz := clock_timestamp();
begin
    if jsonb_typeof(p_products) <> 'array' or p_page < 1 or p_total_pages < 1
       or p_page > p_total_pages or p_total_records < 0 then
        raise exception 'PRODUCT_SYNC_INVALID_PAGE';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('market-product-run:' || p_run_id::text,0));
    select * into v_run from public.market_product_sync_runs
      where id=p_run_id and market_account_id=p_market_account_id for update;
    if not found or v_run.status <> 'running' then raise exception 'PRODUCT_SYNC_RUN_NOT_RUNNING'; end if;
    if p_page <> v_run.current_page + 1 then raise exception 'PRODUCT_SYNC_UNEXPECTED_PAGE'; end if;
    if v_run.total_pages is not null and v_run.total_pages <> p_total_pages then raise exception 'PRODUCT_SYNC_PAGINATION_CHANGED'; end if;
    if v_run.total_records is not null and v_run.total_records <> p_total_records then raise exception 'PRODUCT_SYNC_PAGINATION_CHANGED'; end if;

    for v_item in select value from jsonb_array_elements(p_products) loop
      if v_item = 'null'::jsonb then v_ignored := v_ignored + 1; continue; end if;
      v_external_id := nullif(btrim(v_item->>'externalProductId'),'');
      if v_external_id is null then v_ignored := v_ignored + 1; continue; end if;
      v_sku := nullif(btrim(v_item->>'externalSku'),'');
      v_gtin := nullif(btrim(v_item->>'validGtin'),'');
      v_promoted_gtin := v_gtin;
      v_description := nullif(btrim(v_item->>'description'),'');
      v_unit := nullif(btrim(v_item->>'unit'),'');
      v_inactive := coalesce((v_item->>'externalInactive')::boolean,false);
      v_conflict := false;

      select m.id,m.product_id,
        (m.external_sku,m.external_gtin,m.external_description,m.external_is_inactive) is distinct from
        (v_sku,v_gtin,v_description,v_inactive)
        into v_mapping_id,v_product_id,v_mapping_changed from public.market_product_mappings m
       where m.market_account_id=v_run.market_account_id and m.integration_id=v_run.integration_id
         and m.external_product_id=v_external_id for update;
      if not found then
        v_product_id := null;
        if v_gtin is not null then
          select p.id into v_product_id from public.market_products p
           where p.market_account_id=v_run.market_account_id and p.ean=v_gtin;
        end if;
        if v_product_id is null then
          insert into public.market_products (market_account_id,ean,name,description,unit,created_by)
          values (v_run.market_account_id,v_gtin,coalesce(v_description,'Produto '||v_external_id),v_description,
                  coalesce(v_unit,'UN'),v_run.requested_by) returning id into v_product_id;
          v_created := v_created + 1;
        else
          v_unchanged := v_unchanged + 1;
        end if;
        insert into public.market_product_mappings
          (market_account_id,source_system,integration_id,external_product_id,external_product_code,
           external_sku,external_gtin,external_ean,external_description,external_is_inactive,
           product_id,confidence,confirmed_by,confirmed_at,last_seen_run_id)
        values (v_run.market_account_id,'accesys',v_run.integration_id,v_external_id,v_external_id,
          v_sku,v_gtin,v_gtin,v_description,v_inactive,v_product_id,1,v_run.requested_by,v_now,p_run_id);
      else
        if v_promoted_gtin is not null and exists (
          select 1 from public.market_products p where p.market_account_id=v_run.market_account_id
            and p.ean=v_promoted_gtin and p.id<>v_product_id
        ) then
          -- O mapping externo preserva o GTIN, mas um conflito nunca substitui
          -- nem força o EAN do produto canônico já mapeado.
          v_promoted_gtin := null;
          v_ignored := v_ignored + 1;
          v_conflict := true;
        end if;
        select (p.name,p.description,p.unit,p.ean) is distinct from
          (coalesce(v_description,p.name),coalesce(v_description,p.description),coalesce(v_unit,p.unit),coalesce(p.ean,v_promoted_gtin))
          into v_changed from public.market_products p where p.id=v_product_id and p.market_account_id=v_run.market_account_id;
        update public.market_products p set name=coalesce(v_description,p.name),
          description=coalesce(v_description,p.description), unit=coalesce(v_unit,p.unit),
          ean=coalesce(p.ean,v_promoted_gtin), updated_at=case when v_changed then v_now else p.updated_at end
          where p.id=v_product_id and p.market_account_id=v_run.market_account_id;
        update public.market_product_mappings set external_product_code=v_external_id,
          external_sku=v_sku,external_gtin=v_gtin,external_ean=v_gtin,
          external_description=v_description,external_is_inactive=v_inactive,
          last_seen_run_id=p_run_id,updated_at=v_now where id=v_mapping_id;
        if not v_conflict then
          if v_changed or v_mapping_changed then v_updated:=v_updated+1; else v_unchanged:=v_unchanged+1; end if;
        end if;
      end if;
    end loop;

    update public.market_product_sync_runs set current_page=p_page,total_pages=p_total_pages,
      total_records=p_total_records,received_count=received_count+jsonb_array_length(p_products),
      created_count=created_count+v_created,updated_count=updated_count+v_updated,
      unchanged_count=unchanged_count+v_unchanged,ignored_count=ignored_count+v_ignored,
      heartbeat_at=case when p_page>=p_total_pages then null else v_now end,
      status=case when p_page>=p_total_pages and ignored_count+v_ignored>0 then 'partial'
                  when p_page>=p_total_pages then 'completed' else 'running' end,
      finished_at=case when p_page>=p_total_pages then v_now else null end,
      error_code=null,error_message=null,updated_at=v_now where id=p_run_id;
end;
$$;

revoke all on function public.market_begin_product_sync(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.market_begin_product_sync(uuid,uuid,uuid,integer) to service_role;
revoke all on function public.market_apply_product_sync_page(uuid,uuid,integer,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.market_apply_product_sync_page(uuid,uuid,integer,integer,integer,jsonb) to service_role;

comment on table public.market_product_sync_runs is 'Runs resumíveis do catálogo externo; não representam estoque GiroMicro.';
comment on column public.market_product_mappings.external_is_inactive is 'Estado observado no provider; não inativa automaticamente o produto canônico.';
commit;
