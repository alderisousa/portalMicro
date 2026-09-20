# GiroMicro Market — ajustes de Admin/Home

Implementação local para revisão, sem aplicação remota, exclusões reais, commit ou push.

## Causas confirmadas e arquivos

| Problema | Causa | Alteração |
| --- | --- | --- |
| Manual ausente | A seção Recursos não tinha link para o PDF existente. | `src/pages/MarketDashboard.tsx`: card no grid atual, para todos os perfis autorizados, sem depender de lojas; link em nova aba com `noopener noreferrer`. |
| Desativados na listagem | A tela renderizava todos os membros retornados por `listMarketMembers`. | `src/pages/AdminMarketAccount.tsx`: filtro local, checkbox somente quando necessário; mantém os dados, edição, RPC de reativação e proteção do proprietário. |
| Exclusão de conta de teste | Não havia fluxo administrativo com verificação de ausência de operação; existia policy de DELETE genérico com cascatas. | RPC de consulta de elegibilidade + RPC de exclusão, confirmação pelo nome atual; `src/services/market.ts` e Admin consomem essas RPCs. DELETE direto do frontend revogado. |
| Loja sem mapping | `createMarketStore`/`updateMarketStore` gravavam somente `market_stores`; a Edge Function resolvia `siteId` exclusivamente em `market_store_external_refs`. A criação/edição de integração também não materializava refs. | Triggers transacionais e filtro `is_active` em `supabase/functions/market-sales-sync/index.ts`. |

Nova e única migration: `supabase/migrations/20260920134639_market_admin_production_adjustments.sql`, criada pela CLI com timestamp atual. Nenhuma migration anterior foi editada.

PDF oficial preservado sem alteração: `public/docs/GiroMicro_Market_Manual_Operacional.pdf`. O arquivo já existia, mas não era rastreado; foi incluído no índice Git para o futuro commit, sem commit nesta entrega.

## Regra de Market vazio

Somente administrador global autenticado pode consultar a elegibilidade ou excluir. Ser owner/admin do Market não basta.

São permitidos exclusivamente conta, membros, vínculos membro/local, lojas/galpões sem Marco Zero, integrações, credenciais cifradas, referências externas de lojas (atuais e legadas) e parâmetros de reposição. Esses registros administrativos são removidos explicitamente, antes da conta, dentro da mesma transação. Usuários do portal não são removidos.

Qualquer linha em outra tabela com `market_account_id` impede a exclusão, independentemente de status ou quantidade. Isso inclui catálogo, rascunhos, cancelamentos e tentativas de sincronização. `stock_control_started_at` preenchido também impede, sem modificar seu significado.

Dependências inspecionadas nas migrations e reproduzidas no banco local:

| Grupo protegido | Tabelas |
| --- | --- |
| Catálogo e de/para | `market_products`, `market_store_products`, `market_product_mappings`, `market_product_store_data`, `market_purchase_product_mappings`, `market_purchase_unit_conversions` |
| Vendas/importação | `market_sales`, `market_sale_items`, `market_sale_payments`, `market_sales_imports`, `market_sales_import_rows` |
| Sincronização | `market_sales_sync_runs`, `market_sales_sync_errors`, `market_product_sync_runs` |
| Estoque/inventário | `market_stock_movements`, `market_inventory_sessions`, `market_inventory_session_items` |
| Compras/transferências | `market_purchases`, `market_purchase_items`, `market_transfers`, `market_transfer_items` |
| Reposição/abastecimento | `market_replenishment_runs`, `market_replenishment_candidates`, `market_replenishment_orders`, `market_replenishment_order_items`, `market_replenishment_order_allocations`, `market_replenishment_operation_lines`, `market_replenishment_order_events`, `market_replenishment_purchase_declarations`, `market_replenishment_purchase_nf_links`, `market_replenishment_supply_executions`, `market_replenishment_receipt_allocations`, `market_replenishment_order_store_releases` |

A checagem consulta o catálogo PostgreSQL, permitindo somente as tabelas administrativas acima. Novas tabelas com chave da conta são protegidas automaticamente. Uma nova dependência por FK sem chave da conta ou fora de `public` bloqueia a funcionalidade até revisão explícita. A única exceção atual sem `market_account_id` é `market_member_stores`, removida pelos vínculos de membro/local.

