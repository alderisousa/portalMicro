# Frontend do ciclo de reposição

Integra a migration 202609160003 já aplicada. Nenhuma migration/RPC foi alterada.

- `MarketReplenishment`: ação secundária no aviso de análise anterior apenas para approved/in_progress. Após sucesso, lê a nova ordem pelo ID retornado, recarrega a análise e limpa filtros/confirmações da lista anterior.
- `ReplenishmentCycleAction`: previews de fechamento e lote, modal compartilhado, motivo opcional, alertas, loading, bloqueio síncrono de duplo envio e request-id preservado no retry. Falha na recarga após commit repete somente as leituras.
- `ReplenishmentPurchasing`: lote por ordem com itens disponíveis, mantendo a confirmação individual. A fila existente reúne ordens distintas; cada botão identifica sua lista. O preview inclui todas as lojas dessa ordem, inclusive fora do filtro visual, e explicita isso no modal. `items` é enviado sem transformação.
- `ReplenishmentHistory`: closed/closed_with_pending e parcelas congeladas por necessidade, somente leitura. Quantidade desconhecida aparece como “A definir”.
- `ConfirmDialog`: conteúdo adicional, labels e bloqueios opcionais, foco contido para os modais desta Sprint. CSS restrito aos novos modais, com rolagem vertical e ações empilhadas no celular.
- Services/types incluem as cinco RPCs, resumo/necessidades de fechamento, lote por loja e Histórico closed. Os erros de data comercial, análise, ausência de candidatos, ordem inválida/conflitante e lote desatualizado têm mensagens específicas.

## Verificações

Os testes `replenishment-cycle-ui.test.mjs` exercitam os handlers reais compilados, com hooks e RPCs simulados: confirmação, erros, retry, double-submit, identidade do payload, recarga pós-commit e contratos visuais. Não equivalem a um teste de navegador.

A antiga falha de `replenishment-purchasing-db.test.mjs` foi corrigida no teste: exigia condições/textos do fluxo anterior. Agora verifica filas do backend, correção autorizada e ausência de vínculo manual de NF. As asserções de Histórico e fornecedor em `replenishment-post-purchase-ui.test.mjs` foram alinhadas às fontes atuais e à preservação do seletor existente.

Permanece fora do escopo a asserção de `replenishment-purchase-display.test.mjs` que exige `missing.length` e `missing.map` no componente. Esses elementos já não existem no HEAD anterior a esta Sprint. O teste e o fallback não foram alterados.

Risco residual: validar visualmente em navegador/celular e fazer smoke autenticado na homologação. Nenhuma chamada de mutação remota foi feita durante esta implementação. O build pode emitir o aviso existente de chunks acima de 500 kB.
