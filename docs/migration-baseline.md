# PortalMicro — baseline anterior à migração

Este documento registra o estado do projeto antes da migração definitiva para Supabase. Ele descreve o comportamento e a arquitetura encontrados, sem propor mudanças de implementação.

## Estrutura atual do projeto

```text
portalMicro/
├── data/
│   └── clients/                 Dados e mídias persistidos pela API local
├── dist/                        Build já gerado do frontend
├── docs/                        Documentação da migração
├── node_modules/                Dependências instaladas
├── server/
│   └── server.mjs              API Express e persistência em arquivos
├── src/
│   ├── lib/
│   │   └── supabase.ts         Cliente Supabase
│   ├── App.tsx                 Telas e maior parte da lógica da aplicação
│   ├── firebase.ts             Configuração Firebase do frontend
│   ├── index.css               Estilos globais e responsivos
│   ├── main.tsx                Ponto de entrada React
│   └── vite-env.d.ts           Tipos de ambiente do Vite
├── .env.example                Exemplo parcial das variáveis de ambiente
├── .env.local                  Configuração local não versionada
├── index.html                  Documento HTML principal
├── package.json                Scripts e dependências
├── tsconfig*.json              Configurações TypeScript
└── vite.config.ts              Configuração do Vite
```

O frontend está fortemente concentrado em `src/App.tsx`. As principais funções/componentes declarados nele são `App`, `StoryContent`, `WizardQuestion` e o auxiliar `renderInline`. As telas home, login, dashboard, wizard e preview são controladas por estado local, sem um roteador dedicado.

## Tecnologias atuais

- React e React DOM.
- TypeScript.
- Vite com `@vitejs/plugin-react`.
- Supabase JS.
- Firebase no frontend e Firebase Admin no servidor.
- Express como API local.
- Multer para uploads locais.
- CORS.
- Cloudinary para upload de imagens pelo navegador.
- ViaCEP para consulta de endereço por CEP.
- Lucide React para ícones.
- CSS puro em `src/index.css`.
- `localStorage` e arquivos JSON como mecanismos atuais de persistência.

O Vite possui configuração mínima, somente com o plugin React. A URL da API é definida no frontend por variável de ambiente, com fallback para `http://localhost:4000`.

## Fluxo atual de autenticação

O fluxo ativo do frontend usa Supabase Auth com Google:

1. Na inicialização, `App.tsx` chama `supabase.auth.getSession()`.
2. A aplicação acompanha login, logout e restauração de sessão com `supabase.auth.onAuthStateChange()`.
3. O login chama `supabase.auth.signInWithOAuth()` com o provider `google`.
4. O redirecionamento OAuth usa `window.location.origin`.
5. Nome, e-mail e identificador são obtidos da sessão e dos metadados do usuário.
6. O logout chama `supabase.auth.signOut()` e limpa o estado local de sessão demonstrativa.

Há também um modo demonstração. Ele grava `portalmicro-session=demo-user` no `localStorage` e altera o estado visual para autenticado, mas não cria uma sessão real nem uma identidade validada no backend.

O servidor possui rotas protegidas por Firebase Admin. Elas esperam um Firebase ID token no header `Authorization: Bearer ...`. O frontend atual autentica pelo Supabase e não foi encontrado envio desse token Firebase para as rotas protegidas. Portanto, os dois lados não compartilham atualmente o mesmo sistema de identidade.

## Persistência atual dos dados

Os dados do negócio não têm hoje uma única fonte definitiva:

- O estado em uso no frontend reside no React.
- O cadastro em edição é salvo automaticamente no `localStorage`.
- A página pública consulta a API Express quando a URL contém `?site=slug`.
- A API Express lê e grava arquivos em `data/clients`.
- O servidor também prevê dados por conta em `data/accounts` quando as rotas Firebase protegidas são utilizadas.
- Imagens enviadas normalmente ficam no Cloudinary.
- Em caso de falha no Cloudinary, o frontend usa uma URL temporária criada com `URL.createObjectURL()`.

A ação atual de publicação altera o estado local, gera uma URL com `?site=slug` e abre o preview. Não foi encontrada persistência desse ato no Supabase nem chamada de gravação ao servidor dentro da função de publicação.

## Uso atual do Supabase

`src/lib/supabase.ts` cria um cliente usando:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Se alguma delas não existir, o módulo lança um erro durante a inicialização.

O uso efetivamente encontrado está limitado ao Supabase Auth:

- recuperação de sessão;
- observação de mudanças da sessão;
- Google OAuth;
- logout.

Não foi encontrado uso de Supabase PostgreSQL, tabelas, queries, migrations, Row Level Security ou Supabase Storage no código atual.

## Uso atual do Firebase

No frontend, `src/firebase.ts` contém configuração para:

- Firebase App;
- Firebase Auth;
- Google Auth Provider;
- Firebase Analytics, quando suportado.

Não foi encontrada importação desse módulo pelo restante do frontend atual.

No servidor, `server/server.mjs` usa Firebase Admin quando `FIREBASE_SERVICE_ACCOUNT_JSON` está configurada. O middleware `requireAuth` valida Firebase ID tokens e protege as rotas de cadastro vinculadas à conta.

Sem a credencial Firebase Admin, essas rotas respondem com HTTP 503.

## Uso atual do Cloudinary

Logo e fotos são enviadas diretamente pelo navegador ao endpoint de upload de imagens do Cloudinary. O frontend usa um cloud name e um unsigned upload preset configuráveis por ambiente, ambos com valores fallback no código.

