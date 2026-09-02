-- GiroMicro Market - Sprint 4A: endurecimento dos grants de configuracao
-- de integracoes expostos ao frontend autenticado.
begin;

revoke all on public.market_integrations from authenticated;
grant select, insert, update, delete
    on public.market_integrations
    to authenticated;

revoke all on public.market_store_external_refs from authenticated;
grant select, insert, update, delete
    on public.market_store_external_refs
    to authenticated;

commit;
