-- GiroMicro Market: identifica a origem dos novos runs de catalogo sem duplicar
-- a implementacao de aquisicao/concorrencia da migration 0003.
begin;

create function public.market_begin_product_sync(
    p_market_account_id uuid,
    p_integration_id uuid,
    p_requested_by uuid,
    p_page_size integer,
    p_source text
) returns uuid
language plpgsql security invoker set search_path = public
as $$
declare v_run_id uuid;
begin
    if p_source is null or p_source not in ('admin','inventory','scheduled') then
        raise exception 'PRODUCT_SYNC_INVALID_SOURCE';
    end if;
    v_run_id := public.market_begin_product_sync(
        p_market_account_id, p_integration_id, p_requested_by, p_page_size
    );
    update public.market_product_sync_runs
    set source = p_source
    where id = v_run_id
      and market_account_id = p_market_account_id
      and integration_id = p_integration_id;
    return v_run_id;
end;
$$;

revoke all on function public.market_begin_product_sync(uuid,uuid,uuid,integer,text)
    from public, anon, authenticated;
grant execute on function public.market_begin_product_sync(uuid,uuid,uuid,integer,text)
    to service_role;

commit;
