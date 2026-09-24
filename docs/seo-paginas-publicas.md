# SEO inicial das páginas públicas

`/negocio/:slug` é reescrita para `api/negocio/[slug].js`. A função lê
`dist/index.html`, incluído no pacote pela configuração `includeFiles` da
Vercel, e substitui apenas title, description, robots, canonical e tags sociais.
O script `vercel-build` chama `npm run build` também no builder Node das funções
`api/`, antes do rastreamento e de `includeFiles`. Isso garante a geração de
`dist/index.html` no ambiente que empacota a função; o build estático separado
não garante que esse arquivo já exista nessa etapa. O caminho de leitura e
o `includeFiles` continuam sendo `dist/index.html`.
Os assets compilados e o body da SPA permanecem iguais. Não há SSR do conteúdo
visual nem lista de slugs gerada no build: cada requisição consulta o cadastro,
incluindo negócios publicados no futuro.

A função usa `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`, como o
sitemap, sem sessão e sem chave privilegiada. Seleciona somente id, nome,
categoria, história e caminho do logo. Os filtros exigem `status=published`,
`is_suspended=false` e `is_owner_paused=false`, além das permissões públicas
existentes. Na ausência de logo válido, consulta o caminho da primeira foto
pública, pela posição. Não faz alterações no Supabase.

Título, descrição e canonical são compartilhados com o SEO do React em
`src/utils/publicBusinessSeo.js`. O React preserva o HTML inicial enquanto
carrega os dados e atualiza o SEO quando a consulta termina. O script legado
de `?site=` não remove mais o canonical em uma URL `/negocio/:slug`.

Negócios indisponíveis retornam 404 com `noindex, nofollow`, sem canonical e
com o body da SPA preservado para a tela existente. Falhas de consulta retornam
503 com `Retry-After: 60` e `noindex, nofollow`. Todas as respostas usam
`Cache-Control: no-store`, evitando manter páginas indexáveis após uma pausa.
A consulta tem limite de 10 segundos. Falhas ao buscar a foto opcional podem
resultar em metadata sem imagem. URLs de imagem usam o bucket público existente;
não há verificação adicional da existência física do arquivo em cada acesso.
O catch registra `[public-business-seo]` com a etapa e códigos técnicos
permitidos (por exemplo, `read-template` / `ENOENT`). Na criação do cliente,
registra somente se as duas variáveis públicas estão presentes. Não registra
o erro bruto, mensagens, stack, URLs, valores de variáveis ou dados do cadastro.

## Validação local

```sh
npm run build
node --test tests/public-business-seo.test.mjs
git diff --check
```

No PowerShell com scripts bloqueados, usar `npm.cmd run build`.
Os testes executam a função com o HTML compilado e respostas públicas simuladas,
verificando filtros, escape HTML, canonical, preservação do body, indisponibilidade,
falha de consulta, GET/HEAD e rejeição de outros métodos.

A execução direta local com as variáveis de `.env.local` e leitura pública real
da Jenifer retornou HTTP 200 e:

```html
<title>Jenifer Costa - Psicanalista | GiroMicro</title>
<meta name="description" content="Jenifer Costa — Psicanalista Meu trabalho como psicanalista é acompanhar pessoas em um processo de mergulho em si mesmas, buscando compreender aquilo que se..." />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="https://www.giromicro.com.br/negocio/jenifer-costa-psicanalista" />
```

Open Graph e Twitter receberam o mesmo título/descrição e a URL pública do logo;
`og:type=website` e `twitter:card=summary_large_image`.

`vite dev` e `vite preview` sozinhos não executam funções Vercel. O teste local
da função não valida o empacotamento/roteamento na infraestrutura Vercel.
Na revisão do 503, o builder oficial `@vercel/node@14.0.0` foi executado
localmente: `NodejsLambda.files` incluiu `dist/index.html` (2.527 bytes),
idêntico ao HTML produzido pelo Vite. A função copiada com os arquivos desse
bundle para um runtime isolado retornou HTTP 200 com dados públicos simulados.
O 503 sem chamadas externas é compatível com HTML ausente, mas também com
configuração pública ausente; sem o erro original do Preview, não é possível
atribuir definitivamente o incidente a apenas uma dessas causas.
Após aprovação, conferir isso em preview com o build da Vercel, verificando
também os assets no navegador. Nenhum deploy foi realizado nesta implementação.
A mudança acrescenta uma consulta pública por acesso (duas sem logo); o conteúdo
visual continua dependendo de JavaScript. O resultado exibido pelo Google só
poderá ser observado após publicação e nova indexação.

Referências: [arquivos em funções Vercel](https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions)
e [seleção de colunas Supabase](https://supabase.com/docs/reference/javascript/select).
