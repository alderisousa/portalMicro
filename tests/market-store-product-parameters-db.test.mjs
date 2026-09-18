import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '../.scratch/purchase-db-test/node_modules/@electric-sql/pglite/dist/index.js'
const migration=readFileSync('supabase/migrations/20260918111358_add_market_store_product_minimum_margin.sql','utf8')
test('migration aditiva, meta nullable e independente por loja, preserva dados existentes',async()=>{
 const db=new PGlite()
 try{
  await db.exec(`create table public.market_store_products (
    market_account_id text not null, market_store_id text not null, product_id text not null,
    minimum_stock numeric(14,3) null check(minimum_stock >= 0), is_essential boolean not null default false,
    sale_price numeric(14,2), status text not null default 'active', unique(market_store_id,product_id));
    insert into market_store_products values ('account','a','p',0,true,12.50,'active'),('account','b','p',null,false,14.50,'active');`)
  await db.exec(migration)
  const rows=(await db.query('select * from market_store_products order by market_store_id')).rows
  assert.equal(rows[0].minimum_margin_pct,null);assert.equal(rows[1].minimum_margin_pct,null)
  assert.equal(Number(rows[0].sale_price),12.5);assert.equal(Number(rows[0].minimum_stock),0);assert.equal(rows[0].is_essential,true)
  await db.exec(`insert into market_store_products(market_account_id,market_store_id,product_id,minimum_stock,is_essential,minimum_margin_pct)
    values('account','a','p',null,false,22.75) on conflict(market_store_id,product_id) do update
    set minimum_stock=excluded.minimum_stock,is_essential=excluded.is_essential,minimum_margin_pct=excluded.minimum_margin_pct;`)
  const after=(await db.query('select * from market_store_products order by market_store_id')).rows
  assert.equal(Number(after[0].minimum_margin_pct),22.75);assert.equal(after[0].minimum_stock,null);assert.equal(Number(after[0].sale_price),12.5)
  assert.deepEqual(after[1],rows[1])
  for(const v of [0,100,null])await db.query('update market_store_products set minimum_margin_pct=$1 where market_store_id=$2',[v,'a'])
  for(const v of [-0.01,100.01,'NaN'])await assert.rejects(db.query('update market_store_products set minimum_margin_pct=$1 where market_store_id=$2',[v,'a']))
 }finally{await db.close()}
})
