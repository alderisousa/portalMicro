-- Ultima inicializacao autenticada do GiroMicro; nao e atividade nem login Google.
begin;

alter table public.profiles add column last_access_at timestamptz;
comment on column public.profiles.last_access_at is
  'Ultima inicializacao do GiroMicro com sessao autenticada. Sem backfill de auth.users.last_sign_in_at.';

-- Usa as policies existentes profiles_select_own_or_admin / profiles_update_own.
-- Nenhum ID ou horario vem do cliente; horario gerado pelo banco.
create function public.register_my_last_access()
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'ACCESS_DENIED' using errcode = '42501';
  end if;
  update public.profiles set last_access_at = clock_timestamp() where id = auth.uid();
  if not found then
    raise exception 'PROFILE_NOT_FOUND';
  end if;
end;
$$;
revoke all on function public.register_my_last_access() from public, anon;
grant execute on function public.register_my_last_access() to authenticated;

-- O nome da coluna de retorno mudou: recria as RPCs na mesma transacao.
-- Preserva a autorizacao is_admin(), os demais campos e as contagens.
drop function public.admin_list_authenticated_users();
drop function public.admin_get_authenticated_user(uuid);

create or replace function public.admin_list_authenticated_users()
returns table (
    user_id uuid,
    email text,
    full_name text,
    avatar_url text,
    provider text,
    auth_created_at timestamptz,
    last_access_at timestamptz,
    business_count bigint,
    owned_business_count bigint,
    market_account_count bigint
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    return query
    select
        u.id as user_id,
        u.email::text,
        coalesce(
            nullif(u.raw_user_meta_data ->> 'full_name', ''),
            nullif(u.raw_user_meta_data ->> 'name', ''),
            split_part(coalesce(u.email, ''), '@', 1)
        )::text as full_name,
        coalesce(
            nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
            nullif(u.raw_user_meta_data ->> 'picture', '')
        )::text as avatar_url,
        coalesce(
            nullif(u.raw_app_meta_data ->> 'provider', ''),
            'email'
        )::text as provider,
        u.created_at as auth_created_at,
        p.last_access_at,
        (
            select count(*)
            from public.business_members bm
            where bm.user_id = u.id
              and bm.status = 'active'
        ) as business_count,
        (
            select count(*)
            from public.businesses b
            where b.owner_id = u.id
        ) as owned_business_count,
        (
            select count(*)
            from public.market_account_members mam
            where mam.user_id = u.id
              and mam.status = 'active'
        ) as market_account_count
    from auth.users u
    left join public.profiles p on p.id = u.id
    order by u.created_at desc;
end;
$$;

revoke all on function public.admin_list_authenticated_users() from public;
grant execute on function public.admin_list_authenticated_users() to authenticated;

create or replace function public.admin_get_authenticated_user(p_user_id uuid)
returns table (
    user_id uuid,
    email text,
    full_name text,
    avatar_url text,
    provider text,
    auth_created_at timestamptz,
    last_access_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    return query
    select
        u.id,
        u.email::text,
        coalesce(
            nullif(u.raw_user_meta_data ->> 'full_name', ''),
            nullif(u.raw_user_meta_data ->> 'name', ''),
            split_part(coalesce(u.email, ''), '@', 1)
        )::text,
        coalesce(
            nullif(u.raw_user_meta_data ->> 'avatar_url', ''),
            nullif(u.raw_user_meta_data ->> 'picture', '')
        )::text,
        coalesce(
            nullif(u.raw_app_meta_data ->> 'provider', ''),
            'email'
        )::text,
        u.created_at,
        p.last_access_at
    from auth.users u
    left join public.profiles p on p.id = u.id
    where u.id = p_user_id;
end;
$$;

revoke all on function public.admin_get_authenticated_user(uuid) from public;
grant execute on function public.admin_get_authenticated_user(uuid) to authenticated;

commit;
