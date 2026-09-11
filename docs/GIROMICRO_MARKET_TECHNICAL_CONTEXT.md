# GiroMicro Market — Contexto técnico atual

> Documento vivo do estado observado no repositório em 2026-09-11. Descreve o código, as migrations aplicadas/homologadas e a integração frontend existente; não é um contrato de funcionalidades futuras.

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
- `market_replenishment_order_items`: um produto consolidado por lista; FK lista/produto; totais sugeridos, saldo do galpão, compra sugerida, ajuste, comprado, excedente, origem e cancelamento de revisão. `total_suggested_quantity` e `suggested_purchase_quantity` podem ser `NULL` quando a necessidade consolidada ainda é desconhecida.
- `market_replenishment_order_allocations`: rateio item-loja; FK item/loja/candidato; sugestões, divisão galpão-compra, ajustes e quantidades alocadas, despachadas e recebidas. Quantidades operacionais conhecidas são inteiras por arredondamento para cima; `NULL` permanece `NULL`.

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
- `suggested_quantity = NULL` permanece desconhecida quando o cálculo não consegue determinar uma quantidade; não deve ser convertida em zero. Na Lista de Compras, se qualquer allocation de um produto tiver `suggested_quantity NULL`, o `total_suggested_quantity` consolidado permanece `NULL` e `suggested_purchase_quantity` também permanece `NULL`.
- `warehouse_stock` é snapshot agregado do saldo dos warehouses e pode ser `NULL` quando não há galpão aplicável.

### Último run efetivo

A tela `MarketReplenishment` não dispara o batch. `marketReplenishment.ts` lê `market_replenishment_runs` com `status = 'completed'` e `is_effective = true`, ordenando por `reference_date` e `started_at` desc; depois lê candidatos desse run e resolve nomes em `market_products`. Esse é o critério do último run efetivo.

## 7. Lista de Compras

### Estado aplicado/homologado

As três tabelas existem: `market_replenishment_orders`, `market_replenishment_order_items` e `market_replenishment_order_allocations`. A geração de draft é feita por `market_generate_replenishment_order_draft(account_id)`, que exige vínculo com `owner/admin` ou `manager` com `all_stores`, usa o último run efetivo e é idempotente por run não cancelado.

A consolidação é por `product_id`: quando todas as necessidades são conhecidas, soma `candidate.suggested_quantity` de todas as lojas, captura `warehouse_stock_snapshot` e calcula `suggested_purchase_quantity = max(total_suggested - warehouse_stock, 0)`. Quando qualquer loja participante tem `suggested_quantity NULL`, `total_suggested_quantity` e `suggested_purchase_quantity` permanecem `NULL`; necessidade desconhecida/não calculável nunca vira zero. As allocations mantêm uma linha por loja/candidato e separam `warehouse_allocated_quantity` de `purchase_needed_quantity`, priorizando candidatos críticos/altos/médios/baixos e ranking.

A migration aplicada/homologada `202609110002_round_replenishment_operational_quantities.sql` mantém o cálculo analítico do batch decimal, mas arredonda para cima (`CEIL`) as quantidades materializadas/operacionais da lista em itens e allocations. Ex.: necessidade analítica `2,4833` vira necessidade operacional `3`; `NULL` permanece `NULL`.

`market_get_replenishment_order(account_id, order_id?)` retorna JSON da lista, itens, prioridade, allocations e o último fornecedor válido. Inclui `suggested_purchase_quantity`, `adjusted_purchase_quantity`, `effectivePurchaseQuantity`, `warehouse_surplus_quantity` e custo do último recebimento.

### Revisão pré-compra implementada no backend

A migration aplicada/homologada `202609100018_replenishment_order_review_backend.sql` adiciona e usa:

- `market_replenishment_order_items.source`: `batch`, `manual_review`, `manual_purchase`; no estágio atual da revisão, batch e inclusão manual em revisão são gerados.
- `review_cancelled_at`, `review_cancelled_by` e `review_cancellation_reason`: cancelamento lógico do item durante a revisão.
- `adjusted_purchase_quantity`: quantidade revisada; `NULL` preserva a sugestão original.
- RPCs `market_update_replenishment_order_item_quantity`, `market_add_replenishment_order_manual_item`, `market_cancel_replenishment_order_item_review` e `market_approve_replenishment_order`.
- Aprovação muda o cabeçalho de `draft` para `approved`, preenchendo `approved_at` e `approved_by`.

Isso é **IMPLEMENTADO no banco e homologado no Supabase**. O frontend de Abastecimento já executa as mutações de revisão enquanto a lista está `draft`: ajustar quantidade consolidada, incluir produto ativo do catálogo como `manual_review`, retirar item por cancelamento lógico e aprovar a lista.

### Frontend de leitura e revisão pré-compra

