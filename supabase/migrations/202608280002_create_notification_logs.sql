create table public.notification_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  business_id uuid,
  event_type text not null,
  channel text not null default 'email',
  recipient text not null,
  status text not null default 'pending',
  error_message text,
  sent_at timestamptz,
  attempted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint notification_logs_event_type_check
    check (event_type in ('welcome', 'business_published')),
  constraint notification_logs_channel_check
    check (channel in ('email')),
  constraint notification_logs_status_check
    check (status in ('pending', 'sent', 'failed')),
  constraint notification_logs_business_context_check
    check (
      (event_type = 'welcome' and business_id is null)
      or (event_type = 'business_published' and business_id is not null)
    )
);

create index notification_logs_user_id_idx
  on public.notification_logs (user_id);
create index notification_logs_business_id_idx
  on public.notification_logs (business_id);
create index notification_logs_event_type_idx
  on public.notification_logs (event_type);
create index notification_logs_status_idx
  on public.notification_logs (status);

create unique index notification_logs_welcome_unique_idx
  on public.notification_logs (user_id, channel)
  where event_type = 'welcome';

create unique index notification_logs_business_published_unique_idx
  on public.notification_logs (business_id, channel)
  where event_type = 'business_published';

alter table public.notification_logs enable row level security;

revoke all on table public.notification_logs from anon, authenticated;
grant select, insert, update on table public.notification_logs to service_role;

comment on table public.notification_logs is
  'Server-managed audit and idempotency log for PortalMicro notifications.';
comment on column public.notification_logs.attempted_at is
  'Lease timestamp used to safely retry failed or abandoned pending deliveries.';