Quando o upload funciona, a `secure_url` retornada é armazenada no objeto do negócio. Quando falha, a aplicação cria uma URL temporária com `URL.createObjectURL()`. Essa URL temporária não sobrevive ao fechamento ou recarregamento da página.

## Uso atual de localStorage

As chaves identificadas são:

- `portalmicro-business`: armazena em JSON o objeto completo do negócio em edição.
- `portalmicro-session`: guarda o valor `demo-user` para o modo demonstração.

O objeto do negócio é salvo automaticamente sempre que o estado `business` muda. A leitura inicial usa `JSON.parse()` diretamente, sem tratamento para conteúdo inválido.

Os dados não são separados por usuário. Contas diferentes usadas no mesmo navegador podem compartilhar o mesmo rascunho local.

## Uso atual de data/clients

`data/clients` é a raiz de armazenamento local da API Express. Cada cliente ocupa, em princípio, uma pasta cujo nome é o slug:

```text
data/clients/{slug}/data.json
data/clients/{slug}/{arquivos enviados}
```

O levantamento inicial encontrou 93 arquivos `data.json` e 4 arquivos de mídia. Há muitos diretórios com slugs progressivos, como versões sucessivas e parciais de um mesmo nome. Isso sugere gravações históricas que criaram novos diretórios enquanto o nome ou slug estava sendo digitado.

O diretório inteiro está ignorado pelo Git. Ele deve receber backup e auditoria antes de qualquer limpeza ou importação.

## Endpoints existentes em server/server.mjs

### Endpoints públicos

- `GET /api/health` — retorna o estado básico da API.
- `GET /api/clients` — lista os negócios cujo `data.json` tem `published` verdadeiro.
- `GET /api/clients/:slug` — retorna o cadastro de um cliente pelo slug.
- `POST /api/clients/:slug` — grava ou sobrescreve `data.json` sem autenticação.
- `POST /api/clients/:slug/upload` — recebe até 10 fotos e grava no diretório do cliente, sem autenticação.
- `POST /api/clients/:slug/logo` — recebe uma logo e grava no diretório do cliente, sem autenticação.
- `GET /files/*` — expõe estaticamente arquivos armazenados em `data/clients`.

### Endpoints protegidos por Firebase Admin

- `GET /api/account/business` — carrega o cadastro associado ao UID Firebase.
- `POST /api/account/business` — grava o cadastro associado ao UID Firebase e também atualiza o diretório público por slug.

O servidor limita JSON a 2 MB. O Multer limita cada arquivo a 5 MB e o conjunto de fotos a 10 arquivos, mas não foi encontrada validação do conteúdo ou MIME real do arquivo no backend.

## Variáveis de ambiente utilizadas

### Frontend/Vite

- `VITE_API_URL` — URL da API Express; fallback `http://localhost:4000`.
- `VITE_CLOUDINARY_CLOUD_NAME` — cloud name do Cloudinary; possui fallback no código.
- `VITE_CLOUDINARY_UPLOAD_PRESET` — unsigned upload preset; possui fallback no código.
- `VITE_SUPABASE_URL` — URL do projeto Supabase; obrigatória.
- `VITE_SUPABASE_PUBLISHABLE_KEY` — chave pública do Supabase; obrigatória.
- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_FIREBASE_MEASUREMENT_ID`

### Servidor Node

- `DATA_ROOT` — raiz alternativa para `data/`; por padrão usa a pasta local do projeto.
- `FIREBASE_SERVICE_ACCOUNT_JSON` — service account usada pelo Firebase Admin.
- `PORT` — porta HTTP; padrão 4000.

No estado examinado, `.env.local` contém as chaves Supabase. O `.env.example` contém API, Cloudinary e Firebase, mas não documenta as duas variáveis obrigatórias do Supabase nem as variáveis do servidor.

## Principais riscos encontrados

- Supabase Auth no frontend e Firebase Admin no backend são sistemas de identidade incompatíveis no fluxo atual.
- A publicação atual não grava o negócio no servidor nem no Supabase; uma URL pode funcionar no estado atual e falhar após recarregar.
- Rotas de escrita e upload em `/api/clients/:slug` não exigem autenticação.
- CORS está habilitado sem restrição de origem.
- Rascunhos no `localStorage` não são isolados por usuário.
- O modo demonstração representa autenticação apenas no estado local.
- `JSON.parse()` de dados locais inválidos pode impedir a inicialização do frontend.
- URLs de fallback criadas por `URL.createObjectURL()` não são persistentes e não são revogadas explicitamente.
- Erros ao carregar a lista de clientes ou uma página pública são ignorados sem mensagem ao usuário.
- A variável `requestedSite` é calculada somente no carregamento; `pushState`, voltar e avançar podem deixar URL e tela dessincronizadas.
- Não há validação backend robusta do tipo dos arquivos enviados.
- Os 93 registros locais aparentam incluir duplicatas ou versões parciais e não devem ser migrados automaticamente sem auditoria.
- O arquivo `.env.example` não representa toda a configuração obrigatória atual.
- A lógica de telas, dados, upload, autenticação e publicação está concentrada em `App.tsx`, elevando o risco de regressões.
- Não foi encontrada suíte de testes nem configuração de lint.
- Dependências importantes usam `latest` no `package.json`, reduzindo a reprodutibilidade de novas instalações.
- Textos acentuados apareceram corrompidos durante leitura pelo terminal. Isso pode ser somente interpretação de encoding pelo PowerShell, mas deve ser conferido no editor e no navegador.

