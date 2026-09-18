import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'

const user = '00000000-0000-0000-0000-000000000001'
const other = '00000000-0000-0000-0000-000000000002'
const noProfile = '00000000-0000-0000-0000-000000000003'
const db = new PGlite()
await db.exec(`
  create role anon; create role authenticated;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function public.is_admin() returns boolean language sql stable as $$ select coalesce(current_setting('test.admin', true), '') = 'yes' $$;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now(), last_sign_in_at timestamptz default '2026-09-18 08:00:00Z');
  create table public.profiles(id uuid primary key references auth.users(id), display_name text);
  create table public.business_members(user_id uuid, status text);
  create table public.businesses(owner_id uuid);
  create table public.market_account_members(user_id uuid, status text);
  insert into auth.users(id) values ('${user}'), ('${other}'), ('${noProfile}');
  insert into public.profiles(id) values ('${user}'), ('${other}');
  alter table public.profiles enable row level security;
  grant usage on schema public, auth to authenticated, anon;
  grant select, update on public.profiles to authenticated;
`)
// Reutiliza exatamente as policies e as RPCs anteriores; testa a migration real.
const schema = readFileSync('supabase/migrations/202608250004_upgrade_existing_portalmicro_schema.sql', 'utf8')
for (const name of ['profiles_select_own_or_admin', 'profiles_update_own']) {
  await db.exec(schema.match(new RegExp(`create policy "${name}"[\\s\\S]*?;`))[0])
}
const previous = readFileSync('supabase/migrations/202608310002_admin_users_business_members.sql', 'utf8')
for (const name of ['admin_list_authenticated_users', 'admin_get_authenticated_user']) {
  await db.exec(previous.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`))[0])
}
await db.exec(readFileSync('supabase/migrations/20260918190231_add_profile_last_access.sql', 'utf8'))
test.after(() => db.close())
async function asUser(id, admin = false) {
  await db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false); select set_config('test.admin', '${admin ? 'yes' : 'no'}', false);`)
}
test('RPC grava horario do servidor somente no proprio perfil; nao altera outros usuarios', async () => {
  await asUser(user)
  await db.query('select public.register_my_last_access()')
  const own = await db.query('select last_access_at from public.profiles')
  assert.equal(own.rows.length, 1)
  assert.ok(Math.abs(Date.now() - new Date(own.rows[0].last_access_at).getTime()) < 10000)
  const changed = await db.query(`update public.profiles set last_access_at = now() where id = '${other}' returning id`)
  assert.equal(changed.rows.length, 0)
  await db.exec('reset role')
  assert.equal((await db.query(`select last_access_at from public.profiles where id = '${other}'`)).rows[0].last_access_at, null)
})
test('Admin le last_access_at; legado ou perfil ausente continuam na listagem sem fallback de login', async () => {
  await asUser(user, true)
  const list = (await db.query('select * from public.admin_list_authenticated_users()')).rows
  assert.equal(list.length, 3)
  assert.ok(list.find(row => row.user_id === user).last_access_at)
  for (const id of [other, noProfile]) {
    assert.equal(list.find(row => row.user_id === id).last_access_at, null)
    assert.equal((await db.query(`select * from public.admin_get_authenticated_user('${id}')`)).rows[0].last_access_at, null)
  }
  assert.equal('last_sign_in_at' in list[0], false)
})
test('anonimo nao grava e usuario comum nao ganha acesso ao Admin', async () => {
  await asUser(user)
  await assert.rejects(db.query('select * from public.admin_list_authenticated_users()'), /Acesso negado/)
  await assert.rejects(db.query(`select * from public.admin_get_authenticated_user('${other}')`), /Acesso negado/)
  await asUser('')
  await assert.rejects(db.query('select public.register_my_last_access()'), /ACCESS_DENIED/)
  await db.exec('reset role; set role anon')
  await assert.rejects(db.query('select public.register_my_last_access()'), /permission denied/)
})
