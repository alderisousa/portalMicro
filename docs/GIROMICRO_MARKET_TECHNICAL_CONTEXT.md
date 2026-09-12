# GiroMicro Market — Contexto técnico atual

> Documento vivo do estado observado no repositório em 2026-09-12. Descreve o código, as migrations aplicadas/homologadas e a integração frontend existente; não é um contrato de funcionalidades futuras.

## 1. Visão geral da arquitetura

- **Frontend:** React + TypeScript + Vite. A entrada é `src/main.tsx`; o estado principal de telas ainda é controlado por `src/App.tsx`, com navegação interna por estado (`view`) e componentes/páginas em `src/pages`.
- **Backend de dados do Market:** Supabase Auth + PostgreSQL via `@supabase/supabase-js`. O cliente fica em `src/lib/supabase.ts` e usa `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`.
- **Autenticação:** o frontend usa Supabase Auth, atualmente com restauração de sessão e OAuth Google. O usuário efetivo é `auth.uid()` no banco. O modo demonstração do portal não equivale a uma sessão Market autorizada.
- **Autorização:** RLS, funções auxiliares e RPCs `security definer`. O administrador geral da plataforma é reconhecido por `market_is_platform_admin()`/`is_admin()`; usuários Market são vinculados por `market_account_members`.
- **Multi-tenant:** `market_account_id` está presente nas entidades de negócio e nas FKs compostas importantes. Isolamento por conta é reforçado por RLS, validações nas RPCs e joins que exigem o mesmo `market_account_id`.
- **Locais:** `market_stores` representa tanto loja quanto galpão. `store_type = 'store'` é ponto comercial; `store_type = 'warehouse'` é galpão/CD. Não existe tabela separada de galpão.
- **Organização relevante:** `src/services/market.ts` resolve conta, membros e lojas; `marketStock.ts` concentra estoque/inventário; `marketPurchases.ts` concentra compras; `marketReplenishment.ts` lê reposição e a Lista de Compras consolidada; `marketReconciliation.ts` trata conciliação; serviços de vendas/importação e integração ficam em `src/services/marketSales*`, `marketSalesImport.ts` e `marketIntegration.ts`.
- **Integração externa:** funções Edge `market-purchase-import`, `market-sales-sync`, `market-integration-admin` e `market-sync-scheduler` atendem importação de compras, vendas e Accesys. Credenciais de integração são server-side e cifradas em `market_integration_credentials`.

## 2. Modelo de acesso

### Roles e escopo

As roles de `market_account_members` são: `owner`, `admin`, `manager`, `operator` e `viewer`. O status do vínculo é `invited`, `active` ou `disabled`; o frontend só carrega contas do usuário com vínculo `active`.

- `owner` e `admin` têm acesso a todas as lojas da conta.
- `manager`, `operator` e `viewer` podem ter `all_stores = true` ou uma lista explícita em `market_member_stores`.
- O escopo de loja é aplicado por `market_can_access_store(store_id)`. Conta operacional é `pilot` ou `active`; `suspended` e `cancelled` bloqueiam a operação.
- Na administração da plataforma, `AdminMarketAccount` gerencia membros, lojas, status e plano por RPCs administrativas. A conta Market é aberta no painel administrativo.

### Padrões de RLS e RPC

O padrão geral é `market_is_member(market_account_id)` para leitura por tenant, combinado com `market_can_access_store(store_id)` quando o dado é de uma loja. Escritas administrativas normalmente exigem `market_has_role(account, ['owner','admin','manager'])`; operações de estoque restringem também `viewer` e o escopo da loja.

Movimentos de estoque e rascunhos de inventário não são escritos diretamente pelo frontend: RPCs `security definer` fazem autenticação, papel, conta operacional, loja, locks e idempotência. Compras têm leitura por RLS, mas a conferência/recebimento usa RPCs. As entidades de integração e credenciais não são expostas ao frontend como dados livres.

### Como a conta/loja atual é identificada

`App.tsx` carrega `listCurrentUserMarketAccounts()`, guarda as contas em `marketAccounts` e seleciona `selectedMarketAccountId`. Ao abrir o Market, passa o `accountId` para `MarketDashboard`. A tela chama `getCurrentUserMarketAccess(accountId)`, que consulta `auth.getUser()`, o vínculo ativo e as lojas permitidas. `CurrentUserMarketAccess.stores` é a fonte do escopo de lojas usado pelas telas; não há seleção operacional persistida em uma rota URL.

## 3. Estruturas principais do Market

A lista abaixo resume somente tabelas relevantes e seus vínculos principais.

### Administração

