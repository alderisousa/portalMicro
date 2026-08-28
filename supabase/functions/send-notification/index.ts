import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type EventType = 'welcome' | 'business_published'
type NotificationLog = {
  id: string
  status: 'pending' | 'sent' | 'failed'
  attempted_at: string
}

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })

const escapeHtml = (value: string) => value.replace(
  /[&<>'"]/g,
  (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character
)

const emailHtml = (message: string, ctaLabel: string, ctaUrl: string) => `
  <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#18332e;line-height:1.6">
    <p>Olá!</p>
    ${message}
    <p style="margin:28px 0">
      <a href="${escapeHtml(ctaUrl)}" style="background:#2d6b55;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:700">${escapeHtml(ctaLabel)}</a>
    </p>
    <p>PortalMicro</p>
  </div>`

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const brevoApiKey = Deno.env.get('BREVO_API_KEY')
  const senderName = Deno.env.get('BREVO_SENDER_NAME')
  const senderEmail = Deno.env.get('BREVO_SENDER_EMAIL')
  const siteUrl = Deno.env.get('PORTALMICRO_SITE_URL')
  const authorization = request.headers.get('Authorization')

  if (!supabaseUrl || !serviceRoleKey || !brevoApiKey || !senderName || !senderEmail || !siteUrl) {
    console.error('send-notification: configuração obrigatória ausente')
    return json({ error: 'service_not_configured' }, 503)
  }
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'unauthorized' }, 401)

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  const user = authData.user
  if (authError || !user) return json({ error: 'unauthorized' }, 401)

  let body: { eventType?: unknown; businessId?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid_json' }, 400)
  }

  if (body.eventType !== 'welcome' && body.eventType !== 'business_published') {
    return json({ error: 'invalid_event' }, 400)
  }
  const eventType: EventType = body.eventType
  let businessId: string | null = null
  let recipient = user.email ?? ''
  let subject = 'Bem-vindo ao PortalMicro'
  let html = emailHtml(
    '<p>Bem-vindo ao PortalMicro.</p><p>Aqui você pode criar e divulgar sua presença digital de forma simples e profissional.</p><p>Comece cadastrando seu negócio e monte sua página em poucos passos.</p>',
    'Acessar PortalMicro',
    siteUrl
  )

  if (eventType === 'business_published') {
    if (typeof body.businessId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.businessId)) {
      return json({ error: 'invalid_business' }, 400)
    }

    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('id, owner_id, name, slug, status')
      .eq('id', body.businessId)
      .maybeSingle()

    if (businessError) return json({ error: 'business_lookup_failed' }, 500)
    if (!business || business.owner_id !== user.id) return json({ error: 'forbidden' }, 403)
    if (business.status !== 'published' || !business.slug) {
      return json({ error: 'business_not_published' }, 409)
    }

    const { data: ownerData, error: ownerError } = await supabase.auth.admin.getUserById(
      business.owner_id
    )
    recipient = ownerData.user?.email ?? ''
    if (ownerError) return json({ error: 'owner_lookup_failed' }, 500)

    businessId = business.id
    subject = 'Sua página está no ar!'
    const publicUrl = `${siteUrl.replace(/\/$/, '')}/?site=${encodeURIComponent(business.slug)}`
    html = emailHtml(
      `<p>A página do seu negócio &quot;${escapeHtml(business.name ?? 'Seu negócio')}&quot; foi publicada com sucesso no PortalMicro.</p><p>Sua página já está disponível para seus clientes.</p><p><strong>Endereço para divulgação:</strong><br><a href="${escapeHtml(publicUrl)}" style="color:#2d6b55;overflow-wrap:anywhere">${escapeHtml(publicUrl)}</a></p><p>Você pode copiar esse endereço e divulgar no WhatsApp, Instagram, Facebook, Google Business Profile ou onde preferir.</p>`,
      'Ver minha página',
      publicUrl
    )
  }

  if (!recipient) return json({ error: 'recipient_unavailable' }, 422)

  const loadExisting = async () => {
    let query = supabase
      .from('notification_logs')
      .select('id, status, attempted_at')
      .eq('event_type', eventType)
      .eq('channel', 'email')
    query = eventType === 'welcome'
      ? query.eq('user_id', user.id)
      : query.eq('business_id', businessId)
    const { data } = await query.maybeSingle()
    return data as NotificationLog | null
  }

  let log = await loadExisting()
  if (log?.status === 'sent') return json({ status: 'already_sent' })

  const lease = new Date().toISOString()
  let ownsLease = false
  if (!log) {
    const { data, error } = await supabase
      .from('notification_logs')
      .insert({ user_id: user.id, business_id: businessId, event_type: eventType, recipient, attempted_at: lease })
      .select('id, status, attempted_at')
      .single()
    if (error?.code === '23505') log = await loadExisting()
    else if (error) return json({ error: 'reservation_failed' }, 500)
    else {
      log = data as NotificationLog
      ownsLease = true
    }
  }

  if (!log) return json({ error: 'reservation_failed' }, 500)
  if (log?.status === 'sent') return json({ status: 'already_sent' })
  if (!ownsLease) {
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString()
    if (log.status === 'pending' && log.attempted_at >= staleBefore) {
      return json({ status: 'processing' }, 202)
    }

    let retry = supabase
      .from('notification_logs')
      .update({ status: 'pending', recipient, error_message: null, sent_at: null, attempted_at: lease })
      .eq('id', log.id)
      .eq('status', log.status)
      .eq('attempted_at', log.attempted_at)
    if (log.status === 'pending') retry = retry.lt('attempted_at', staleBefore)
    const { data, error } = await retry.select('id').maybeSingle()
    if (error) return json({ error: 'reservation_failed' }, 500)
    if (!data) return json({ status: 'processing' }, 202)
    ownsLease = true
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'api-key': brevoApiKey },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: recipient }],
        subject,
        htmlContent: html,
      }),
    }).finally(() => clearTimeout(timeout))

    if (!response.ok) throw new Error(`Brevo HTTP ${response.status}`)
    const responseBody = await response.json().catch(() => null) as {
      messageId?: unknown
    } | null
    if (typeof responseBody?.messageId !== 'string') {
      throw new Error('Invalid Brevo response')
    }

    const { error: auditError } = await supabase
      .from('notification_logs')
      .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null })
      .eq('id', log!.id)
      .eq('status', 'pending')
      .eq('attempted_at', lease)
    if (auditError) {
      console.error('send-notification: falha ao registrar sucesso', { eventType })
      return json({ error: 'audit_update_failed' }, 500)
    }
    return json({ status: 'sent' })
  } catch (error) {
    const message = error instanceof DOMException && error.name === 'AbortError'
      ? 'Brevo request timeout'
      : error instanceof Error ? error.message.slice(0, 300) : 'Notification delivery failed'
    await supabase
      .from('notification_logs')
      .update({ status: 'failed', error_message: message })
      .eq('id', log!.id)
      .eq('status', 'pending')
      .eq('attempted_at', lease)
    console.error('send-notification: falha no envio', { eventType, message })
    return json({ status: 'failed' }, 502)
  }
})
