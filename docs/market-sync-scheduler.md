# Agendamento operacional Market

O agendamento reutiliza as Edge Functions existentes. `market-sync-scheduler`
somente descobre integrações Accesys ativas, isola o resultado por integração e
chama os mesmos pipelines resumíveis de produtos e vendas.

## Horários

- Produtos: `0 7 * * *` (07:00 UTC, atualmente 04:00 em America/Sao_Paulo).
- Vendas D-1: `10 7 * * *` (07:10 UTC, atualmente 04:10 em America/Sao_Paulo).

Vendas ficam dez minutos depois para evitar disputa desnecessária. O cálculo de
D-1 ocorre na Edge Function com `America/Sao_Paulo`, nunca pela data UTC do cron.

## Segredos

Configure `MARKET_SCHEDULER_SECRET` com o mesmo valor aleatório nas três Edge
Functions: `market-sync-scheduler`, `market-integration-admin` e
`market-sales-sync`. Não use nem exponha esse valor no frontend.

No Supabase Vault, crie os segredos `market_scheduler_url`,
`market_scheduler_secret` e `market_secret_api_key`. A URL deve terminar em
`/functions/v1/market-sync-scheduler`.

## Configuração manual do Cron

Depois de aplicar a migration 0005 e publicar as três Edge Functions, crie dois
jobs pelo Supabase Cron. Cada chamada deve enviar `apikey: <sb_secret_...>` e
`x-market-scheduler-secret`, ambos obtidos do Vault, com JSON
`{"task":"products"}` ou `{"task":"sales"}`. Não versione os valores.

Com as extensões `pg_cron`, `pg_net` e Vault habilitadas, o SQL manual é:

```sql
select cron.schedule('market-products-daily', '0 7 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='market_scheduler_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name='market_secret_api_key'),
      'x-market-scheduler-secret', (select decrypted_secret from vault.decrypted_secrets where name='market_scheduler_secret')
    ),
    body := '{"task":"products"}'::jsonb
  );
$$);

select cron.schedule('market-sales-daily', '10 7 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name='market_scheduler_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name='market_secret_api_key'),
      'x-market-scheduler-secret', (select decrypted_secret from vault.decrypted_secrets where name='market_scheduler_secret')
    ),
    body := '{"task":"sales"}'::jsonb
  );
$$);
```

Validação somente leitura após a migration 0005:

```sql
select to_regprocedure('public.market_begin_product_sync(uuid,uuid,uuid,integer,text)') is not null as signature_ok,
       has_function_privilege('service_role','public.market_begin_product_sync(uuid,uuid,uuid,integer,text)','EXECUTE') as service_role_ok,
       not has_function_privilege('authenticated','public.market_begin_product_sync(uuid,uuid,uuid,integer,text)','EXECUTE') as authenticated_blocked;
```

Confirme nos logs o resumo `integrationsFound`, `completed`, `failed`, `skipped`
e `results`. Falha de uma integração não interrompe as seguintes.

Se o Brasil voltar a adotar horário de verão, ajuste os horários UTC para
continuarem próximos de 04:00 em America/Sao_Paulo; o D-1 continuará correto.
