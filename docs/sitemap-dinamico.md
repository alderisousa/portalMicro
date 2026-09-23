# Sitemap dinamico do GiroMicro

## Resumo copiavel

Implementada uma melhoria isolada: `/sitemap.xml` agora e encaminhado pelo
`vercel.json` para `api/sitemap.js`, uma Vercel Function que consulta o Supabase
a cada requisicao. O arquivo estatico `public/sitemap.xml` foi removido para
evitar conflito. Nenhuma dependencia foi adicionada.

A selecao preserva os filtros de `loadPublicBusiness` em `src/App.tsx`:
`status = 'published'`, `is_suspended = false`, `is_owner_paused = false`.
Booleanos nulos nao passam. Slugs nulos, vazios ou com espacos nas extremidades
sao excluidos: a rota publica aplica trim antes da consulta e esses slugs nao
identificam sua propria pagina. A policy existente
`businesses_select_public_owner_or_admin` permite leitura anonima desses negocios.

A funcao usa somente `VITE_SUPABASE_URL` e `VITE_SUPABASE_PUBLISHABLE_KEY`,
ja usadas pela SPA, sem sessao de usuario e sem service_role. Seleciona somente
slug, com paginacao ordenada pelo slug unico, inclusive quando o limite da API
e menor que o tamanho solicitado. Nao houve alteracao de banco ou RLS.

O XML inclui a home e URLs absolutas em https://www.giromicro.com.br/negocio/,
com codificacao do slug e escape XML. A resposta tem Content-Type XML e
Cache-Control: no-store. Erros de consulta/configuracao retornam HTTP 503,
sem publicar um sitemap incompleto como se fosse valido. GET e HEAD suportados.

Preservados src/App.tsx, SEO, robots.txt, rewrite /negocio/:slug para index.html,
SPA e demais modulos. Sem commit, push ou deploy.

Validacao executada: build aprovado (npm.cmd run build no PowerShell); consulta
anonima real retornou 3 negocios; XML real aprovado pelo parser XML do PowerShell;
testes locais com respostas simuladas cobriram filtros, slugs invalidos, valores
nulos, paginacao com limite reduzido, caracteres especiais, home, base vazia,
HEAD, metodo invalido e falha da API. O build emitiu avisos de chunks grandes.

## Validacao local

`npm run dev` e `npm run preview` servem apenas o Vite e nao executam funcoes
da Vercel. Para exercitar a funcao via HTTP, execute na raiz, em PowerShell,
com Node 22+ e `.env.local` configurado:

```powershell
@'
import { createServer } from 'node:http';
import sitemap from './api/sitemap.js';
createServer((req, res) => {
  if (req.url === '/sitemap.xml') return sitemap(req, res);
  res.statusCode = 404;
  res.end();
}).listen(3001, '127.0.0.1', () => console.log('http://127.0.0.1:3001/sitemap.xml'));
'@ | node --env-file=.env.local --input-type=module
```

Em outro terminal:

```powershell
$response = Invoke-WebRequest http://127.0.0.1:3001/sitemap.xml -UseBasicParsing
$response.StatusCode
$response.Headers['Content-Type']
[xml]$xml = $response.Content
$xml.urlset.url.loc
npm.cmd run build
```

## Depois do deploy

- Garantir as duas variaveis publicas no ambiente da Vercel, disponiveis a funcao.
- Repetir a validacao HTTP/XML usando https://www.giromicro.com.br/sitemap.xml.
- Confirmar home e negocios elegiveis; abrir as URLs /negocio/<slug> diretamente
  e atualizar o navegador para verificar o rewrite da SPA.
- Ao publicar/pausar um negocio pelo fluxo normal, verificar sua entrada/saida
  no sitemap sem novo deploy. Confirmar robots.txt inalterado.

O roteamento real da Vercel e a navegacao apos deploy ainda precisam dessa
validacao. A disponibilidade depende do Supabase e das variaveis do ambiente.
Sem cache, cada leitura consulta a API. Existe timeout total de consulta de 10s
e limite de 50.000 URLs por sitemap; acima disso sera necessario particionar.
Publicacoes simultaneas durante a paginacao podem aparecer na proxima consulta.
O sitemap facilita descoberta, mas o prazo de rastreamento/indexacao depende
do Google. Se os filtros da pagina publica mudarem, alinhar esta funcao.

Referencias: [Vercel Functions](https://vercel.com/docs/functions/runtimes/node-js)
e [Supabase Data API / RLS](https://supabase.com/docs/guides/api/securing-your-api).
