-- Transição da estrutura criada manualmente para o modelo da Etapa 1.
-- Esta migration preserva as tabelas e colunas legadas; em especial,
-- business_photos, business_videos e os campos antigos de businesses.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  email text,
  avatar_url text,
  plan_code text not null default 'free',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists display_name text,
  add column if not exists email text,
  add column if not exists avatar_url text,
  add column if not exists plan_code text not null default 'free',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

insert into public.profiles (id, display_name, email, avatar_url)
select
  id,
  coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name'),
  email,
  coalesce(raw_user_meta_data ->> 'avatar_url', raw_user_meta_data ->> 'picture')
from auth.users
on conflict (id) do nothing;

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null,
  created_at timestamptz not null default now(),
  constraint user_roles_role_check check (role in ('admin'))
);

alter table public.businesses
  add column if not exists category text,
  add column if not exists story text,
  add column if not exists service_type text,
  add column if not exists logo_path text,
  add column if not exists state char(2),
  add column if not exists show_address boolean default true,
  add column if not exists contact_email text,
  add column if not exists status text,
  add column if not exists is_suspended boolean default false,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspension_reason text,
  add column if not exists published_at timestamptz;

-- Copia os valores legados sem sobrescrever dados que já tenham sido migrados.
update public.businesses
set story = coalesce(story, description),
    category = coalesce(category, area),
    contact_email = coalesce(contact_email, email),
    logo_path = coalesce(logo_path, logo_url);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'published'
      and data_type = 'boolean'
  ) then
    execute $sql$
      update public.businesses
      set status = case when published is true then 'published' else 'draft' end
      where status is null
    $sql$;
  else
    update public.businesses set status = 'draft' where status is null;
  end if;
end;
$$;

update public.businesses
set show_address = true
where show_address is null;

update public.businesses
set is_suspended = false
where is_suspended is null;

alter table public.businesses
  alter column status set default 'draft',
  alter column status set not null,
  alter column is_suspended set default false,
  alter column is_suspended set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_service_type_check'
  ) then
    alter table public.businesses
      add constraint businesses_service_type_check
      check (service_type in ('physical', 'online', 'both'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_status_check'
  ) then
    alter table public.businesses
      add constraint businesses_status_check
      check (status in ('draft', 'published'));
  end if;
end;
$$;

-- A FK é criada como NOT VALID para não descartar nem bloquear a transição caso
-- existam owner_id legados órfãos. Ela já protege novas escritas; a validação dos
-- dados anteriores deve ocorrer após uma auditoria específica.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_owner_id_profiles_fkey'
  ) then
    alter table public.businesses
      add constraint businesses_owner_id_profiles_fkey
      foreign key (owner_id) references public.profiles (id)
      on delete cascade not valid;
  end if;
end;
$$;

-- O modelo permite vários negócios por proprietário. Remove apenas constraints
-- UNIQUE formadas exclusivamente por owner_id.
do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.businesses'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname order by key_column.ordinality)
        from unnest(c.conkey) with ordinality as key_column(attnum, ordinality)
        join pg_attribute a
          on a.attrelid = c.conrelid and a.attnum = key_column.attnum
      ) = array['owner_id']::name[]
  loop
    execute format(
      'alter table public.businesses drop constraint %I',
      constraint_name
    );
  end loop;
end;
$$;

-- Remove índices UNIQUE independentes formados exclusivamente por owner_id.
do $$
declare
  index_name text;
begin
  for index_name in
    select index_class.relname
    from pg_index i
    join pg_class index_class on index_class.oid = i.indexrelid
    where i.indrelid = 'public.businesses'::regclass
      and i.indisunique
      and i.indnkeyatts = 1
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
      and (select a.attname from pg_attribute a
           where a.attrelid = i.indrelid and a.attnum = i.indkey[0]) = 'owner_id'
  loop
    execute format('drop index public.%I', index_name);
  end loop;
end;
$$;

create index if not exists businesses_owner_id_idx
  on public.businesses (owner_id);

create table if not exists public.business_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  title text,
  description text,
  image_path text,
  position smallint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists business_items_business_id_idx
  on public.business_items (business_id);

create index if not exists business_items_business_position_idx
  on public.business_items (business_id, position);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- update_businesses_updated_at já existe no banco legado e é preservado.
drop trigger if exists business_items_set_updated_at on public.business_items;
create trigger business_items_set_updated_at
before update on public.business_items
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'),
    new.email,
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

revoke all on function public.handle_new_user() from public;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = (select auth.uid())
      and role = 'admin'
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

create or replace function public.protect_business_admin_fields()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin()
     and (
       new.is_suspended is distinct from old.is_suspended
       or new.suspended_at is distinct from old.suspended_at
       or new.suspension_reason is distinct from old.suspension_reason
     ) then
    raise exception 'Only an administrator can change business suspension fields'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists businesses_protect_admin_fields on public.businesses;
