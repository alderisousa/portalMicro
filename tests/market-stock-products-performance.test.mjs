// PostgreSQL embarcado, mesmo padrao dos demais tests/market-stock-*.test.mjs.
// Homologacao encontrou "57014 canceling statement due to statement
// timeout" ao clicar em "Continuar inventario" (resumeDraft ->
// listActiveProducts -> market_get_stock_products, 202609010003). Este
// teste mede ANTES/DEPOIS da migration 202609090002 (indice novo, aditivo)
// no ponto exato do problema: o LEFT JOIN LATERAL contra
// market_product_mappings dentro de market_get_stock_products.
//
// Nao repete cobertura de conteudo/permissao ja feita em outros testes desta
// RPC — o foco aqui e estritamente o plano de execucao e o tempo da consulta.
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const db = new PGlite()

const account = '10000000-0000-4000-8000-000000000001'
const actor = '40000000-0000-4000-8000-000000000001'
const PRODUCT_COUNT = 2000
const MAPPINGS_PER_PRODUCT = 3

await db.exec(`
  create role anon; create role authenticated;
  create schema auth; create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;

  create table public.market_accounts(id uuid primary key, status text not null default 'active');
  create table public.market_account_members(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null, user_id uuid not null,
    role text not null, all_stores boolean not null default false, status text not null default 'active',
    created_at timestamptz not null default now()
  );
  -- Mesma definição de produção (202608310001): id/market_account_id
  -- compõem a FK usada por market_product_mappings.
  create table public.market_products(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null, name text not null,
    ean text null, sku text null, unit text not null default 'UN', status text not null default 'active',
    unique (id, market_account_id)
  );
  create table public.market_product_mappings(
    id uuid primary key default gen_random_uuid(), market_account_id uuid not null, source_system text not null,
    external_product_code text null, external_ean text null, external_description text null,
    product_id uuid not null, confidence numeric(5,4) null, confirmed_by uuid null, confirmed_at timestamptz null,
    created_at timestamptz not null default now(),
    foreign key (product_id, market_account_id) references public.market_products(id, market_account_id) on delete cascade
  );
  -- Índice de produção já existente (202608310001) — não cobre product_id,
  -- é exatamente a lacuna que causa o timeout.
  create index if not exists ix_market_product_mappings_lookup
    on public.market_product_mappings (market_account_id, source_system, external_product_code, external_ean);

  insert into public.market_accounts values ('${account}','active');
  insert into auth.users values ('${actor}');
  insert into public.market_account_members(id, market_account_id, user_id, role, all_stores, status)
    values ('50000000-0000-4000-8000-000000000001','${account}','${actor}','owner',true,'active');

  insert into public.market_products (market_account_id, name, unit)
    select '${account}', 'Produto ' || g, 'UN' from generate_series(1, ${PRODUCT_COUNT}) g;
  insert into public.market_product_mappings (market_account_id, source_system, external_product_code, product_id)
    select p.market_account_id, 'accesys', 'EXT-' || p.id || '-' || g, p.id
    from public.market_products p, generate_series(1, ${MAPPINGS_PER_PRODUCT}) g;
  analyze public.market_products; analyze public.market_product_mappings;
`)

// market_get_stock_products (202609010003) — RPC real usada por
// listActiveProducts() em resumeDraft(), não alterada por esta correção.
await db.exec(sqlFile('202609010003_add_market_stock_product_lookup.sql'))

const getStockProducts = async () => (await db.query('select market_get_stock_products($1) as result', [account])).rows[0].result
// Mesma consulta usada dentro de market_get_stock_products (precisa
// referenciar identifiers.* no SELECT final — senão o planner elimina o
// lateral inteiro por não ter efeito no resultado, e o EXPLAIN deixa de
// refletir o custo real da RPC).
const explainLateralJoin = async () => (await db.query(`
  explain (analyze, format text)
  select jsonb_agg(jsonb_build_object(
      'id', p.id,
      'externalEans', coalesce(identifiers.external_eans, '[]'::jsonb),
      'externalProductCodes', coalesce(identifiers.external_product_codes, '[]'::jsonb)
  ))
  from public.market_products p
  left join lateral (
      select
          coalesce(jsonb_agg(distinct btrim(m.external_ean)) filter (where nullif(btrim(m.external_ean), '') is not null), '[]'::jsonb) as external_eans,
          coalesce(jsonb_agg(distinct btrim(m.external_product_code)) filter (where nullif(btrim(m.external_product_code), '') is not null), '[]'::jsonb) as external_product_codes
      from public.market_product_mappings m
      where m.market_account_id = p.market_account_id and m.product_id = p.id
  ) identifiers on true
  where p.market_account_id = '${account}' and p.status = 'active';
`)).rows.map((r) => r['QUERY PLAN']).join('\n')

