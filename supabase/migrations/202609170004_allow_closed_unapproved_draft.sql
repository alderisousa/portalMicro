-- GiroMicro Market
-- Migration 202609170004
-- Permite que uma ordem CLOSED tenha sido encerrada ainda em DRAFT,
-- sem fabricar aprovacao/revisao inexistente.
--
-- Escopo: somente market_replenishment_orders_approved_contract_check.
-- Nao altera dados, RPCs, triggers, supply ou regras da reposicao.

begin;

do $migration$
declare
    v_definition text;
begin
    select pg_get_constraintdef(oid)
      into v_definition
      from pg_constraint
     where conrelid = 'public.market_replenishment_orders'::regclass
       and conname = 'market_replenishment_orders_approved_contract_check';

    if v_definition is null then
        raise exception
            'REPLENISHMENT_APPROVED_CONTRACT_NOT_FOUND';
    end if;

    -- Protecao: so substituir o contrato atualmente conhecido.
    if v_definition <> 'CHECK (((status = ANY (ARRAY[''draft''::text, ''cancelled''::text])) OR ((approved_at IS NOT NULL) AND (approval_revision > 0))))' then
        raise exception
            'REPLENISHMENT_APPROVED_CONTRACT_UNEXPECTED: %', v_definition;
    end if;
end
$migration$;

alter table public.market_replenishment_orders
    drop constraint market_replenishment_orders_approved_contract_check,
    add constraint market_replenishment_orders_approved_contract_check
    check (
        status in ('draft', 'cancelled')
        or (
            status = 'closed'
            and (
                approval_revision = 0
                or (
                    approved_at is not null
                    and approval_revision > 0
                )
            )
        )
        or (
            approved_at is not null
            and approval_revision > 0
        )
    );

comment on constraint market_replenishment_orders_approved_contract_check
on public.market_replenishment_orders is
'Ordens operacionais exigem aprovacao. CLOSED pode vir de DRAFT nunca aprovado (revision 0) ou de ordem previamente aprovada.';

commit;