create trigger businesses_protect_admin_fields
before update on public.businesses
for each row execute function public.protect_business_admin_fields();

revoke all on function public.protect_business_admin_fields() from public;

create or replace function public.suspend_business(
  target_business_id uuid,
  reason text default null
)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_business public.businesses;
begin
  if not public.is_admin() then
    raise exception 'Administrator role required' using errcode = '42501';
  end if;

  update public.businesses
  set is_suspended = true,
      suspended_at = now(),
      suspension_reason = reason
  where id = target_business_id
  returning * into changed_business;

  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  return changed_business;
end;
$$;

create or replace function public.reactivate_business(target_business_id uuid)
returns public.businesses
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed_business public.businesses;
begin
  if not public.is_admin() then
    raise exception 'Administrator role required' using errcode = '42501';
  end if;

  update public.businesses
  set is_suspended = false,
      suspended_at = null,
      suspension_reason = null
  where id = target_business_id
  returning * into changed_business;

  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;
  return changed_business;
end;
$$;

create or replace function public.delete_business(target_business_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator role required' using errcode = '42501';
  end if;

  perform 1 from public.businesses
  where businesses.id = target_business_id
  for update;

  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;

  delete from public.businesses
  where businesses.id = target_business_id;
end;
$$;

revoke all on function public.suspend_business(uuid, text) from public;
revoke all on function public.reactivate_business(uuid) from public;
revoke all on function public.delete_business(uuid) from public;
grant execute on function public.suspend_business(uuid, text) to authenticated;
grant execute on function public.reactivate_business(uuid) to authenticated;
grant execute on function public.delete_business(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.businesses enable row level security;
alter table public.business_items enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin"
on public.profiles for select
to authenticated
using (id = (select auth.uid()) or public.is_admin());

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists "user_roles_select_own_or_admin" on public.user_roles;
create policy "user_roles_select_own_or_admin"
on public.user_roles for select
to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

-- Todas as policies legadas de businesses são substituídas em conjunto,
-- inclusive "Owner can delete own business" e aliases com outros nomes.
do $$
declare
  policy_name text;
begin
  for policy_name in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'businesses'
  loop
    execute format('drop policy %I on public.businesses', policy_name);
  end loop;
end;
$$;

create policy "businesses_select_public_owner_or_admin"
on public.businesses for select
to anon, authenticated
using (
  (status = 'published' and is_suspended = false)
  or owner_id = (select auth.uid())
  or public.is_admin()
);

create policy "businesses_insert_owner_or_admin"
on public.businesses for insert
to authenticated
with check (
  (owner_id = (select auth.uid()) and is_suspended = false
    and suspended_at is null and suspension_reason is null)
  or public.is_admin()
);

create policy "businesses_update_owner_or_admin"
on public.businesses for update
to authenticated
using (owner_id = (select auth.uid()) or public.is_admin())
with check (owner_id = (select auth.uid()) or public.is_admin());

drop policy if exists "business_items_select_public_owner_or_admin"
  on public.business_items;
create policy "business_items_select_public_owner_or_admin"
on public.business_items for select
to anon, authenticated
using (
  exists (
    select 1 from public.businesses
    where businesses.id = business_items.business_id
      and (
        (businesses.status = 'published' and businesses.is_suspended = false)
        or businesses.owner_id = (select auth.uid())
        or public.is_admin()
      )
  )
);

drop policy if exists "business_items_insert_owner_or_admin"
  on public.business_items;
create policy "business_items_insert_owner_or_admin"
on public.business_items for insert
to authenticated
with check (
  exists (
    select 1 from public.businesses
    where businesses.id = business_items.business_id
      and (businesses.owner_id = (select auth.uid()) or public.is_admin())
  )
);

drop policy if exists "business_items_update_owner_or_admin"
  on public.business_items;
create policy "business_items_update_owner_or_admin"
on public.business_items for update
to authenticated
using (
  exists (
    select 1 from public.businesses
    where businesses.id = business_items.business_id
      and (businesses.owner_id = (select auth.uid()) or public.is_admin())
  )
)
with check (
  exists (
    select 1 from public.businesses
    where businesses.id = business_items.business_id
      and (businesses.owner_id = (select auth.uid()) or public.is_admin())
  )
);

drop policy if exists "business_items_delete_owner_or_admin"
  on public.business_items;
create policy "business_items_delete_owner_or_admin"
on public.business_items for delete
to authenticated
using (
  exists (
    select 1 from public.businesses
    where businesses.id = business_items.business_id
      and (businesses.owner_id = (select auth.uid()) or public.is_admin())
  )
);