`src/services/marketReplenishment.ts` consome `market_generate_replenishment_order_draft`, `market_get_replenishment_order` e as RPCs de revisão `market_update_replenishment_order_item_quantity`, `market_add_replenishment_order_manual_item`, `market_cancel_replenishment_order_item_review` e `market_approve_replenishment_order`. `src/pages/MarketReplenishment.tsx` preserva a visão atual do último batch por loja e adiciona a ação "Abrir lista", que gera/reutiliza o draft e renderiza os itens consolidados em cards responsivos. O topo do card mostra `Necessidade total`, `Compra efetiva`, `Quantidade revisada` e `Galpão`; as allocations por loja mostram `Necessidade`, `Do Galpão` e `Comprar`. A quantidade revisada usa autosave no `blur`/Enter. `NULL` não é exibido como zero. Quando o status é `draft`, habilita ajuste de quantidade, inclusão manual por busca no catálogo, retirada lógica e aprovação; depois de `approved`, a lista fica somente leitura. Itens `status='cancelled'` não entram na lista normal exibida.

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

### Estados da lista e da execução

Cabeçalho: `draft`, `approved`, `purchasing`, `separating`, `dispatched`, `completed`, `cancelled`. Item consolidado: `pending`, `partial`, `fulfilled`, `cancelled`. Allocation: `pending`, `allocated`, `dispatched`, `received`, `cancelled`. Constraints existem, mas as transições operacionais além da revisão não estão implementadas por uma máquina de estados/triggers.

## 8. Fluxo funcional da Lista de Compras

### FASE 1 — revisão pré-compra

**IMPLEMENTADO:** geração de draft no backend; consolidação por produto; rateio por loja; consideração do saldo do warehouse; preservação de necessidade desconhecida como `NULL`; arredondamento operacional para cima das quantidades conhecidas; leitura de último fornecedor; ajuste de quantidade; inclusão manual de produto na revisão; lixeira/cancelamento lógico com motivo; aprovação via RPC; estados e constraints correspondentes. No frontend, a tela de Abastecimento já abre a Lista de Compras consolidada, gera/reutiliza o draft, apresenta os itens consolidados em cards e executa as ações de revisão pré-compra enquanto a lista está `draft`.

**DEFINIDO / PENDENTE:** visão individual por loja baseada na order; edição de allocations; retomada de contexto da revisão; validação da operação no backend ao restaurar. A lista não deve depender de cache/localStorage como fonte operacional.

### FASE 2 — purchasing/operação no Market

**IMPLEMENTADO:** o backend já modela status `purchasing`, `separating`, `dispatched`, `completed`, quantities compradas/alocadas/despachadas/recebidas e saldo excedente do galpão.

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
| `market_update_replenishment_order_item_quantity` | Ajustar compra na revisão | order/item, quantidade | item id | Lista |
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
- **Order:** `draft`, `approved`, `purchasing`, `separating`, `dispatched`, `completed`, `cancelled`.
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
- `suggested_quantity NULL` não significa zero nem deve ser silenciosamente substituído por zero; na lista consolidada, `NULL` indica necessidade desconhecida/não calculável.
- Dados comerciais externos de Accesys não alimentam automaticamente o ledger operacional.
- Recebimento de compra é idempotente e por linha inteira; custo unitário desconhecido não gera entrada.
- Rascunhos/cache/localStorage podem ajudar a UX, mas não são fonte de verdade operacional nem devem substituir validação backend ao restaurar contexto.
- Escopo de loja deve ser revalidado no backend; filtros e listas fornecidos pelo frontend não são autoridade de segurança.

## 15. Pendências técnicas atuais

- A UI/serviço frontend da Lista de Compras já possui leitura consolidada dentro de Abastecimento e executa mutações de revisão pré-compra em `draft`.
- A operação pós-aprovação (`purchasing`, separação, despacho, recebimento da lista) ainda não tem fluxo frontend/backend completo observável.
- Permanecem definidos, mas não implementados como fluxo integrado: visão individual por loja baseada na order, filtros de prioridade, contador de restantes, “marcar peguei”, remoção temporária, inclusão manual durante compra, scanner EAN nessa operação, priorização por fornecedor e retomada/validação de contexto.

## 16. Última atualização

- **Data:** 2026-09-11
- **Commit HEAD de referência:** `df0b1a1e1f9edcdce9eae4ec4b80517f06844f3e` (`feat: adiciona abastecimento e reposicao inteligente`)
- **Migrations mais recentes da Lista de Compras:** `202609100016_generate_replenishment_order_draft.sql`, `202609100017_read_replenishment_order_with_last_supplier.sql`, `202609100018_replenishment_order_review_backend.sql`, `202609110001_fix_replenishment_unknown_quantity_consolidation.sql` e `202609110002_round_replenishment_operational_quantities.sql`, aplicadas/homologadas.
- **Frontend da Lista de Compras:** `MarketReplenishment` gera/reutiliza o draft, lê a lista consolidada e executa ajuste de quantidade com autosave, inclusão manual, retirada lógica e aprovação em `draft`, sem scanner funcional, compra operacional ou retomada local.
- **Observação:** atualizar este documento quando houver mudança estrutural relevante em schema, RLS, RPCs, fluxos de estoque/compras/reposição ou navegação Market.
