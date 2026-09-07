Fixtures de regressão do parser PDF

`jf.json` e `carmel.json` contêm, por página, os TextItems reais extraídos com
`pdfjs-dist/legacy/build/pdf.mjs`, `getPage()` e `getTextContent()` dos documentos
fornecidos nesta tarefa: `d3e04e33-5b43-4e86-ba19-75ad8c85e9a6.pdf` e
`NF AKIMERCADO.pdf`. Foram preservados `str`, `transform`, `width` e `height`,
inclusive textos administrativos, para testar também falsos positivos. Não são
PDFs sintéticos nem resultados esperados inseridos na entrada do parser.

Executar com Node 24: `node --test tests/pdf-parser.test.mjs`.
O teste usa o suporte nativo a TypeScript e um hook para resolver as importações
sem extensão existentes no projeto. Não requer dependências adicionais.

Para novo documento, extrair os mesmos campos de todas as páginas e adicionar
assertivas independentes para cabeçalho, identidade dos produtos, quantidades,
precisão, contagem e totais. Os arquivos contêm dados dos documentos originais.
