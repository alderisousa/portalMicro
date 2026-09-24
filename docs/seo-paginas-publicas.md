# SEO inicial das páginas públicas

`/negocio/:slug` é reescrita para `api/negocio/[slug].js`. A função lê
`dist/index.html`, incluído no pacote pela configuração `includeFiles` da
Vercel, e substitui apenas title, description, robots, canonical e tags sociais.
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
Após aprovação, conferir isso em preview com o build da Vercel, verificando
também os assets no navegador. Nenhum deploy foi realizado nesta implementação.
A mudança acrescenta uma consulta pública por acesso (duas sem logo); o conteúdo
visual continua dependendo de JavaScript. O resultado exibido pelo Google só
poderá ser observado após publicação e nova indexação.

Referências: [arquivos em funções Vercel](https://vercel.com/kb/guide/how-can-i-use-files-in-serverless-functions)
e [seleção de colunas Supabase](https://supabase.com/docs/reference/javascript/select).
