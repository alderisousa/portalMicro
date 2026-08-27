create or replace function public.update_business_admin_logo(
  target_business_id uuid,
  new_logo_path text
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

  if new_logo_path is null or new_logo_path !~
    '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}/logo/[^/]+$' then
    raise exception 'Invalid business logo path' using errcode = '22023';
  end if;

  update public.businesses
  set logo_path = new_logo_path
  where id = target_business_id
    and split_part(new_logo_path, '/', 1) = owner_id::text
    and split_part(new_logo_path, '/', 2) = id::text
  returning * into changed_business;

  if not found then
    raise exception 'Business not found or logo path does not belong to business'
      using errcode = 'P0002';
  end if;

  return changed_business;
end;
$$;

revoke all on function public.update_business_admin_logo(uuid, text)
  from public;
grant execute on function public.update_business_admin_logo(uuid, text)
  to authenticated;
