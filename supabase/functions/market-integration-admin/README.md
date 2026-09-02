# market-integration-admin

Edge Function server-side da Sprint 4B.1. Aceita apenas `POST` autenticado com
uma das ações abaixo no corpo JSON:

- `get`: `marketAccountId`, `integrationId`;
- `save`: `marketAccountId`, `integrationId` opcional, `provider`, `baseUrl`,
  `externalCompanyId`, `username` e `password` opcional;
- `test`: `marketAccountId`, `integrationId`.

Nesta primeira fase, todas as ações exigem Admin global GiroMicro, validado pela
função existente `public.is_admin()`/`public.user_roles`. Não há hardcode de
e-mail. A conta alvo precisa existir e estar ativa/piloto, e toda integração é
carregada junto com `marketAccountId` para preservar o isolamento. Respostas
nunca incluem senha, ciphertext, chave ou token.

A arquitetura mantém a autorização isolada no repositório. Uma delegação futura
ao `owner` do Market poderá substituir essa regra sem alterar o modelo ou a
proteção de `market_integration_credentials`.
Em `save`, `status` é opcional e aceita somente `active` ou `inactive`.

## Secret obrigatório

`GIROMICRO_INTEGRATION_ENCRYPTION_KEY` deve ser Base64 de exatamente 32 bytes
aleatórios. Gere localmente, sem salvar no repositório:

```sh
openssl rand -base64 32
```

Configure o valor manualmente nos secrets da Edge Function no projeto Supabase.
Não prefixe com `VITE_`, não coloque no React e não versione em `.env`.

As senhas são protegidas com AES-256-GCM, IV aleatório de 12 bytes e tag de
autenticação de 128 bits. O `bytea` contém um envelope JSON UTF-8 com versão,
algoritmo, IV e ciphertext+tag. A chave global não é persistida no banco.

## Accesys

A allowlist aceita somente a origem HTTPS oficial
`https://apigateway.accesyslab.com.br`. O teste autentica em
`POST /oar/users/login` e valida o token com uma leitura mínima em
`GET /oar/sites/products/search`, usando `pageSize=1`, `page=1` e o `companyId` configurado. O token é
mantido apenas em memória durante a requisição.
