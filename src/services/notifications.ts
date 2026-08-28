import { supabase } from '../lib/supabase'

export type NotificationEvent = 'welcome' | 'business_published'

type NotificationPayload = {
  eventType: NotificationEvent
  businessId?: string
}

export const sendNotification = async (
  eventType: NotificationEvent,
  businessId?: string
) => {
  const payload: NotificationPayload = { eventType }
  if (businessId) payload.businessId = businessId

  const { data, error } = await supabase.functions.invoke(
    'send-notification',
    { body: payload }
  )

  if (error) {
    console.error('Não foi possível processar a notificação.', error)
    return { status: 'failed' as const }
  }

  return data as {
    status: 'sent' | 'already_sent' | 'processing' | 'failed'
  }
}
