import { createClient } from 'npm:@supabase/supabase-js@2'

type Task = 'products' | 'sales'
type Integration = { id: string; market_account_id: string }
// attempted=false só ocorre no caso defensivo em que o sync terminou
// 'completed' mas o próprio payload não trouxe period.startDate (nunca
// deveria acontecer, ver executeSalesSync em market-sales-sync/core.ts, mas
// evita chamar a Reposição sem uma reference_date confiável).
type ReplenishmentResult = { attempted: boolean; status: 'completed' | 'failed'; runId?: string | null; error?: string }
type ItemResult = {
  marketAccountId: string; integrationId: string; status: string; runId: string | null
  replenishment?: ReplenishmentResult
}

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
        const status = String(run.status ?? 'failed')
        const runId = typeof run.syncRunId === 'string' ? run.syncRunId : null

        // Abastecimento (Reposição Inteligente) só roda quando as vendas do
        // D-1 fecharam de verdade ('completed') — nunca em 'partial'/'failed'/
        // 'skipped_concurrency' (não geramos run novo com vendas incompletas).
        // reference_date reaproveita period.startDate do próprio retorno de
        // market-sales-sync (executeSalesSync em core.ts sempre preenche
        // period com o startDate/endDate da requisição; no fluxo agendado
        // startDate===endDate===D-1 em America/Sao_Paulo, calculado uma única
        // vez por marketOperationalWindow dentro de market-sales-sync). Nada
        // aqui recalcula fuso/janela — só lê o que já veio no payload.
        let replenishment: ReplenishmentResult | undefined
        if (status === 'completed') {
          const referenceDate = typeof run.period?.startDate === 'string' ? run.period.startDate : null
          if (!referenceDate) {
            replenishment = { attempted: false, status: 'failed', error: 'REPLENISHMENT_REFERENCE_DATE_MISSING' }
          } else {
            try {
              const { data: replenishmentRunId, error: replenishmentError } = await client.rpc('market_run_replenishment_batch', {
                p_market_account_id: integration.market_account_id,
                p_reference_date: referenceDate,
                p_run_source: 'scheduled',
              })
              if (replenishmentError) throw new Error(replenishmentError.message || 'REPLENISHMENT_RPC_FAILED')
              replenishment = { attempted: true, status: 'completed', runId: typeof replenishmentRunId === 'string' ? replenishmentRunId : null }
            } catch (cause) {
              // Isolamento: a Reposição falhar NUNCA torna o sync de vendas
              // (já concluído com sucesso) 'failed', nunca interrompe as
              // demais integrações do loop e nunca desfaz nada — a própria
              // RPC já é atômica e nunca invalida um run.is_effective anterior
              // quando falha (ela só promove is_effective após concluir com
              // sucesso). Aqui só registramos a falha no resultado do item.
              const message = cause instanceof Error ? cause.message : 'REPLENISHMENT_RPC_FAILED'
              console.error('market-sync-scheduler: falha ao executar a Reposicao Inteligente apos sync de vendas', {
                marketAccountId: integration.market_account_id, integrationId: integration.id, referenceDate, error: message,
              })
              replenishment = { attempted: true, status: 'failed', error: message }
            }
          }
        }

        results.push({
          marketAccountId: integration.market_account_id, integrationId: integration.id, status, runId,
          ...(replenishment ? { replenishment } : {}),
        })
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
    // Só existe para task='sales' (task='products' nunca preenche
    // item.replenishment) — soma rápida para o log, o detalhe por
    // integração/Market continua em results[].replenishment.
    ...(body.task === 'sales' ? {
      replenishmentCompleted: results.filter((item) => item.replenishment?.status === 'completed').length,
      replenishmentFailed: results.filter((item) => item.replenishment?.status === 'failed').length,
    } : {}),
    results }
  console.info('market-sync-scheduler: execution summary', summary)
  return json(summary)
})
