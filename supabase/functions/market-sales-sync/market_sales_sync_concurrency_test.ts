import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const migrationUrl = new URL(
  '../../migrations/202609020004_harden_market_sales_sync_concurrency.sql',
  import.meta.url,
)
const sql = readFileSync(migrationUrl, 'utf8')
const fixMigrationUrl = new URL(
  '../../migrations/202609020005_fix_market_sales_sync_historical_heartbeat.sql',
  import.meta.url,
)
const fixSql = readFileSync(fixMigrationUrl, 'utf8')

class AtomicRunRegistry {
  private readonly running = new Set<string>()

  async begin(marketAccountId: string, integrationId: string) {
    // Yield once so Promise.all exercises interleaving before the atomic section.
    await Promise.resolve()
    const key = `${marketAccountId}:${integrationId}`
    if (this.running.has(key)) throw new Error('SYNC_ALREADY_RUNNING')
    this.running.add(key)
    return key
  }
}

test('migration bloqueia duplicidade existente antes do indice unico parcial', () => {
  const duplicateGuard = sql.indexOf('SYNC_CONCURRENCY_MIGRATION_BLOCKED')
  const uniqueIndex = sql.indexOf('create unique index ux_market_sales_sync_runs_one_running')
  assert.ok(duplicateGuard >= 0)
  assert.ok(uniqueIndex > duplicateGuard)
  assert.match(sql, /on public\.market_sales_sync_runs \(market_account_id, integration_id\)\s+where status = 'running'/)
})

test('RPC serializa por conta e integracao sem bloquear pares diferentes', () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\([\s\S]*p_market_account_id::text[\s\S]*p_integration_id::text/)
  assert.match(sql, /where i\.id = p_integration_id\s+and i\.market_account_id = p_market_account_id/)
  assert.match(sql, /SYNC_ALREADY_RUNNING/)
  assert.match(sql, /insert into public\.market_sales_sync_runs[\s\S]*returning id into v_new_run_id/)
})

test('stale de 30 minutos e encerrado como failed e permanece auditavel', () => {
  assert.match(sql, /v_stale_after constant interval := interval '30 minutes'/)
  assert.match(sql, /coalesce\(r\.heartbeat_at, r\.started_at\)/)
  assert.match(sql, /set status = 'failed',[\s\S]*ausencia de heartbeat[\s\S]*finished_at = v_now/)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.market_sales_sync_runs/i)
})

test('novo run inicia heartbeat e RPC permanece service-role-only', () => {
  assert.match(sql, /status, requested_by, heartbeat_at/)
  assert.match(sql, /revoke all on function public\.market_begin_sales_sync\(uuid,uuid,date,date,uuid\)\s+from public, anon, authenticated/)
  assert.match(sql, /grant execute on function public\.market_begin_sales_sync\(uuid,uuid,date,date,uuid\)\s+to service_role/)
})

test('migration 005 limpa somente heartbeat historico impossivel', () => {
  assert.match(fixSql, /set heartbeat_at = null\s+where finished_at is not null\s+and heartbeat_at is not null\s+and heartbeat_at > finished_at/)
  assert.doesNotMatch(fixSql, /\bdelete\s+from\b/i)
  for (const untouched of ['started_at =', 'finished_at =', 'status =', 'pages_read =', 'orders_read =']) {
    assert.equal(fixSql.includes(untouched), false)
  }
})

test('migration 005 remove default generico e exige heartbeat em novo run running', () => {
  assert.match(fixSql, /alter column heartbeat_at drop default/)
  assert.match(fixSql, /check \(status <> 'running' or heartbeat_at is not null\)/)
  assert.match(fixSql, /check \(finished_at is null or heartbeat_at is null or finished_at >= heartbeat_at\)/)
  assert.match(sql, /status, requested_by, heartbeat_at[\s\S]*'running', p_requested_by, v_now/)
})

test('migration 005 nao altera RPC, grants ou indice unico da 004', () => {
  assert.doesNotMatch(fixSql, /create\s+(or\s+replace\s+)?function/i)
  assert.doesNotMatch(fixSql, /\b(?:grant|revoke)\b/i)
  assert.match(sql, /create unique index ux_market_sales_sync_runs_one_running/)
  assert.match(sql, /coalesce\(r\.heartbeat_at, r\.started_at\)/)
})

test('duas aquisicoes simultaneas da mesma conta e integracao geram um unico run', async () => {
  const registry = new AtomicRunRegistry()
  const results = await Promise.allSettled([
    registry.begin('account-a', 'integration-x'),
    registry.begin('account-a', 'integration-x'),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  const rejected = results.find((result) => result.status === 'rejected')
  assert.ok(rejected && rejected.status === 'rejected')
  assert.match(String(rejected.reason), /SYNC_ALREADY_RUNNING/)
})

test('mesma integracao em contas distintas nao compartilha exclusao', async () => {
  const registry = new AtomicRunRegistry()
  const results = await Promise.all([
    registry.begin('account-a', 'integration-x'),
    registry.begin('account-b', 'integration-x'),
  ])
  assert.equal(new Set(results).size, 2)
})

test('integracoes distintas da mesma conta nao compartilham exclusao', async () => {
  const registry = new AtomicRunRegistry()
  const results = await Promise.all([
    registry.begin('account-a', 'integration-x'),
    registry.begin('account-a', 'integration-y'),
  ])
  assert.equal(new Set(results).size, 2)
})
