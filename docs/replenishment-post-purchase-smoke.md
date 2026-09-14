# Reposição pós-compra — migration 005

Aplicar manualmente `202609140005_replenishment_post_purchase.sql` antes de publicar o frontend correspondente. As migrations 003 e 004 são pré-requisitos imutáveis. Este pacote não aplica SQL remoto.

## Contrato

- Aquisição comercial confirma purchase; recebimento em Compras é a única origem de PURCHASE/IN.
- Reconciliação roda nas RPCs de aprovação, declaração e recebimento, nunca nas consultas. Usa o instante de ORDER_APPROVED da revisão vigente e movimentos oficiais posteriores, com produto, conta, Galpão e item de compra correspondentes.
- FIFO por aprovação, ordem e allocation. Só atribui a necessidade inteira; soma múltiplos recebimentos, desconta links globalmente e conserva excedentes. Locks da conta e dos itens serializam atribuições.
- Supply usa a allocation, com operation line warehouse opcional. Mantém as metas comerciais e aceita ordem completed. Exige saldo e quantidade integral, respeita FIFO e grava somente o par de transferências.
- Correção preserva a quantidade comprometida por recebimento atribuído, links legados ou entrega. Redução permitida emite PURCHASE_CORRECTED; se necessário reabre explicitamente o estado comercial. Replay não repete a correção. Outra ordem ativa impede essa reabertura.

## Smoke Café 1 + Guaraná 3

1. Após aplicação manual da 005 e publicação da UI, localizar a ordem existente. Se as aquisições antigas ainda não avançaram na 004, salvar novamente os totais pela tela, com a versão atual.
2. Conferir Comprar sem essas quantidades e Aguardando entrada com Café 1 e Guaraná 3. O saldo não muda por essa ação. Bubbaloo já entregue aparece no histórico.
3. Importar/lançar a NF pelo fluxo normal de Compras, para o Galpão, reconciliar os produtos, revisar unidades, conversões e custos e receber os itens.
4. A RPC de recebimento atribui automaticamente evidência elegível. Voltar à Reposição: não selecionar NF. Atualizar apenas consulta os fatos; não executa reconciliação.
5. Conferir Aguardando entrada zerado para esses itens e Abastecer com as necessidades inteiras. Saldo antigo também pode permitir abastecimento, mas não comprova o recebimento desta aquisição.
6. Confirmar a entrega de cada produto à loja. Conferir TRANSFER_OUT/TRANSFER_IN nas quantidades exatas, histórico e ausência de nova PURCHASE/IN.
7. A ordem comercial pode estar completed antes das entregas. Continua consultável e abastecível. Um novo ciclo fica retido enquanto existir necessidade física pendente da conta.

## Validação local e limites

19 testes focados em PGlite e funções de apresentação passaram: parcial, NF antes/depois da declaração, múltiplas NFs, excedentes, FIFO 2/1/2 e 6/6, marco temporal, replay, correção, duas ordens, LOW, purchase-only, warehouse e conclusão pelas duas frentes. Build TypeScript/Vite passou, com aviso de tamanho de chunks.

Não houve teste visual em navegador nem teste concorrente com múltiplas conexões PostgreSQL reais. Os testes de UI cobrem derivação das filas e contrato do componente.

A proteção entre batches é conservadora por conta: pode adiar necessidades novas independentes. Não deduplica ordens antigas já coexistentes. Abastecimento integral exige saldo suficiente em um único Galpão; não combina saldos de Galpões diferentes. Saldo antigo não quita automaticamente a meta comercial de compra aprovada.

A 005 não faz backfill automático dos fatos anteriores à implantação. Recebimentos e declarações já existentes são reconciliados no próximo gatilho oficial do produto (por exemplo, salvar a declaração atual); abrir/atualizar a tela não tem esse efeito. Uma declaração antiga bloqueada para correção exige avaliação específica, sem escrita direta como parte deste smoke.
