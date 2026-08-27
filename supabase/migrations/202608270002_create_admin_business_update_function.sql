create or replace function public.update_business_admin_details(
  target_business_id uuid,
  business_name text,
  business_category text,
  business_story text,
  business_service_type text,
  business_cep text,
  business_street text,
  business_number text,
  business_complement text,
  business_neighborhood text,
  business_city text,
  business_show_address boolean,
  business_contact_email text,
  business_whatsapp text
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

  if nullif(btrim(business_name), '') is null then
    raise exception 'Business name is required' using errcode = '22023';
  end if;

  if length(business_category) > 150 then
    raise exception 'Business category exceeds 150 characters' using errcode = '22023';
  end if;

  if length(business_story) > 1000
     or (
       business_story is not null
       and length(btrim(business_story)) < 30
     ) then
    raise exception 'Business story must contain between 30 and 1000 characters'
      using errcode = '22023';
  end if;

  if business_service_type is not null
     and business_service_type not in ('physical', 'online', 'both') then
    raise exception 'Invalid business service type' using errcode = '22023';
  end if;

  if business_cep is not null and business_cep !~ '^[0-9]{8}$' then
    raise exception 'Business CEP must contain 8 digits' using errcode = '22023';
  end if;

  if business_contact_email is not null
     and business_contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Invalid business contact email' using errcode = '22023';
  end if;

  update public.businesses
  set name = btrim(business_name),
      category = nullif(btrim(business_category), ''),
      story = business_story,
      service_type = business_service_type,
      cep = business_cep,
      street = nullif(btrim(business_street), ''),
      number = nullif(btrim(business_number), ''),
      complement = nullif(btrim(business_complement), ''),
      neighborhood = nullif(btrim(business_neighborhood), ''),
      city = nullif(btrim(business_city), ''),
      show_address = business_show_address,
      contact_email = nullif(btrim(business_contact_email), ''),
      whatsapp = nullif(btrim(business_whatsapp), '')
  where id = target_business_id
  returning * into changed_business;

  if not found then
    raise exception 'Business not found' using errcode = 'P0002';
  end if;

  return changed_business;
end;
$$;

revoke all on function public.update_business_admin_details(
  uuid, text, text, text, text, text, text, text, text, text, text,
  boolean, text, text
) from public;

grant execute on function public.update_business_admin_details(
  uuid, text, text, text, text, text, text, text, text, text, text,
  boolean, text, text
) to authenticated;
