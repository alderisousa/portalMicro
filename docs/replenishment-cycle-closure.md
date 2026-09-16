# Backend: encerramento do ciclo e abastecimento em lote

Migration: `202609160003_close_replenishment_cycle_and_bulk_supply.sql`.
Nao foi aplicada no Supabase. Nenhuma migration anterior ou frontend foi alterado.

## Contratos RPC

Todas as RPCs novas exigem usuario autenticado e a alcada consolidada existente
(owner/admin ou manager com todas as lojas). Helpers nao sao executaveis pelo cliente.

| RPC | Parametros apos `p_market_account_id` | Retorno |
| --- | --- | --- |
| `market_get_replenishment_closure_preview` | `p_order_id` | Identidade/data/run, `summary`, `needs`, compras |
| `market_close_replenishment_order` | `p_order_id`, `p_request_id`, `p_reason` opcional | Snapshot congelado |
| `market_close_and_create_replenishment_order` | `p_order_id`, `p_request_id`, `p_reason` opcional | `closedOrderId`, `newRunId`, `newOrderId`, `referenceDate`, `analysisTimestamp` |
| `market_get_replenishment_supply_batch_preview` | `p_order_id` | `items`, `stores`, contagens de lojas/produtos/allocations e unidades |
| `market_execute_replenishment_supply_batch` | `p_order_id`, `p_items`, `p_request_id` | Resultados das execucoes individuais |

No lote, enviar em `p_items` o array `items` do preview. A execucao compara o
conjunto completo de allocations, operation lines, origens e quantidades com a
fila atual sob lock. Divergencia gera `REPLENISHMENT_SUPPLY_BATCH_CONFLICT` e
exige novo preview. Nao se trata de uma ordem para transferir todo o Galpao:
confirma somente as quantidades prontas e planejadas, ja distribuidas fisicamente.
Replay exige o mesmo request e payload; reutilizacao conflitante e rejeitada.

## Estado e snapshot

`closed` e terminal, separado de `completed` e `cancelled`. Aceita fechamento de
somente `approved` e `in_progress`; draft ainda nao e uma ordem operacional.
`completed` preserva a conclusao normal legada e nao pode virar `closed`, reservado
ao encerramento antecipado. O evento de encerramento e `ORDER_CLOSED`.
A regra existente de uma ordem ativa por Market continua considerando somente
draft/approved/in_progress.

O snapshot JSONB versionado fica no cabecalho, junto de `closed_at`, `closed_by`
e `closure_reason`. Contem evidencias quantitativas por produto/loja, resumo e
compras consolidadas; nao duplica as tabelas de movimentos/eventos. Processado
vem de supply executions; pronto vem exclusivamente da fila homologada;
aguardando vem de compra confirmada sem receipt allocation; o restante sem
cobertura fica para comprar. Quantidades desconhecidas permanecem NULL.

`summary.processed` conta necessidades totalmente entregues. As contagens das
outras categorias indicam necessidades com quantidade naquela etapa; podem se
sobrepor em allocations mistas. Os campos de unidades discriminam as parcelas;
`stillToBuyKnownUnits` exclui quantidades desconhecidas, indicadas separadamente.

History preserva a resposta legada e acrescenta closed. Lista distingue
`closed_with_pending` de `closed` sem pendencias; detalhe acrescenta metadados do
fechamento e as quantidades congeladas. Alteracoes posteriores no estoque nao
recalculam essa classificacao. A RPC de preview de uma closed devolve o snapshot.

## Data confiavel e transacoes

Accesys: usa a integracao ativa selecionada pelo mesmo criterio do batch e o
maior `last_completed_day` anterior ao dia corrente, com checkpoint consistente,
`completed_days > 0`, dentro do periodo e sem `skipped_orders`. Pode aproveitar
dias persistidos antes de uma falha posterior; nunca usa simplesmente o
`period_end` de um run incompleto. Runs partial sao excluidos. Nao filtra source.
O dia corrente e excluido conservadoramente, pois uma sincronizacao realizada
durante o dia nao prova seu fechamento comercial.

Sem Accesys ativo, usa o periodo declarado de uma importacao finalizada nas
mesmas situacoes aceitas pelo batch (`completed`/`completed_with_pending`).
Importacao sem periodo confiavel nao autoriza o fechamento combinado.

Fechamento e novo ciclo usam o advisory lock existente por Market, locks de
ordem/Galpoes, batch manual real e materializacao a partir do run recem-gerado.
Erro de data, batch, materializacao ou ausencia de candidatos desfaz tudo,
inclusive o run e sua promocao. Sem candidatos retorna o erro de dominio
`REPLENISHMENT_ORDER_NO_CANDIDATES` e preserva a ordem anterior.

O lote reusa `market_execute_replenishment_store_supply` na mesma transacao,
na ordem da projecao da fila. Cada item gera os pares TRANSFER_OUT/TRANSFER_IN,
supply execution e progresso existentes. Falha em qualquer item desfaz todos.
`SUPPLY_BATCH_EXECUTED` guarda o request/payload/resultado para replay.

Guards de tabela impedem INSERT/UPDATE/DELETE de compromissos/fatos ligados a
closed: itens, allocations, operation lines, declaracoes, links NF, receipt
allocations, supply executions e liberacoes. Cabecalho e eventos tambem sao
protegidos. Os filtros operacionais existentes ja excluem closed; NF tardia
continua gerando PURCHASE/IN sem vincular nem reabrir a ordem. Geracao legada
que tentaria devolver uma closed do mesmo run exige analise fresca.

## Validacao local

`tests/replenishment-cycle-closure-db.test.mjs` usa PGlite, as migrations reais,
o batch real e fixtures comerciais locais. Cobre mistura de estados, snapshot,
guards, NF tardia, recebimento parcial integral, nova analise, fontes comerciais,
rollback em etapas intermediarias, lote, replay, permissoes e uma ordem ativa.

Suite de regressao focada: post-purchase, purchasing, history, progressive-release
e supply-fifo. Ha uma assercao preexistente de UI em
`replenishment-purchasing-db.test.mjs:180` que exige
`line.purchasedQuantity !== null`, ausente no componente atual. Esse teste nao
carrega a nova migration; o frontend permanece fora do escopo.

Limite real da validacao: PGlite nao exercita concorrencia entre sessoes de um
servidor PostgreSQL. Locks e atomicidade reutilizam o protocolo existente; ainda
e necessario homologar concorrencia no ambiente de destino antes da aplicacao.
Nao houve alteracao TypeScript; typecheck nao se aplica a esta entrega SQL.