- `market_accounts`: tenant Market; PK `id`; status `pilot|active|suspended|cancelled`, plano, criador e referência de parceiro.
- `market_account_members`: vínculo usuário-conta; PK `id`; FKs para `market_accounts` e `auth.users`; role, `all_stores` e status.
- `market_member_stores`: associação membro-local; PK composta (`market_account_member_id`, `market_store_id`).

### Lojas/Galpão

- `market_stores`: locais do tenant; PK `id`, FK `market_account_id`; `store_type` (`store|warehouse`), status e `stock_control_started_at`.
- `market_external_store_mappings`: mapeia código de loja de fonte legada para `market_store_id`.
- `market_store_external_refs`: referência de loja por integração (`integration_id`, `external_store_id`), usada no fluxo transacional.

### Produtos, catálogo e mapeamentos

- `market_products`: catálogo por Market; PK `id`, FK tenant; `sku`, `ean`, nome, unidade e status.
- `market_store_products`: configuração produto-loja; unique (`market_store_id`, `product_id`); `minimum_stock`, `sale_price`, `is_essential` e status.
- `market_product_mappings`: de/para de produto de integração; FK composta para `market_products`; código/EAN/descrição externos e confiança.
- `market_purchase_product_mappings`: de/para específico de fornecedor; FK `market_product_id`; identidade composta por tenant, fornecedor/documento, código, barcode e descrição normalizados. Não é histórico de fornecedor.
- `market_purchase_unit_conversions`: conversões de embalagem/unidade por fornecedor/produto, usadas para converter item fiscal em unidade de estoque.

### Vendas/importações

- `market_sales_imports`: cabeçalho de arquivo; FK tenant; hash, período, status e contadores.
- `market_sales_import_rows`: linhas importadas; FK composta para importação, loja e produto; dados externos, quantidade, data e status.
- `market_sales`: venda transacional; FK tenant, loja, integração e referência externa; origem, data, status externo, valores e idempotência externa.
- `market_sale_items`: itens da venda; FK para venda/produto; quantidade, produto/códigos externos e snapshots de custo.
- `market_sale_payments`: pagamentos; FK para venda.

### Integração Accesys

- `market_integrations`: configuração não sensível por tenant; provider, URL, empresa externa, status `inactive|active|error` e timestamps de sync/teste.
- `market_integration_credentials`: uma credencial por integração; FK composta; usuário e senha cifrada. A chave não fica no banco.
- `market_product_store_data`: dados comerciais sincronizados por produto-loja-integração; quantidades externas são diagnósticas e não alimentam o ledger.
- `market_store_external_refs`: ligação entre loja Market e loja externa.
- `market_sales_sync_runs`: auditoria/concorrência das sincronizações de vendas; vinculada a Market e integração.

### Estoque e inventário

- `market_stock_movements`: ledger append-only de movimentos, FK tenant/loja/produto; tipo, direção, quantidade, custo, referência e data.
- `market_stock_balance`: view derivada de `market_stock_movements`, agrupada por tenant/loja/produto; `quantity_on_hand` e último movimento.
- `market_inventory_sessions`: sessão de inventário por loja; FK tenant/loja; tipo `initial|cycle`, status, versão e timestamps.
- `market_inventory_session_items`: itens da sessão; FK sessão/produto; quantidade, `is_counted`, motivo e versão do item.

### Compras

- `market_purchases`: documento/compra; FK tenant e `destination_store_id`; fornecedor, nota, datas, totais, origem, status e revisão.
- `market_purchase_items`: linhas do documento; FK compra/produto opcional; dados fiscais, conciliação, conversão, custo de estoque, revisão e recebimento.
- `market_purchase_product_mappings`: de/para persistente do fornecedor, conforme descrito acima.
- `market_purchase_unit_conversions`: conversão persistida para reuso; não gera movimento por si só.

### Reposição Inteligente

- `market_replenishment_settings`: configuração padrão por Market ou override por loja; demanda, cobertura, aceleração e essencial sem venda.
- `market_replenishment_runs`: execução do batch; FK tenant; data de referência, versão do algoritmo, status, origem, efetividade e contadores.
- `market_replenishment_candidates`: snapshot dos candidatos por run/loja/produto; FK compostas para run, loja e produto; estoque, demanda, motivos, score, prioridade, ranking e sugestão.

### Lista de Compras

- `market_replenishment_orders`: cabeçalho de lista por run; FK tenant/run; status, aprovação, conclusão e cancelamento.
- `market_replenishment_order_items`: um produto consolidado por lista; FK lista/produto; totais sugeridos, saldo do galpão, compra sugerida, ajuste, comprado, excedente, origem e cancelamento de revisão. A lista operacional só materializa candidatos com necessidade conhecida.
- `market_replenishment_order_allocations`: allocation item-loja; FK item/loja/candidato; sugestão, divisão galpão-compra, ajustes e quantidades alocadas, despachadas e recebidas. Quantidades operacionais conhecidas são inteiras por arredondamento para cima; `NULL` permanece no batch/análise e não entra na operação.

