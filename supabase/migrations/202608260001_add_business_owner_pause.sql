alter table public.businesses
  add column if not exists is_owner_paused boolean not null default false;

-- A suspensão administrativa continua protegida por
-- public.protect_business_admin_fields(). A pausa voluntária usa uma coluna
-- separada e permanece disponível ao proprietário pela policy normal de UPDATE.

drop policy if exists "businesses_select_public_owner_or_admin"
  on public.businesses;
create policy "businesses_select_public_owner_or_admin"
on public.businesses for select
to anon, authenticated
using (
  (
    status = 'published'
    and is_suspended = false
    and is_owner_paused = false
  )
  or owner_id = (select auth.uid())
  or public.is_admin()
);

drop policy if exists "business_items_select_public_owner_or_admin"
  on public.business_items;
create policy "business_items_select_public_owner_or_admin"
on public.business_items for select
to anon, authenticated
using (
  exists (
    select 1
    from public.businesses
    where businesses.id = business_items.business_id
      and (
        (
          businesses.status = 'published'
          and businesses.is_suspended = false
          and businesses.is_owner_paused = false
        )
        or businesses.owner_id = (select auth.uid())
        or public.is_admin()
      )
  )
);
