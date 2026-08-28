# PortalMicro V1.2 — roteiro manual de notificações

## Preparação

1. Aplicar `202608280002_create_notification_logs.sql` em um ambiente de teste.
2. Configurar `BREVO_API_KEY`, `BREVO_SENDER_NAME`, `BREVO_SENDER_EMAIL` e `PORTALMICRO_SITE_URL`.
3. Fazer deploy da função `send-notification` com verificação JWT habilitada.
4. Usar contas e negócios de teste; não modificar automaticamente o negócio S.O.S Sistemas T.I.

## Welcome

- Primeiro login: conferir um único e-mail e um log `sent`.
- Atualizar a página: conferir que não há segundo e-mail.
- Fazer logout e login: conferir que não há segundo e-mail.
- Chamar novamente a função: esperar `already_sent`.
- Usar temporariamente uma credencial Brevo inválida: conferir log `failed` sem segredo na mensagem.
- Restaurar a credencial e chamar novamente: conferir retry e transição para `sent`.
- Fazer duas chamadas simultâneas: uma pode processar; a outra deve retornar `processing` ou `already_sent`.

## Business published

- Publicar um negócio de teste: conferir e-mail, nome e link público pelo slug real.
- Atualizar e chamar o evento novamente: esperar `already_sent` e nenhum segundo e-mail.
- Usar um UUID inexistente: esperar rejeição.
- Usar negócio de outro proprietário: esperar `forbidden`.
- Chamar antes de o status ser `published`: esperar `business_not_published`.
- Simular falha Brevo: conferir `failed`; restaurar e testar retry.
- Fazer duas chamadas simultâneas: conferir que somente uma entrega é feita.

## Auditoria e regressão

- Confirmar que o cliente comum não consegue selecionar, inserir, atualizar ou excluir `notification_logs`.
- Confirmar que nenhum destinatário pode ser informado pelo frontend.
- Confirmar que respostas e logs não contêm a API Key.
- Confirmar que login e publicação continuam concluindo quando o envio falha.
- Confirmar que Essential, Featured, Vitrine, imagem de destaque e “Onde estamos” não mudaram.