## 4. Estoque

### Fonte de verdade

`market_stock_movements` é o livro-raiz operacional. `market_stock_balance` é uma view derivada: soma `IN` e subtrai `OUT` por `market_account_id`, `market_store_id` e `product_id`. O frontend consulta saldo por `market_get_stock_balance`; não deve tratar saldo externo de Accesys (`external_available_quantity`) como saldo operacional.

Os tipos relevantes são `PURCHASE`, `SALE`, `TRANSFER_IN`, `TRANSFER_OUT`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`, `LOSS` e `INVENTORY`, com direção coerente `IN|OUT`. Há índice de idempotência por referência de origem/item. Movimentos passam a ser gravados por RPCs auditáveis.

### Store x warehouse

`store_type = 'store'` participa de vendas, demanda e candidatos de reposição. `store_type = 'warehouse'` é galpão/CD: pode ter estoque e movimentos de entrada/saída permitidos pelo domínio, mas não recebe `SALE`, não entra no Dashboard Comercial e não recebe candidato próprio de reposição. O batch soma o saldo de todos os warehouses do Market em `warehouse_stock`.

### Inventário

O inventário inicial cria movimentos `INVENTORY/IN` atômicos e marca `stock_control_started_at`. Inventário `cycle` reconcilia a contagem com o saldo vigente sem alterar movimentos anteriores. Rascunhos não alteram saldo; só a finalização gera movimentos. Contagem zero é explícita (`is_counted = true`, quantidade `0`), enquanto ausência do item significa não contado. A finalização exige motivo coerente para divergências e há concorrência por sessão e por item.

### PURCHASE e regras homologadas

O recebimento de compra gera `PURCHASE/IN` no destino da compra, com `reference_type = 'PURCHASE'`, `reference_id = market_purchase_id` e `reference_item_id = market_purchase_item_id`. A operação é idempotente e uma linha é indivisível: entra 100% ou não entra. O item precisa estar conciliado, convertido para unidade de estoque, conferido por humano e ter custo unitário de estoque conhecido.

O saldo pode ser nulo por ausência de histórico; zero é saldo conhecido. A view não é fonte de escrita. O warehouse não é uma exceção ao ledger: é apenas um local com tipo diferente.

## 5. Compras

O fluxo atual é:

`documento -> staging -> conciliação -> revisão/conferência -> recebimento -> movimento de estoque`

- **Staging:** `market_import_purchase_staging` e `market_import_pdf_purchase_staging` persistem em `market_purchases` + `market_purchase_items`; não existe tabela separada `market_purchase_staging`. Há importação por QR/access key/NF-e, PDF e texto IA conforme os componentes atuais.
- **Conciliação:** `market_product_id` é a ligação da linha ao catálogo. O método pode ser `ean_exact`, `purchase_mapping`, `manual` ou outros valores informativos; estados são separados da entrada de estoque. O mapping de fornecedor é reutilizado para identidade, não para dizer qual foi o último fornecedor.
- **Revisão:** `original_data`, `reviewed_at` e `reviewed_by` preservam o original e a ação humana. Correções invalidam revisão/conciliação quando necessário; há controle de concorrência por `updated_at`.
- **Fornecedor:** fica em `market_purchases.supplier_name`/`supplier_document`; o item aponta para a compra. O documento pode não ter fornecedor preenchido.
- **Conversão e custo:** `conversion_factor`, `stock_unit`, `stock_quantity` e `stock_unit_cost` transformam a unidade fiscal. A entrada exige `stock_unit_cost` não nulo; custo ausente não gera estoque.
- **Recebimento parcial:** é parcial por linhas, não por quantidade. O primeiro recebimento processa todos os itens prontos ainda pendentes; a compra fica `receiving` se restarem itens e `completed` quando todas as linhas estiverem recebidas. Não há recebimento parcial de uma mesma linha nem estorno/devolução implementado.
- **Compra efetivamente recebida:** uma linha foi recebida quando `stock_entry_status = 'received'`, `received_at`/`received_by` estão preenchidos e existe o movimento `PURCHASE` correspondente. A compra está totalmente recebida quando `market_purchases.status = 'completed'`; `receiving` indica recebimento parcial por linhas.

### Último fornecedor válido de um `product_id`

Usar o conjunto de `market_purchase_items` com `market_product_id = product_id` e `stock_entry_status = 'received'`, juntar `market_purchases` pelo tenant, restringir a compra a `status in ('receiving','completed')` e exigir o movimento `market_stock_movements` com `movement_type = 'PURCHASE'`, `reference_type = 'PURCHASE'`, `reference_id = purchase.id` e `reference_item_id = item.id`. Ordenar por `coalesce(p.issued_at, item.received_at, movement.occurred_at)` desc, depois recebimento, operação e `item.id`; a primeira linha é o fornecedor válido mais recente. Essa é a regra implementada em `market_get_replenishment_order`.

## 6. Reposição Inteligente

### Estruturas e RPC

`market_run_replenishment_batch(p_market_account_id, p_reference_date, p_run_source)` grava um run e candidatos. O run aceita `scheduled|manual`; usuário autenticado só executa `manual` e precisa de `owner|admin|manager`. O scheduler/serviço confiável pode executar sem `auth.uid()`.

O batch processa lojas ativas (`store_type = 'store'`), resolve override de configuração por loja antes do padrão do Market e usa Accesys ativa quando há exatamente uma integração; com zero integrações usa importação de vendas confirmada; mais de uma Accesys ativa é ambiguidade e falha.

### Regras presentes

As regras persistidas em `trigger_reasons` são `STOCKOUT`, `BELOW_MINIMUM`, `LOW_COVERAGE`, `SALES_ACCELERATION` e `ESSENTIAL_NO_RECENT_SALES`. A demanda usa M7/M14/M30 ou pesos configurados; cobertura só é calculada com estoque conhecido e demanda positiva. O algoritmo guarda snapshot de estoque/configuração e pontuação, não recalcula na tela.

- O limite persistido é **TOP 200 por loja**; `products_triggered` e `triggered_over_limit_count` preservam o que ficou fora do teto.
- Prioridade é `critical`, `high`, `medium`, `low`, com `priority_score` e `rank_position`.
- `current_stock = NULL` significa ausência de histórico, não zero. Zero é saldo conhecido e pode gerar `STOCKOUT`.
- `suggested_quantity = NULL` permanece desconhecida quando o cálculo não consegue determinar uma quantidade; não deve ser convertida em zero. Esses candidatos continuam no batch, mas não são materializados na Lista de Compras operacional.
- `warehouse_stock` é snapshot agregado do saldo dos warehouses e pode ser `NULL` quando não há galpão aplicável.

### Último run efetivo

A tela `MarketReplenishment` não dispara o batch. `marketReplenishment.ts` lê `market_replenishment_runs` com `status = 'completed'` e `is_effective = true`, ordenando por `reference_date` e `started_at` desc; depois lê candidatos desse run e resolve nomes em `market_products`. Esse é o critério do último run efetivo.

## 7. Lista de Compras

### Estado aplicado/homologado

As três tabelas existem: `market_replenishment_orders`, `market_replenishment_order_items` e `market_replenishment_order_allocations`. A geração de draft é feita por `market_generate_replenishment_order_draft(account_id)`, que exige vínculo com `owner/admin` ou `manager` com `all_stores`, usa o último run efetivo e é idempotente por run não cancelado.

A migration `202609120003` define o ciclo `draft -> approved -> in_progress -> completed`, além de `cancelled`, com `started_at`, `started_by` e `approval_revision`. `market_replenishment_operation_lines` guarda metas aprovadas por allocation e frente; `market_replenishment_order_events` registra eventos append-only. A aprovação cria as linhas operacionais, encerra a revisão e não inicia a operação. Compra externa e Galpão são frentes independentes.

A consolidação é somente uma visão/soma das allocations. A revisão operacional é por allocation/loja, com `Necessidade = Do Galpão + Comprar`; a RPC aceita a decomposição Galpão/Comprar da allocation. Não há rateio automático a partir da Consolidada. Reopen e supersede só são permitidos antes do início operacional; supersede materializa a nova order antes de cancelar a anterior. `stale` compara a order com o batch mais novo elegível.

As migrations `202609120004` e `202609120005` aplicam o mesmo critério operacional na geração pública e no helper interno usado por supersede: `priority_level IN ('critical','high','medium') AND suggested_quantity IS NOT NULL`. Candidatos desconhecidos continuam no batch/análise, `NULL` não vira zero e `LOW` continua fora da lista operacional.

A migration aplicada/homologada `202609110002_round_replenishment_operational_quantities.sql` mantém o cálculo analítico do batch decimal, mas arredonda para cima (`CEIL`) as quantidades materializadas/operacionais da lista em itens e allocations. Ex.: necessidade analítica `2,4833` vira necessidade operacional `3`; `NULL` permanece `NULL`.

`market_get_replenishment_order(account_id, order_id?)` retorna JSON da lista, itens, prioridade, allocations e o último fornecedor válido. Inclui `suggested_purchase_quantity`, `adjusted_purchase_quantity`, `effectivePurchaseQuantity`, `warehouse_surplus_quantity` e custo do último recebimento.

### Revisão pré-compra implementada no backend

A migration aplicada/homologada `202609100018_replenishment_order_review_backend.sql`, complementada pela `202609120003`, adiciona e usa:

- `market_replenishment_order_items.source`: `batch`, `manual_review`, `manual_purchase`; no estágio atual da revisão, batch e inclusão manual em revisão são gerados.
- `review_cancelled_at`, `review_cancelled_by` e `review_cancellation_reason`: cancelamento lógico do item durante a revisão.
- `adjusted_purchase_quantity`: compatibilidade do item consolidado; a revisão operacional nova é feita na allocation.
- RPCs `market_update_replenishment_allocation_review`, `market_add_replenishment_order_manual_item`, `market_cancel_replenishment_order_item_review` e `market_approve_replenishment_order`.
- Aprovação muda o cabeçalho de `draft` para `approved`, cria operation lines por frente e preenche `approved_at`, `approved_by` e `approval_revision`, sem preencher `started_at`.

Isso é **IMPLEMENTADO no banco e homologado no Supabase**. O frontend executa a revisão por loja enquanto a lista está `draft`, inclui produto ativo do catálogo somente na loja selecionada, permite retirada lógica e aprova a order inteira.

### Frontend de leitura e revisão pré-compra

`src/services/marketReplenishment.ts` consome `market_generate_replenishment_order_draft`, `market_get_replenishment_order`, `market_update_replenishment_allocation_review`, `market_add_replenishment_order_manual_item`, `market_cancel_replenishment_order_item_review` e `market_approve_replenishment_order`. `src/pages/MarketReplenishment.tsx` oferece o seletor `Consolidada`/loja individual. A Consolidada é read-only e soma as allocations; a loja individual permite revisar `Do Galpão` e `Comprar` por allocation, com autosave no `blur`/Enter. O botão `Aprovar lista` aparece somente na Consolidada porque a aprovação é da order inteira. A inclusão manual só existe em contexto de loja. Após `approved`, a lista fica somente leitura. Itens `status='cancelled'` não entram na lista normal exibida.

### Homologação operacional de 2026-09-11

Cenário homologado no Supabase para `Chiclete Bubbaloo Uva 5g` / `SAL DA TERRA III`:

- estoque loja = `1`;
- necessidade analítica = `2,4833`;
- necessidade operacional = `3`;
- estoque Galpão = `5`;
- atendido pelo Galpão = `3`;
- compra necessária = `0`;
- prioridade `HIGH`;
- motivos `LOW_COVERAGE` + `SALES_ACCELERATION`.

### Smoke homologado de 2026-09-12

- **Conta:** `f825aa1c-fa92-4740-b126-c117c6ad1b94`
- **Batch:** `2f3fab2b-5860-43bc-9d37-b7707d53b661`
- **Order:** `e00f7b35-868e-441f-9307-a091ab7b78a7`
- **Caso desconhecido:** `COCA COLA ORIGINAL 2 5` (EAN `7894900027020`); permanece no batch com `current_stock = NULL` e `suggested_quantity = NULL`, mas não entra na nova order após `202609120004` + `202609120005`.
- **Itens operacionais:** `ANTARCTICA GUARANA LATA 350ML` (3 / Galpão 0 / Comprar 3), `Chiclete Bubbaloo Uva 5g` (3 / Galpão 3 / Comprar 0) e `3 CORACAO CAFE TRADICIONAL 500G` (1 / Galpão 0 / Comprar 1).
- **Aprovação:** `status = approved`, `approval_revision = 1`, `started_at = NULL`; eventos `ORDER_CREATED` e `ORDER_APPROVED`, sem operação iniciada.
- **Operation lines:** purchase 3, purchase 1 e warehouse 3; todas com `confirmed_quantity = 0`, `started_at = NULL` e `completed_at = NULL`.
- **UX:** Aprovar lista oculto em loja individual e visível somente na Consolidada; após aprovação, a lista fica somente leitura.

### Estados da lista e da execução

Cabeçalho: `draft`, `approved`, `in_progress`, `completed`, `cancelled`; aprovação não inicia operação. Item consolidado: `pending`, `partial`, `fulfilled`, `cancelled`. Allocation: `pending`, `allocated`, `dispatched`, `received`, `cancelled`.

## 8. Fluxo funcional da Lista de Compras

### FASE 1 — revisão pré-compra

**IMPLEMENTADO:** geração de draft no backend; consolidação por produto; exclusão operacional de necessidades desconhecidas; rateio por loja; consideração do saldo do warehouse; preservação de `NULL` no batch; arredondamento operacional para cima; leitura de último fornecedor; revisão por allocation; inclusão manual por loja; retirada lógica com motivo; aprovação da order inteira via RPC; estados, eventos e constraints correspondentes. A tela abre a Consolidada, permite revisar cada loja e exibe aprovação somente na Consolidada.

**DEFINIDO / PENDENTE:** stale na interface, canReopen, canSupersede, botões Reabrir/Substituir, lista Galpão -> Loja, separação física, despacho, recebimento, compra externa, fornecedor, scanner de compra, movimentos OUT/IN operacionais, vínculo com purchase items e conciliação com NF. A lista não deve depender de cache/localStorage como fonte operacional.

### FASE 2 — purchasing/operação no Market

**IMPLEMENTADO:** o backend já modela operation lines, eventos e metas por frente para a evolução operacional posterior; a UI de execução física ainda não faz parte deste pacote.

**DEFINIDO / PENDENTE:** tela de operação; inclusão manual durante compra (`source = manual_purchase` ainda não é gerada pelo fluxo atual); scanner EAN nessa operação; “marcar peguei” e remoção temporária; persistência/retomada do estado operacional; priorização por fornecedor; ligação completa com compra, separação, despacho e recebimento. Esses itens não devem ser tratados como implementados só porque existem colunas/status.

## 9. Scanner e componentes reutilizáveis

- `src/components/BarcodeScanner.tsx` é um modal reutilizável de câmera, usando `@zxing/browser`, `getUserMedia`, câmera traseira preferencial e callback `onDetected`.
- Uso confirmado: `src/pages/MarketStockDashboard.tsx` para busca/seleção de produto no Estoque e `src/components/PurchaseItemReconciliationDialog.tsx` para conciliação de item de compra.
- `QrCodeScanner.tsx` segue padrão de captura semelhante, mas é componente separado para QR.
- Padrões reutilizados: Estoque usa RPCs de saldo/inventário, drafts versionados e funções de escopo por loja; Inventário usa sessão persistente, autosave, concorrência por item e histórico; Compras usa cards expansíveis, leitura sob demanda, RPCs de revisão/recebimento e locks; Reposição usa leitura direta de runs/candidatos com agrupamento frontend por loja, sem recalcular prioridade.

## 10. Rotas e telas principais

A navegação Market não usa rotas URL dedicadas. `App.tsx` mantém `view = 'market'`, `selectedMarketAccountId` e renderiza `MarketDashboard` quando o usuário está autenticado e a conta selecionada existe. Dentro do dashboard, flags booleanas abrem telas sem trocar a URL.

- **MarketDashboard:** entrada do Market; valida acesso, status da conta, role e lista de lojas; abre recursos.
- **MarketReplenishment:** aberta internamente pelo botão “Abastecimento”; lê o último run efetivo, mantém a visão de necessidades por loja, abre a Lista de Compras consolidada via RPCs de draft/leitura e executa a revisão pré-compra em `draft`.
- **Estoque:** `MarketStockDashboard`, aberta internamente pelo botão “Estoque”; engloba saldo, inventário inicial/cíclico, histórico e mínimos.
- **Compras:** `MarketPurchases`, aberta internamente pelo botão “Compras”; disponível no dashboard para roles diferentes de `operator`, com galpões ativos como destino e importação limitada a `owner/admin/manager`.
- **Administração:** `Admin.tsx` e `AdminMarketAccount.tsx` são telas administrativas da plataforma para conta Market, membros, lojas, status e plano; entram pelo estado interno `view = 'admin'`, não por uma rota Market URL.

## 11. Migrations

As migrations são SQL versionado em `supabase/migrations`. As migrations `202609100016`, `202609100017`, `202609100018`, `202609110001` e `202609110002` da Lista de Compras estão aplicadas e homologadas no Supabase.

Migrations estruturais relevantes:

- `202608310001` — núcleo multi-tenant, catálogo, compras iniciais, vendas importadas, transfers, ledger e helpers de autorização.
- `202608310003`/`004`/`005` — administração Market, acesso de conta suspensa e vínculos administrativos.
- `202609010001`–`006` — fundação do estoque/inventário, ciclos, lookup de produtos e distinção store/warehouse.
- `202609020001`–`004` — integrações, vendas transacionais e concorrência/resumibilidade de sync.
- `202609030001`–`005` — escopo comercial/operator e sync de produtos.
- `202609040001`–`011` — staging, reimportação, conciliação, escopo Accesys e ranking de candidatos.
- `202609070001`–`006` — revisão humana, conversão de unidade, texto IA e recebimento; os comentários dessas migrations marcam partes como aplicação manual e dependências já aplicadas.
- `202609080001`–`005` — automação da revisão de compra, correção de inventário inicial, motivos/sentidos e concorrência por item.
- `202609090001`–`002` — histórico de sessões de inventário e índice de mappings.
- `202609100001`–`015` — configuração, runs, candidatos e RPC do batch de Reposição Inteligente; a própria migration `202609100015` registra `202609100014` como já aplicada em homologação e **IMUTÁVEL**.
- `202609100016` — geração de draft e rateio warehouse/compra; **aplicada/homologada**.
- `202609100017` — leitura consolidada com último fornecedor válido; **aplicada/homologada**.
- `202609100018` — backend da revisão pré-compra; **aplicada/homologada**.
- `202609110001` — correção de consolidação com quantidade desconhecida: qualquer allocation com `suggested_quantity NULL` mantém `total_suggested_quantity` e `suggested_purchase_quantity` como `NULL`; **aplicada/homologada**.
- `202609110002` — arredondamento operacional para cima (`CEIL`) das quantidades conhecidas materializadas na lista; **aplicada/homologada**.
- `202609120001_filter_replenishment_draft_priorities.sql` — lista operacional aceita somente `CRITICAL`/`HIGH`/`MEDIUM`; o batch continua calculando e armazenando `LOW` no histórico. **Aplicada/homologada.**
- `202609120002_add_store_to_manual_replenishment_item.sql` — inclusão manual exige `store_id`. **Aplicada/homologada.**
- `202609120003_replenishment_order_status_events_contract.sql` — contrato de ciclo de vida, eventos, operation lines, revisão por allocation e aprovação sem início operacional. **Aplicada/homologada.**
- `202609120004_filter_unknown_replenishment_operational_needs.sql` — geração pública exclui candidatos com `suggested_quantity IS NULL`. **Aplicada/homologada.**
- `202609120005_filter_unknown_replenishment_internal_materialization.sql` — helper interno usado por supersede aplica o mesmo filtro. **Aplicada/homologada.**

## 12. RPCs importantes

| RPC | Finalidade | Entrada principal | Saída | Domínio |
|---|---|---|---|---|
| `market_get_stock_balance` | Ler saldo por escopo | account, store opcional | JSON de saldos | Estoque |
| `market_start_stock_control` | Iniciar estoque inicial | store, data, itens | JSON de inicialização | Estoque |
| `market_get/save/cancel/finalize_inventory_draft` | Operar draft de inventário | sessão/loja, versão, itens | JSON/resultado | Inventário |
| `market_save_inventory_item` / `market_remove_inventory_item` | Autosave concorrente por item | sessão, produto, versão | item ou conflito | Inventário |
| `market_list_inventory_sessions` / `market_get_inventory_session` | Histórico de inventários | account/store ou sessão | resumo/detalhe | Inventário |
| `market_begin_sales_import` / `market_append_sales_import_chunk` / `market_finalize_sales_import` | Importar vendas em chunks | arquivo, período, linhas | import/resultados | Vendas |
| `market_get_commercial_dashboard` | Dashboard comercial com escopo | account, store opcional | JSON comercial | Vendas |
| `market_import_purchase_staging` / `market_import_pdf_purchase_staging` | Criar compra e itens em staging | account, destino, documento | purchase id | Compras |
| `market_search_purchase_reconciliation_candidates` | Sugerir produtos para item | account, item, limite | candidatos | Compras |
| `market_confirm_purchase_item_reconciliation` / `market_undo_purchase_item_reconciliation` | Vincular/desfazer produto | account, item/produto | status | Compras |
| `market_save_purchase_item_review` | Salvar revisão humana | item, valores, versão, confirmação | erro/void | Compras |
| `market_complete_purchase_review` | Marcar compra pronta | account, purchase | void | Compras |
| `market_receive_purchase_items` | Gerar `PURCHASE/IN` | account, purchase | contagens/status | Compras/Estoque |
| `market_run_replenishment_batch` | Calcular e persistir run/candidatos | account, data, origem | run id | Reposição |
| `market_generate_replenishment_order_draft` | Materializar lista consolidada | account | order id | Lista |
| `market_get_replenishment_order` | Ler lista, allocations e fornecedor | account, order opcional | JSON consolidado | Lista |
| `market_update_replenishment_allocation_review` | Revisar allocation por loja | account, order, allocation, Galpão, compra | allocation id | Lista |
| `market_add_replenishment_order_manual_item` | Incluir produto na revisão | order, produto, quantidade | item id | Lista |
| `market_cancel_replenishment_order_item_review` | Cancelar item logicamente | order/item, motivo | item id | Lista |
| `market_approve_replenishment_order` | Aprovar draft | account, order | order id | Lista |
| `admin_add_market_member` / `admin_update_market_member_access` | Gerenciar vínculo Market | conta, usuário, role, lojas | void | Administração |
| `admin_update_market_account_settings` | Alterar plano/status | conta, plano, status | void | Administração |

## 13. Estados e status

- **Conta:** `pilot`, `active`, `suspended`, `cancelled`.
- **Membro:** `invited`, `active`, `disabled`.
- **Loja:** `active`, `inactive`; tipo `store`, `warehouse`.
- **Compra:** `imported`, `reconciling`, `pending`, `ready`, `receiving`, `completed`, `cancelled`, `failed`.
- **Conciliação do item:** `pending`, `matched_auto`, `matched_manual`, `mapped`, `not_found`, `needs_review`.
- **Entrada do item:** `pending`, `ready`, `received`, `ignored`, `blocked`.
- **Inventário:** tipo `initial|cycle`; sessão `draft|completed|cancelled`; motivos relevantes `EXPIRED_LOSS`, `DAMAGE`, `THEFT_LOSS`, `PREVIOUS_COUNT_ERROR`, `UNREGISTERED_PURCHASE`, `UNREGISTERED_TRANSFER`, `INTERNAL_USE`, `OTHER`.
- **Run de reposição:** `running`, `completed`, `failed`; origem `scheduled|manual`; prioridade `critical|high|medium|low`.
- **Candidate triggers:** `STOCKOUT`, `BELOW_MINIMUM`, `LOW_COVERAGE`, `SALES_ACCELERATION`, `ESSENTIAL_NO_RECENT_SALES`.
- **Order:** `draft`, `approved`, `in_progress`, `completed`, `cancelled`; aprovação não inicia operação.
- **Order item:** `pending`, `partial`, `fulfilled`, `cancelled`; origem `batch`, `manual_review`, `manual_purchase`.
- **Allocation:** `pending`, `allocated`, `dispatched`, `received`, `cancelled`.
- **Integração:** `inactive`, `active`, `error`; importação de vendas `uploaded`, `processing`, `needs_mapping`, `processed`, `failed`, `cancelled` (e estados de conclusão evoluídos nas RPCs).

## 14. Decisões técnicas que não devem ser quebradas

- O isolamento multi-tenant é por `market_account_id`, inclusive em FKs compostas e joins.
- Migrations aplicadas/homologadas não devem ser reescritas; correções são novas migrations. A `202609100014` é explicitamente registrada como aplicada em homologação e imutável; `202609100016`, `202609100017`, `202609100018`, `202609110001` e `202609110002` também estão aplicadas/homologadas.
- Estoque é baseado em `market_stock_movements`; `market_stock_balance` é derivado.
- Warehouse é `market_stores.store_type = 'warehouse'`, não uma entidade paralela.
- Histórico de fornecedor válido exige compra recebida e movimento `PURCHASE` correspondente.
- `market_purchase_product_mappings` é de/para, não histórico de fornecedor.
- `suggested_quantity NULL` não significa zero nem deve ser silenciosamente substituído por zero; candidatos desconhecidos permanecem como pendência analítica no batch e não entram na lista operacional.
- Dados comerciais externos de Accesys não alimentam automaticamente o ledger operacional.
- Recebimento de compra é idempotente e por linha inteira; custo unitário desconhecido não gera entrada.
- Rascunhos/cache/localStorage podem ajudar a UX, mas não são fonte de verdade operacional nem devem substituir validação backend ao restaurar contexto.
- Escopo de loja deve ser revalidado no backend; filtros e listas fornecidos pelo frontend não são autoridade de segurança.

## 15. Pendências técnicas atuais

- A UI/serviço frontend da Lista de Compras já possui leitura consolidada dentro de Abastecimento e executa mutações de revisão pré-compra em `draft`.
- A operação pós-aprovação (separação, despacho, recebimento da lista) ainda não tem fluxo frontend completo observável.
- Permanecem definidos, mas não implementados como fluxo integrado: stale na interface, canReopen, canSupersede, Reabrir, Substituir, lista Galpão -> Loja, “marcar peguei”, inclusão manual durante compra, scanner EAN nessa operação, priorização por fornecedor e retomada/validação de contexto.

## 16. Última atualização

- **Data:** 2026-09-12
- **Migrations mais recentes da Lista de Compras:** `202609120001` a `202609120005`, além de `202609100016` a `202609110002`, aplicadas/homologadas.
- **Frontend da Lista de Compras:** `MarketReplenishment` gera/reutiliza o draft, alterna Consolidada/loja, revisa allocations com autosave, permite inclusão manual por loja, aprova a order inteira somente na Consolidada e deixa a lista aprovada somente leitura.
- **Observação:** atualizar este documento quando houver mudança estrutural relevante em schema, RLS, RPCs, fluxos de estoque/compras/reposição ou navegação Market.
