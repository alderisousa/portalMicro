-- GiroMicro Market - Sprint 3B.2A: endurecimento dos grants das RPCs publicas.
-- Remove acesso anonimo/implicitamente publico e preserva authenticated.
begin;

revoke execute on function public.admin_list_market_link_stores(uuid)
    from anon, public;
revoke execute on function public.market_get_commercial_dashboard(uuid,uuid)
    from anon, public;
revoke execute on function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean)
    from anon, public;
revoke execute on function public.market_append_sales_import_chunk(uuid,uuid,jsonb)
    from anon, public;
revoke execute on function public.market_finalize_sales_import(uuid,uuid)
    from anon, public;

grant execute on function public.admin_list_market_link_stores(uuid)
    to authenticated;
grant execute on function public.market_get_commercial_dashboard(uuid,uuid)
    to authenticated;
grant execute on function public.market_begin_sales_import(uuid,text,text,date,date,text,integer,text[],boolean)
    to authenticated;
grant execute on function public.market_append_sales_import_chunk(uuid,uuid,jsonb)
    to authenticated;
grant execute on function public.market_finalize_sales_import(uuid,uuid)
    to authenticated;

commit;
