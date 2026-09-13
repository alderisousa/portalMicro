begin;

alter table public.market_integrations
    add column automatic_sync_enabled boolean not null default true;

comment on column public.market_integrations.automatic_sync_enabled is
    'Controla apenas a participacao no scheduler; sincronizacoes manuais continuam dependendo do status da integracao.';

commit;
