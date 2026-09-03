import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sql = readFileSync(new URL('../../migrations/202609030004_add_resumable_daily_market_sales_sync.sql', import.meta.url), 'utf8')
const diagnostic = readFileSync(new URL('../../diagnostics/recover_stale_market_sales_sync.sql', import.meta.url), 'utf8')

test('migration evolui o run existente com checkpoint diário sem apagar histórico', () => {
  assert.match(sql, /alter table public\.market_sales_sync_runs/)
  for (const column of ['source','next_day','last_completed_day','total_days','completed_days','orders_unchanged','error_code']) assert.match(sql, new RegExp(`add column ${column}`))
  assert.doesNotMatch(sql, /delete from public\.market_sales_sync_runs|drop table public\.market_sales_sync_runs/)
  assert.match(sql, /completed_days integer not null default 0/)
  assert.doesNotMatch(sql, /add column completed_days[^,]+check/)
  assert.doesNotMatch(sql, /completed_days between 0 and 31/)
  assert.match(sql, /next_day = case when status in \('running','failed'\) then period_start else null end/)
})

test('backfill preserva periodos legados longos e failed legado retoma do inicio', () => {
  assert.match(sql, /total_days = period_end - period_start \+ 1/)
  assert.match(sql, /completed_days = case when status in \('completed','partial'\) then period_end - period_start \+ 1 else 0 end/)
  assert.match(sql, /next_day = case when status in \('running','failed'\) then period_start else null end/)
})

test('constraint vincula matematicamente periodo, checkpoint e estados finais', () => {
  assert.match(sql, /total_days = period_end - period_start \+ 1/)
  assert.match(sql, /completed_days >= 0/)
  assert.match(sql, /completed_days <= total_days/)
  assert.match(sql, /last_completed_day = period_start \+ completed_days - 1/)
  assert.match(sql, /next_day = period_start \+ completed_days/)
  assert.match(sql, /status in \('completed','partial'\)[\s\S]*completed_days = total_days[\s\S]*last_completed_day = period_end and next_day is null/)
  assert.match(sql, /status = 'failed'[\s\S]*completed_days < total_days and next_day = period_start \+ completed_days/)
  assert.doesNotMatch(sql, /cancelled/)
})

test('um dia é aplicado e checkpointado atomicamente na mesma RPC', () => {
  const fn = sql.slice(sql.indexOf('create function public.market_apply_sales_sync_day'), sql.indexOf('create function public.market_resume_sales_sync'))
  assert.match(fn, /v_run\.next_day<>p_day/)
  assert.match(fn, /market_upsert_external_sale/)
  assert.match(fn, /completed_days=completed_days\+1/)
  assert.match(fn, /last_completed_day=p_day/)
  assert.match(fn, /next_day=case when p_day<period_end then p_day\+1 else null end/)
  assert.match(fn, /exception when sqlstate 'P0001'/)
  for (const controlledError of [
    'SYNC_INVALID_PAYLOAD', 'SYNC_INVALID_SALE', 'SYNC_AMBIGUOUS_TIMEZONE',
    'SYNC_INVALID_ITEM', 'SYNC_DUPLICATE_ITEM', 'SYNC_INVALID_PAYMENT',
    'SYNC_DUPLICATE_PAYMENT', 'SYNC_STORE_MAPPING_NOT_FOUND',
  ]) assert.match(fn, new RegExp(`${controlledError}:%`))
  assert.doesNotMatch(fn, /SYNC_INTEGRATION_UNAVAILABLE:%/)
  assert.match(fn, /else\s+raise;/)
  assert.doesNotMatch(fn, /exception when others/)
})

test('erro funcional conhecido pode gerar skipped, mas erro estrutural relanca antes do checkpoint', () => {
  const fn = sql.slice(sql.indexOf('create function public.market_apply_sales_sync_day'), sql.indexOf('create function public.market_resume_sales_sync'))
  const handler = fn.slice(fn.indexOf("exception when sqlstate 'P0001'"), fn.indexOf('end;\n    end loop'))
  assert.match(handler, /v_skipped:=v_skipped\+1;[\s\S]*insert into public\.market_sales_sync_errors/)
  assert.match(handler, /else\s+raise;/)
  assert.ok(handler.indexOf('raise;') < fn.indexOf('completed_days=completed_days+1'))
})

test('concorrência, stale e timeout são centralizados e auditáveis', () => {
  assert.match(sql, /market_sales_sync_stale_after\(\)[\s\S]*interval '30 minutes'/)
  assert.match(sql, /pg_advisory_xact_lock/)
  assert.match(sql, /SYNC_ALREADY_RUNNING/)
  assert.match(sql, /error_code='STALE_RUN'/)
  assert.match(sql, /market_reconcile_stale_sales_sync/)
  const reconcile = sql.slice(sql.indexOf('create function public.market_reconcile_stale_sales_sync'), sql.indexOf('revoke all on function public.market_sales_sync_stale_after'))
  assert.match(reconcile, /pg_advisory_xact_lock/)
  assert.match(reconcile, /where id=v_run\.id[\s\S]*and status='running'[\s\S]*market_sales_sync_stale_after/)
  assert.doesNotMatch(sql, /delete from public\.market_sales_sync_runs/)
})

test('source null e invalido sao rejeitados antes do insert', () => {
  assert.match(sql, /p_source is null or p_source not in \('admin','market','scheduled'\)/)
})

test('RPCs novas são service-role-only e SQL de recuperação exige ID específico', () => {
  for (const name of ['market_apply_sales_sync_day','market_resume_sales_sync','market_reconcile_stale_sales_sync']) {
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}`))
  }
  assert.match(diagnostic, /where id='00000000-0000-0000-0000-000000000000'::uuid/)
  assert.match(diagnostic, /and status='running'/)
  assert.match(diagnostic, /market_sales_sync_stale_after\(\)/)
  assert.doesNotMatch(diagnostic, /^update /m)
})
