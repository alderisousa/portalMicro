import { createClient } from 'npm:@supabase/supabase-js@2'

type Task = 'products' | 'sales'
type Integration = { id: string; market_account_id: string }
type ItemResult = { marketAccountId: string; integrationId: string; status: string; runId: string | null }

const json = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})

const configuredSecretKeys = () => {
  try {
    return Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'))
      .filter((value): value is string => typeof value === 'string')
  } catch { return [] }
}

const invoke = async (url: string, secretApiKey: string, secret: string, body: Record<string, unknown>) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: secretApiKey,
      'x-market-scheduler-secret': secret },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, any>
  if (!response.ok) throw new Error(typeof payload.error?.code === 'string' ? payload.error.code : 'SCHEDULED_REQUEST_FAILED')
  return payload
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405)
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretApiKeys = configuredSecretKeys()
  const providedApiKey = request.headers.get('apikey')
  const schedulerSecret = Deno.env.get('MARKET_SCHEDULER_SECRET')
  if (!supabaseUrl || !providedApiKey || !secretApiKeys.includes(providedApiKey) || !schedulerSecret ||
      request.headers.get('x-market-scheduler-secret') !== schedulerSecret) {
    return json({ error: 'UNAUTHORIZED' }, 401)
  }
  const body = await request.json().catch(() => null) as { task?: Task } | null
  if (body?.task !== 'products' && body?.task !== 'sales') return json({ error: 'INVALID_TASK' }, 400)

  const client = createClient(supabaseUrl, providedApiKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await client.from('market_integrations').select('id,market_account_id,market_accounts!inner(status)')
    .eq('provider', 'accesys').eq('status', 'active').in('market_accounts.status', ['pilot', 'active'])
  if (error) return json({ error: 'INTEGRATION_LOOKUP_FAILED' }, 500)
  const integrations = (data ?? []) as unknown as Integration[]
  const results: ItemResult[] = []

  for (const integration of integrations) {
    try {
      if (body.task === 'products') {
        let runId: string | undefined
        let run: Record<string, any>
        do {
          const payload = await invoke(`${supabaseUrl}/functions/v1/market-integration-admin`, providedApiKey, schedulerSecret, {
            action: 'sync-products', mode: 'sync', marketAccountId: integration.market_account_id,
            integrationId: integration.id, pageSize: 200, ...(runId ? { runId } : {}),
          })
          run = payload.run
          runId = run?.id
        } while (run?.status === 'running')
        results.push({ marketAccountId: integration.market_account_id, integrationId: integration.id,
          status: run?.status ?? 'failed', runId: runId ?? null })
      } else {
        const run = await invoke(`${supabaseUrl}/functions/v1/market-sales-sync`, providedApiKey, schedulerSecret, {
          marketAccountId: integration.market_account_id, integrationId: integration.id,
        })
        results.push({ marketAccountId: integration.market_account_id, integrationId: integration.id,
          status: String(run.status ?? 'failed'), runId: typeof run.syncRunId === 'string' ? run.syncRunId : null })
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : 'SCHEDULED_REQUEST_FAILED'
      results.push({ marketAccountId: integration.market_account_id, integrationId: integration.id,
        status: code.includes('ALREADY_RUNNING') ? 'skipped_concurrency' : 'failed', runId: null })
    }
  }

  const summary = { task: body.task, integrationsFound: integrations.length,
    completed: results.filter((item) => item.status === 'completed' || item.status === 'partial').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped_concurrency').length,
    results }
  console.info('market-sync-scheduler: execution summary', summary)
  return json(summary)
})
