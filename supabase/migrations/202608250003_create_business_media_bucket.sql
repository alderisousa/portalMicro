-- O bucket permanece público no MVP porque as imagens são conteúdo comercial
-- destinado à publicação. As URLs dos arquivos podem continuar acessíveis mesmo
-- quando o negócio estiver em draft ou suspended. Essa decisão poderá ser revista
-- futuramente com um bucket privado e URLs assinadas.
insert into storage.buckets (id, name, public)
values ('business-media', 'business-media', true)
on conflict (id) do update
set public = excluded.public;

create or replace function public.can_manage_business_media(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    split_part(object_name, '/', 1) ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    and split_part(object_name, '/', 2) ~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    and split_part(object_name, '/', 3) in ('logo', 'items')
    and split_part(object_name, '/', 4) <> ''
    and split_part(object_name, '/', 5) = ''
    and exists (
      select 1
      from public.businesses
      where businesses.id = case
        when split_part(object_name, '/', 2) ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
        then split_part(object_name, '/', 2)::uuid
        else null
      end
        and split_part(object_name, '/', 1) = businesses.owner_id::text
        and (
          businesses.owner_id = (select auth.uid())
          or public.is_admin()
        )
    );
$$;

revoke all on function public.can_manage_business_media(text) from public;
grant execute on function public.can_manage_business_media(text) to authenticated;

create policy "business_media_public_read"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'business-media');

create policy "business_media_insert_owner_or_admin"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'business-media'
  and public.can_manage_business_media(name)
);

create policy "business_media_update_owner_or_admin"
on storage.objects for update
to authenticated
using (
  bucket_id = 'business-media'
  and public.can_manage_business_media(name)
)
with check (
  bucket_id = 'business-media'
  and public.can_manage_business_media(name)
);

create policy "business_media_delete_owner_or_admin"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'business-media'
  and public.can_manage_business_media(name)
);