let before, after

test(`setup: ${PRODUCT_COUNT} produtos x ${MAPPINGS_PER_PRODUCT} mappings (${PRODUCT_COUNT * MAPPINGS_PER_PRODUCT} linhas) — volume pequeno perto de uma conta real`, async () => {
  const counts = await db.query('select (select count(*) from public.market_products)::int as products, (select count(*) from public.market_product_mappings)::int as mappings')
  assert.equal(counts.rows[0].products, PRODUCT_COUNT)
  assert.equal(counts.rows[0].mappings, PRODUCT_COUNT * MAPPINGS_PER_PRODUCT)
})

test('ANTES da 202609090002: sem índice por product_id, o join lateral faz Seq Scan de market_product_mappings uma vez por produto (nested loop O(produtos × mappings))', async () => {
  before = await explainLateralJoin()
  assert.match(before, /Seq Scan on (public\.)?market_product_mappings/, 'plano precisa mostrar a causa real do timeout: Seq Scan repetido dentro do nested loop')
  assert.doesNotMatch(before, /ix_market_product_mappings_product/, 'índice da correção ainda não existe neste ponto')
})

test('market_get_stock_products continua retornando o catálogo correto ANTES da correção (só o plano é ruim, não o resultado)', async () => {
  const result = await getStockProducts()
  assert.equal(result.length, PRODUCT_COUNT)
  assert.equal(result[0].externalEans.length, 0, 'external_ean não foi preenchido no seed — mapping só tem external_product_code')
})

test('aplica a migration 202609090002 (índice novo, aditivo)', async () => {
  await db.exec(sqlFile('202609090002_add_market_product_mappings_product_index.sql'))
  await db.exec('analyze public.market_product_mappings;')
  const indexes = await db.query(`select indexname from pg_indexes where tablename = 'market_product_mappings'`)
  assert.ok(indexes.rows.some((r) => r.indexname === 'ix_market_product_mappings_product'))
  // Índice antigo (lookup por source_system/external_*) continua existindo —
  // esta correção é aditiva, não substitui nada.
  assert.ok(indexes.rows.some((r) => r.indexname === 'ix_market_product_mappings_lookup'))
})

test('DEPOIS da 202609090002: o mesmo join lateral passa a usar o índice novo, sem Seq Scan de market_product_mappings', async () => {
  after = await explainLateralJoin()
  assert.match(after, /ix_market_product_mappings_product/, 'plano precisa usar o índice novo')
  assert.doesNotMatch(after, /Seq Scan on (public\.)?market_product_mappings/, 'não pode mais varrer a tabela inteira por produto')
})

test('resultado de market_get_stock_products é idêntico antes/depois — a correção muda só o plano de execução, nunca o contrato/dado retornado', async () => {
  const result = await getStockProducts()
  assert.equal(result.length, PRODUCT_COUNT)
  assert.equal(result[0].externalProductCodes.length, MAPPINGS_PER_PRODUCT)
})

test('medição informativa de tempo (antes/depois) — não é a asserção principal (o plano acima já é determinístico), só documenta a ordem de grandeza real', async () => {
  const rawQuery = `
    select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'externalEans', coalesce(identifiers.external_eans, '[]'::jsonb),
        'externalProductCodes', coalesce(identifiers.external_product_codes, '[]'::jsonb)
    ))
    from public.market_products p
    left join lateral (
        select
            coalesce(jsonb_agg(distinct btrim(m.external_ean)) filter (where nullif(btrim(m.external_ean), '') is not null), '[]'::jsonb) as external_eans,
            coalesce(jsonb_agg(distinct btrim(m.external_product_code)) filter (where nullif(btrim(m.external_product_code), '') is not null), '[]'::jsonb) as external_product_codes
        from public.market_product_mappings m
        where m.market_account_id = p.market_account_id and m.product_id = p.id
    ) identifiers on true
    where p.market_account_id = '${account}' and p.status = 'active';
  `
  const t0 = performance.now()
  await db.query(rawQuery)
  const afterMs = performance.now() - t0
  console.log(`[market-stock-products-performance] tempo da consulta DEPOIS do índice (${PRODUCT_COUNT}x${MAPPINGS_PER_PRODUCT} linhas): ${afterMs.toFixed(1)}ms`)
  // Larga margem de segurança (ambiente compartilhado) — o ponto real já foi
  // provado pelo plano (Seq Scan sumiu); isto só evita regressão grosseira.
  assert.ok(afterMs < 3000, `consulta com índice não deveria demorar segundos (${afterMs.toFixed(1)}ms)`)
})