Na exclusão, bloqueios `SHARE ROW EXCLUSIVE NOWAIT` nas tabelas envolvidas impedem inserções concorrentes entre verificação e remoção. **Esses bloqueios de escrita abrangem todos os Markets durante essa transação curta**, não apenas a conta excluída; leituras comuns continuam disponíveis. Se alguma tabela estiver em uso por outra escrita, a exclusão aborta imediatamente. Não há chamadas remotas enquanto os bloqueios estão retidos. Qualquer falha, inclusive após remoções intermediárias, reverte toda a transação.

## Mapping Accesys

Os triggers de loja e integração usam bloqueio por conta para serializar configuração concorrente. A reconciliação faz parte do mesmo INSERT/UPDATE: falhas desfazem tanto cadastro quanto mapping.

- Loja ativa, tipo `store`, código externo não vazio: materializa referência para cada integração Accesys da mesma conta. O estado ativo/inativo da integração continua controlando se o sincronizador pode executá-la; o mapping pode ficar pronto antes da ativação.
- Integração criada ou configurada depois das lojas: materializa as referências das lojas elegíveis existentes.
- Mudança de código: desativa a referência antiga e cria/reativa a correspondente ao novo código.
- Remoção do código, inativação ou mudança para galpão: desativa a referência, preservando IDs utilizados pelo histórico de vendas e dados de produtos.
- Mesma combinação conta/integração/código: UPSERT idempotente utilizando a unique constraint existente. Código pertencente a outra loja, mesmo em referência histórica inativa, é recusado sem reassociação silenciosa.
- O sincronizador carrega somente referências ativas. Um trigger na persistência de vendas rejeita referências desativadas que já estivessem em cache, e locais inativos/galpões.
- RLS existente permanece em vigor; escrita direta de referências pelo frontend é revogada. Helpers privilegiados ficam em schema privado com execução revogada para `PUBLIC`, `anon` e `authenticated`.

Não há backfill em massa nem regravação de cadastros existentes na migration. Uma loja/integração legada que precise de reconciliação pode ser salva pelo Admin após a implantação; não é necessário INSERT manual em refs. Não se alteram estoque, produtos, Marco Zero, prioridade, compras ou cálculos de reposição.

O isolamento de funções privilegiadas e a configuração de `search_path` seguem a [documentação oficial de funções Supabase](https://supabase.com/docs/guides/database/functions).

## Validação

Comando focado:

```powershell
node --test tests/market-production-adjustments-db.test.mjs tests/market-production-adjustments-ui.test.mjs tests/market-admin-small-adjustments.test.mjs
```

Resultado: **37 testes aprovados** (20 novos de banco, 8 novos de interface e 9 regressões administrativas existentes).

Os testes de banco aplicam a cadeia real de migrations Market em PGlite descartável, usando a dependência local já utilizada pelos demais testes (`.scratch/purchase-db-test/node_modules/@electric-sql/pglite`). Apenas auth/plataforma Supabase são simulados, e a instalação de pgcrypto é omitida porque `gen_random_uuid` já existe nesse PostgreSQL. Nenhum banco remoto é consultado ou modificado.

Cobertura inclui recusa por operação, permissões, reativação e proteção do proprietário, rollback após falha tardia de exclusão, rollback do cadastro quando há conflito de mapping, preservação de referências históricas, filtro/edição na interface, confirmação da exclusão e manual para os cinco perfis sem lojas.

Typecheck: `node node_modules/typescript/bin/tsc -b --pretty false`. Verificação de whitespace: `git diff --check`.

Limites: testes de interface usam o harness de hooks e elementos do projeto, sem navegador visual; responsividade reutiliza o CSS existente de duas colunas/uma coluna no celular. PGlite não valida concorrência entre conexões reais. Não foi executado advisor remoto porque a migration não foi aplicada em ambiente remoto.

## Aplicação em homologação após revisão

1. Aplicar **somente** `20260920134639_market_admin_production_adjustments.sql`, após as migrations existentes, pelo fluxo habitual de migrations/SQL do projeto. O arquivo contém `begin`/`commit`; não executar blocos isolados.
2. Publicar a Edge Function `market-sales-sync` atualizada **depois da migration**, pois ela passa a consultar `is_active`. Coordenar a publicação antes de editar cadastros para que o sincronizador já filtre referências desativadas.
3. Publicar o frontend e incluir o PDF oficial de `public/docs` no mesmo pacote. Não publicar o frontend sem as RPCs novas se for necessário disponibilizar a exclusão imediatamente.
4. Validar o card/PDF e, se necessário, salvar pelo Admin a loja ou integração de homologação com mapping pendente. A migration não modifica em massa os Markets existentes.

Nenhum desses passos de implantação foi executado nesta entrega. Exclusões reais não fazem parte da validação.
