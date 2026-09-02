# market-sales-sync

Edge Function server-side que sincroniza vendas transacionais da Accesys usando
a RPC atomica `public.market_upsert_external_sale`. Nesta fase, somente Admin
global GiroMicro autenticado e validado por `public.is_admin()` pode executar a
sincronizacao. Perfis do Market nao recebem permissao de execucao.

## Requisicao

Somente `POST` com JSON:

```json
{
  "marketAccountId": "uuid",
  "integrationId": "uuid",
  "startDate": "YYYY-MM-DD",
  "endDate": "YYYY-MM-DD"
}
```

O periodo e inclusivo e limitado a 31 dias. URL, `companyId`, usuario e senha
sempre vem da integracao persistida; Bearer e senha nunca sao aceitos no request.

## Fluxo

1. Valida sessao com o client anonimo e autorizacao global com `is_admin()`.
2. Valida conta ativa/piloto, integracao Accesys ativa e credenciais pelo client
   service-role.
3. Adquire atomicamente um run `running` pela RPC service-role-only
   `market_begin_sales_sync`, antes do login Accesys.
4. Autentica com timeout de 10 segundos; o Bearer existe apenas em memoria.
5. Consulta a empresa inteira em `/oar/sites/orders/search/complete`, comeca em
   `page=1`, usa `pageSize=100` e aceita no maximo 10.000 paginas.
6. Resolve cada `order.siteId` exclusivamente pelo `external_store_id` de
   `market_store_external_refs` da mesma conta e integracao.
7. Normaliza cada pedido, chama `market_upsert_external_sale` e atualiza o
   heartbeat uma vez ao concluir cada pagina.
8. Fecha o run como `completed`, `partial` ou `failed`, sempre com contadores e
   `finished_at`. A tentativa de marcar falhas globais e best effort.

Se `pages` mudar durante a consulta, a execucao falha defensivamente para evitar
loop ou uma fotografia inconsistente. Datas Accesys sem offset sao interpretadas
em `America/Sao_Paulo` antes de chegar ao PostgreSQL.

Loja ausente, erro de mapper ou rejeicao da RPC afetam somente o pedido: o erro
sanitizado vai para `market_sales_sync_errors`, `skipped_orders` aumenta e os
demais pedidos continuam. O resultado sera `partial`. Falhas globais de login,
provider ou estrutura/paginacao encerram o run como `failed`.

Somente um run pode permanecer `running` para a mesma conta e integracao. Uma
segunda tentativa recebe `SYNC_ALREADY_RUNNING` (HTTP 409) antes de login ou
consulta na Accesys. O banco serializa a aquisicao com advisory transaction lock
e reforca a regra com indice unico parcial. Um run sem heartbeat por mais de 30
minutos e encerrado como `failed`, com mensagem sanitizada e historico preservado,
antes da criacao do substituto.

`heartbeat_at` nao possui default generico: a aquisicao pela RPC o inicializa
explicitamente. Runs historicos anteriores ao mecanismo podem manter o campo
`NULL`; a deteccao de stale usa `coalesce(heartbeat_at, started_at)`.

A resposta contem apenas o resumo sanitizado do run. As listas `errors` e
`unmappedSites` sao limitadas a 50 entradas; a auditoria completa permanece no
banco. Credenciais, token, PII, payload integral, SQL e stack trace nao retornam.

## Idempotencia e limites

A RPC e o banco sao a autoridade de idempotencia por conta, integracao e ID
externo do pedido. Reprocessar a mesma janela atualiza vendas existentes e
reconcilia itens/pagamentos quando os snapshots estiverem completos.

Esta etapa nao cria produtos, nao altera inventario, nao produz `SALE_OUT` e nao
escreve em tabelas de estoque. Tambem nao possui UI, cron ou agendamento. Uma
rolling window e o agendamento automatico ficam para uma etapa futura.

## Deploy manual futuro

Depois de validar a migration aplicada, os secrets server-side e os testes:

```sh
supabase functions deploy market-sales-sync
```

O deploy e a configuracao de secrets devem ser feitos manualmente no projeto
correto. Nenhum deploy faz parte da Sprint 4C.1 local.
