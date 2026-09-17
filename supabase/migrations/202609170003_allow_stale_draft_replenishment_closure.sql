-- GiroMicro Market
-- Migration 202609170003: permite encerrar/substituir lista draft obsoleta.
-- Nao altera migrations anteriores, supply, calculos ou materializacao.
begin;

do $migration$
declare v_def text;
begin
 select pg_get_functiondef('public.market_replenishment_guard_order_internal()'::regprocedure) into v_def;
 if v_def is null or strpos(v_def, 'or (old.status in (''approved'',''in_progress'') and new.status=''closed'')')=0 then
  raise exception 'REPLENISHMENT_DRAFT_CLOSE_UNEXPECTED_GUARD';
 end if;
 execute replace(v_def,
  'or (old.status in (''approved'',''in_progress'') and new.status=''closed'')',
  'or (old.status in (''draft'',''approved'',''in_progress'') and new.status=''closed'')');
end
$migration$;

do $migration$
declare v_def text;
begin
 select pg_get_functiondef('public.market_get_replenishment_closure_preview(uuid,uuid)'::regprocedure) into v_def;
 if v_def is null or strpos(v_def, 'if o.status not in (''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;')=0 then
  raise exception 'REPLENISHMENT_DRAFT_CLOSE_UNEXPECTED_PREVIEW';
 end if;
 execute replace(v_def,
  'if o.status not in (''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;',
  'if o.status not in (''draft'',''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;');
end
$migration$;

do $migration$
declare v_def text;
begin
 select pg_get_functiondef('public.market_close_replenishment_order(uuid,uuid,uuid,text)'::regprocedure) into v_def;
 if v_def is null or strpos(v_def, 'if o.status not in (''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;')=0 then
  raise exception 'REPLENISHMENT_DRAFT_CLOSE_UNEXPECTED_CLOSE';
 end if;
 execute replace(v_def,
  'if o.status not in (''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;',
  'if o.status not in (''draft'',''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;');
end
$migration$;

do $migration$
declare v_def text;
begin
 select pg_get_functiondef('public.market_close_and_create_replenishment_order(uuid,uuid,uuid,text)'::regprocedure) into v_def;
 if v_def is null or strpos(v_def, 'if not found or o.status not in (''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;')=0 then
  raise exception 'REPLENISHMENT_DRAFT_CLOSE_UNEXPECTED_RENEW';
 end if;
 execute replace(v_def,
  'if not found or o.status not in (''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;',
  'if not found or o.status not in (''draft'',''approved'',''in_progress'') then raise exception ''REPLENISHMENT_CLOSURE_ORDER_INVALID''; end if;');
end
$migration$;

comment on function public.market_get_replenishment_closure_preview(uuid,uuid) is
'Preview de encerramento: aceita draft, approved e in_progress; estados terminais permanecem invalidos.';
comment on function public.market_close_replenishment_order(uuid,uuid,uuid,text) is
'Encerra ciclo preservando snapshot/idempotencia: aceita draft, approved e in_progress.';
comment on function public.market_close_and_create_replenishment_order(uuid,uuid,uuid,text) is
'Encerra e cria nova analise/lista atomicamente: aceita draft, approved e in_progress.';

commit;
