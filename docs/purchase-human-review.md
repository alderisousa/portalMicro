Conferência da compra — implementação local

Auditoria

- O staging é `market_purchases` + `market_purchase_items`. `market_import_purchase_staging` é uma RPC; não há uma tabela `market_purchase_staging`.
- Compra: tenant, galpão, fornecedor/documento, número/série/chave/data, totais, origem, status e `raw_payload`. No importador anterior, `raw_payload` armazenava somente o nome do provider.
- Itens: `supplier_product_code`, `barcode_raw`, `barcode_normalized`, `description_raw`, quantidade/unidade, preço, bruto/desconto/frete/outras despesas/líquido e custo calculado. Produto e método/status/confiança da conciliação já eram separados de `stock_entry_status`.
- Faltavam original imutável dos valores editáveis e marcação humana por item/compra. Preços tinham quatro casas; quantidade, três.
- `market_purchase_product_mappings`: identidade única composta por tenant + documento do fornecedor + código + barcode normalizado + descrição normalizada; produto com FK composta por tenant. A RPC manual grava fornecedor/código (não somente descrição); a troca atualiza o mapping apenas quando solicitado. Desfazer vínculo não exclui o mapping.
- Match: de/para tem prioridade; depois GTIN válido, exato e único no catálogo ativo/vigente Accesys do próprio tenant. SKU e descrição participam de sugestões. Seleção manual valida produto/tenant/vigência. `ean_exact`, `purchase_mapping` e `manual` já distinguem origem.
- O catálogo sincroniza GTIN válido para `market_products.ean`. Não é necessária tabela global: cada Market pode reconhecer o mesmo EAN em seu próprio catálogo, sem compartilhar de/para ou dados privados.
- O PDF usava `PurchaseOcrReview` e apenas exibia `buildReconciliationPayload`: nenhum input era persistido. O caminho de foto/OCR permanece assim, fora desta etapa.
- Segurança existente: roles owner/admin/manager para escrita, viewer para leitura de custos, validação de galpão/loja e RLS por tenant. RPCs de conciliação também validam catálogo vigente. Não foram encontrados testes versionados específicos de de/para; existiam testes do importador e catálogo.

Implementação

`202609070001_purchase_human_review.sql` deve ser aplicada MANUALMENTE. Nenhuma SQL foi enviada ao Supabase e nenhum deploy foi feito.

- Reaproveita staging/de/para existentes; adiciona `original_data` imutável por item e `reviewed_at`/`reviewed_by` por item e compra.
- Backfill registra a primeira versão disponível dos itens antigos; não reconstrói alterações históricas inexistentes. Todos começam sem conferência humana.
- Quantidade passa a numeric(18,4); preço a numeric(18,5). O custo gerado é recriado com a mesma fórmula. Precisões excedentes são rejeitadas, não silenciosamente arredondadas.
- `market_import_pdf_purchase_staging` grava original e interpretação atomicamente, permite pedido sem chave e usa hash do arquivo/página como referência idempotente por tenant. A interface bloqueia persistência de PDFs multipágina, evitando salvar uma compra incompleta enquanto não houver consolidação.
- `market_save_purchase_item_review` preserva original, valida versão `updated_at`, permite salvar correções sem aprovar e exige match/cálculo coerente para a aprovação explícita.
- Corrigir código/EAN remove o vínculo anterior e pede nova conciliação. Trocar produto/dados invalida conferência do item e conclusão da compra. A edição inicia estado `reconciling`, impedindo reimportação destrutiva depois de correções.
- `market_complete_purchase_review` exige todos os itens conferidos, vinculados a produtos vigentes, ainda com estoque pendente, e soma de produtos consistente. Marca a compra `ready`, sem recebimento.
- As RPCs existentes de confirmar/desfazer/reprocessar são redefinidas somente na migration nova para usar trava compra → item e validar disponibilidade. Reprocessamento filtra estoque pendente e usa agregação UUID compatível (`min(id::text)::uuid`).
- Escrita direta REST em compras/itens/mappings é revogada; as RPCs autorizadas continuam disponíveis. SELECT e RLS são preservados. Revisar eventuais clientes externos que escrevam diretamente nessas tabelas antes da aplicação.
- Sem alterações nas tabelas de estoque, OCR/foto, importador NFC-e/SEFAZ ou migrations antigas.

UX

PDF com texto usa revisão própria, com código e EAN separados e original visível. Salvar carrega efetivamente o staging. Nos itens importados, “Revisar dados” e “Trocar produto” continuam disponíveis após match automático, enquanto a compra permite edição. Conferência exige ações explícitas por item e depois por compra. Consistência matemática não é apresentada como aprovação humana.

Testes locais reproduzíveis (Node 24)

```powershell
npm.cmd install --prefix .scratch/purchase-db-test --cache .scratch/npm-cache --no-save --ignore-scripts @electric-sql/pglite@0.5.8
node --experimental-transform-types --test tests/pdf-parser.test.mjs tests/purchase-review.test.mjs tests/purchase-review-db.test.mjs supabase/functions/market-integration-admin/market_product_sync_test.ts
npm.cmd run build
git diff --check
```

O teste de banco usa PostgreSQL embarcado PGlite, tabelas reais de staging extraídas da migration core e migrations 001–005 pertinentes. Auth, contas, lojas e catálogo possuem fixtures mínimas; não substitui teste integrado de sessão/RLS no Supabase. Inclui execução como `authenticated`, negação de escrita REST, isolamento, de/para, vigência Accesys, originais, precisão, conflitos, invalidação de aprovação e ausência de alterações em tabelas sentinela de estoque. Os PDFs reais também são importados no banco local.

Antes de uso remoto: revisar/aplicar manualmente a migration e validar com perfis reais, dois Markets e escopos de loja. O frontend novo depende dessa migration. Não houve teste visual em navegador nem teste concorrente com duas conexões reais. Nenhum recebimento foi implementado; uma etapa futura precisará revalidar a aprovação e os dados no momento de receber.
