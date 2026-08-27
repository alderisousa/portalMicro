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

  perform 1
  from public.businesses
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

create policy "profiles_select_own_or_admin"
on public.profiles for select
to authenticated
using (id = (select auth.uid()) or public.is_admin());

create policy "profiles_update_own"
on public.profiles for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

create policy "user_roles_select_own_or_admin"
on public.user_roles for select
to authenticated
using (user_id = (select auth.uid()) or public.is_admin());

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

create policy "business_items_select_public_owner_or_admin"
on public.business_items for select
to anon, authenticated
using (
  exists (
    select 1
    from public.businesses
    where businesses.id = business_items.business_id
      and (
        (businesses.status = 'published' and businesses.is_suspended = false)
        or businesses.owner_id = (select auth.uid())
        or public.is_admin()
      )
  )
);

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
