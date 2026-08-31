-- GiroMicro
-- Migration: 202608310002_admin_users_business_members.sql
-- Objetivo:
-- 1) permitir ao admin da plataforma listar usuários autenticados no Supabase Auth;
-- 2) permitir vínculo N:N entre usuários e páginas/negócios;
-- 3) manter owner_id atual por compatibilidade;
-- 4) permitir definir plano da página;
-- 5) não alterar as policies atuais de businesses nesta etapa.

begin;

-- =========================================================
-- 1. PLANO DA PÁGINA
-- =========================================================

alter table public.businesses
    add column if not exists plan_code text not null default 'free';

create index if not exists ix_businesses_plan_code
    on public.businesses(plan_code);

-- =========================================================
-- 2. MEMBROS / USUÁRIOS VINCULADOS À PÁGINA
-- =========================================================

create table if not exists public.business_members (
    id uuid primary key default gen_random_uuid(),
    business_id uuid not null references public.businesses(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    role text not null default 'viewer'
        check (role in ('owner','admin','editor','viewer')),
    status text not null default 'active'
        check (status in ('active','disabled')),
    created_by uuid null references auth.users(id) on delete set null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (business_id, user_id)
);

create index if not exists ix_business_members_user
    on public.business_members(user_id);

create index if not exists ix_business_members_business_role
    on public.business_members(business_id, role);

-- =========================================================
-- 3. BACKFILL DOS PROPRIETÁRIOS ATUAIS
-- Mantém o owner_id existente e cria o vínculo equivalente.
-- =========================================================

insert into public.business_members (
    business_id,
    user_id,
    role,
    status,
    created_by
)
select
    b.id,
    b.owner_id,
    'owner',
    'active',
    b.owner_id
from public.businesses b
where b.owner_id is not null
on conflict (business_id, user_id)
do update set
    role = case
        when public.business_members.role = 'owner' then 'owner'
        else excluded.role
    end,
    status = 'active',
    updated_at = now();

-- =========================================================
-- 4. SINCRONIZAÇÃO DO owner_id LEGADO
-- Sempre que owner_id mudar, garante business_members owner.
-- Não remove automaticamente owners anteriores.
-- =========================================================

create or replace function public.sync_business_owner_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    if new.owner_id is not null then
        insert into public.business_members (
            business_id,
            user_id,
            role,
            status,
            created_by
        )
        values (
            new.id,
            new.owner_id,
            'owner',
            'active',
            auth.uid()
        )
        on conflict (business_id, user_id)
        do update set
            role = 'owner',
            status = 'active',
            updated_at = now();
    end if;

    return new;
end;
$$;

drop trigger if exists trg_sync_business_owner_member on public.businesses;

create trigger trg_sync_business_owner_member
after insert or update of owner_id
on public.businesses
for each row
execute function public.sync_business_owner_member();

-- =========================================================
-- 5. FUNÇÕES DE AUTORIZAÇÃO DA PÁGINA
-- =========================================================

create or replace function public.business_is_member(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        coalesce(public.is_admin(), false)
        or exists (
            select 1
            from public.business_members bm
            where bm.business_id = p_business_id
              and bm.user_id = auth.uid()
              and bm.status = 'active'
        );
$$;

create or replace function public.business_has_role(
    p_business_id uuid,
    p_roles text[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select
        coalesce(public.is_admin(), false)
        or exists (
            select 1
            from public.business_members bm
            where bm.business_id = p_business_id
              and bm.user_id = auth.uid()
              and bm.status = 'active'
              and bm.role = any(p_roles)
        );
$$;

revoke all on function public.business_is_member(uuid) from public;
revoke all on function public.business_has_role(uuid,text[]) from public;

grant execute on function public.business_is_member(uuid) to authenticated;
grant execute on function public.business_has_role(uuid,text[]) to authenticated;

-- =========================================================
-- 6. ADMIN: LISTAR TODOS OS USUÁRIOS DO SUPABASE AUTH
-- Esta função expõe somente dados necessários ao painel.
-- =========================================================

create or replace function public.admin_list_authenticated_users()
returns table (
    user_id uuid,
    email text,
    full_name text,
    avatar_url text,
    provider text,
    auth_created_at timestamptz,
    last_sign_in_at timestamptz,
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
        u.last_sign_in_at,
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
    order by u.created_at desc;
end;
$$;

revoke all on function public.admin_list_authenticated_users() from public;
grant execute on function public.admin_list_authenticated_users() to authenticated;

-- =========================================================
-- 7. ADMIN: DETALHE DE UM USUÁRIO
-- =========================================================

create or replace function public.admin_get_authenticated_user(p_user_id uuid)
returns table (
    user_id uuid,
    email text,
    full_name text,
    avatar_url text,
    provider text,
    auth_created_at timestamptz,
    last_sign_in_at timestamptz
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
        u.last_sign_in_at
    from auth.users u
    where u.id = p_user_id;
end;
$$;

revoke all on function public.admin_get_authenticated_user(uuid) from public;
grant execute on function public.admin_get_authenticated_user(uuid) to authenticated;

-- =========================================================
-- 8. ADMIN: LISTAR PÁGINAS VINCULADAS AO USUÁRIO
-- =========================================================

create or replace function public.admin_list_user_businesses(p_user_id uuid)
returns table (
    business_id uuid,
    business_name text,
    slug text,
    status text,
    plan_code text,
    template_key text,
    role text,
    member_status text,
    legacy_owner boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    return query
    select
        b.id,
        b.name::text,
        b.slug::text,
        b.status::text,
        b.plan_code::text,
        b.template_key::text,
        bm.role::text,
        bm.status::text,
        (b.owner_id = p_user_id) as legacy_owner
    from public.business_members bm
    join public.businesses b
      on b.id = bm.business_id
    where bm.user_id = p_user_id
    order by b.created_at desc;
end;
$$;

revoke all on function public.admin_list_user_businesses(uuid) from public;
grant execute on function public.admin_list_user_businesses(uuid) to authenticated;

-- =========================================================
-- 9. ADMIN: VINCULAR USUÁRIO A UMA PÁGINA
-- =========================================================

create or replace function public.admin_link_user_to_business(
    p_user_id uuid,
    p_business_id uuid,
    p_role text default 'viewer',
    p_make_legacy_owner boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
    v_member_id uuid;
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    if p_role not in ('owner','admin','editor','viewer') then
        raise exception 'Perfil inválido.';
    end if;

    if not exists (select 1 from auth.users where id = p_user_id) then
        raise exception 'Usuário não encontrado.';
    end if;

    if not exists (select 1 from public.businesses where id = p_business_id) then
        raise exception 'Página/negócio não encontrado.';
    end if;

    insert into public.business_members (
        business_id,
        user_id,
        role,
        status,
        created_by
    )
    values (
        p_business_id,
        p_user_id,
        p_role,
        'active',
        auth.uid()
    )
    on conflict (business_id, user_id)
    do update set
        role = excluded.role,
        status = 'active',
        updated_at = now()
    returning id into v_member_id;

    if p_make_legacy_owner or p_role = 'owner' then
        update public.businesses
        set owner_id = p_user_id
        where id = p_business_id;
    end if;

    return v_member_id;
end;
$$;

revoke all on function public.admin_link_user_to_business(uuid,uuid,text,boolean) from public;
grant execute on function public.admin_link_user_to_business(uuid,uuid,text,boolean) to authenticated;

-- =========================================================
-- 10. ADMIN: ALTERAR PAPEL/STATUS DO VÍNCULO
-- =========================================================

create or replace function public.admin_update_business_member(
    p_business_id uuid,
    p_user_id uuid,
    p_role text,
    p_status text default 'active'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    if p_role not in ('owner','admin','editor','viewer') then
        raise exception 'Perfil inválido.';
    end if;

    if p_status not in ('active','disabled') then
        raise exception 'Status inválido.';
    end if;

    update public.business_members
    set
        role = p_role,
        status = p_status,
        updated_at = now()
    where business_id = p_business_id
      and user_id = p_user_id;

    if not found then
        raise exception 'Vínculo não encontrado.';
    end if;

    if p_role = 'owner' and p_status = 'active' then
        update public.businesses
        set owner_id = p_user_id
        where id = p_business_id;
    end if;
end;
$$;

revoke all on function public.admin_update_business_member(uuid,uuid,text,text) from public;
grant execute on function public.admin_update_business_member(uuid,uuid,text,text) to authenticated;

-- =========================================================
-- 11. ADMIN: REMOVER VÍNCULO
-- Não permite remover o owner legado sem antes trocar owner_id.
-- =========================================================

create or replace function public.admin_unlink_user_from_business(
    p_business_id uuid,
    p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    if exists (
        select 1
        from public.businesses
        where id = p_business_id
          and owner_id = p_user_id
    ) then
        raise exception 'Troque primeiro o proprietário principal da página.';
    end if;

    delete from public.business_members
    where business_id = p_business_id
      and user_id = p_user_id;
end;
$$;

revoke all on function public.admin_unlink_user_from_business(uuid,uuid) from public;
grant execute on function public.admin_unlink_user_from_business(uuid,uuid) to authenticated;

-- =========================================================
-- 12. ADMIN: ALTERAR PLANO DA PÁGINA
-- plan_code fica flexível para não travar futuros planos.
-- =========================================================

create or replace function public.admin_set_business_plan(
    p_business_id uuid,
    p_plan_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
    if not coalesce(public.is_admin(), false) then
        raise exception 'Acesso negado.';
    end if;

    if nullif(btrim(p_plan_code), '') is null then
        raise exception 'Plano inválido.';
    end if;

    update public.businesses
    set plan_code = lower(btrim(p_plan_code))
    where id = p_business_id;

    if not found then
        raise exception 'Página/negócio não encontrado.';
    end if;
end;
$$;

revoke all on function public.admin_set_business_plan(uuid,text) from public;
grant execute on function public.admin_set_business_plan(uuid,text) to authenticated;

-- =========================================================
-- 13. RLS PARA business_members
-- =========================================================

alter table public.business_members enable row level security;

drop policy if exists business_members_select on public.business_members;
create policy business_members_select
on public.business_members
for select
to authenticated
using (
    user_id = auth.uid()
    or coalesce(public.is_admin(), false)
    or public.business_is_member(business_id)
);

drop policy if exists business_members_admin_insert on public.business_members;
create policy business_members_admin_insert
on public.business_members
for insert
to authenticated
with check (
    coalesce(public.is_admin(), false)
);

drop policy if exists business_members_admin_update on public.business_members;
create policy business_members_admin_update
on public.business_members
for update
to authenticated
using (
    coalesce(public.is_admin(), false)
)
with check (
    coalesce(public.is_admin(), false)
);

drop policy if exists business_members_admin_delete on public.business_members;
create policy business_members_admin_delete
on public.business_members
for delete
to authenticated
using (
    coalesce(public.is_admin(), false)
);

commit;
