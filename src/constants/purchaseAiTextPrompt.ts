// Prompt copiado pelo operador para colar numa IA externa (ChatGPT/Claude/etc)
// junto com o documento de compra. O contrato aqui DEVE bater exatamente com
// o que src/utils/purchaseAiTextParser.ts valida — qualquer ajuste em um dos
// dois lados precisa ser replicado no outro.
//
// v2 (esta versão): "items_total" foi renomeado para "products_total" depois
// de smoke tests reais (Gemini) mostrarem IAs interpretando "items_total"
// como contagem de itens em vez de valor monetário. v2 também endurece as
// regras de coluna/embalagem/EAN depois de casos reais: unidades contaminadas
// com o dígito da coluna vizinha (UND9/KG9), promoção indevida de código de
// fornecedor a EAN só por parecer um EAN-13, e confirmação de que quantidade
// por embalagem citada na descrição não deve alterar quantity/unit fiscais.
export const PURCHASE_AI_TEXT_SCHEMA_VERSION = '1.0'

export const PURCHASE_AI_TEXT_PROMPT = `Você vai analisar um documento de compra que eu enviarei junto com esta mensagem.

Sua tarefa é extrair os dados VISÍVEIS no documento e retornar SOMENTE um JSON válido no formato especificado abaixo.

REGRAS OBRIGATÓRIAS:

1. Não invente informações.
2. Não complete dados usando conhecimento externo.
3. Extraia somente informações que possam ser identificadas no próprio documento.
4. Não altere, corrija ou substitua códigos, EANs, SKUs ou códigos do fornecedor.
5. Preserve a descrição do produto conforme encontrada no documento.
6. Preserve a unidade fiscal encontrada na coluna de unidade do documento, por exemplo UN, UND, KG, CX, FD, PC, PT, DP etc.
7. Não converta caixa, pacote, display, fardo ou qualquer outra embalagem em unidade.
8. Não calcule quantidade de estoque.
9. Não faça conciliação com produtos de catálogo.
10. Não tente decidir qual produto deveria ser.
11. Se algum dado não puder ser identificado com segurança, use null.
12. Se houver dúvida relevante, registre-a em "warnings".
13. Valores monetários e quantidades devem ser números JSON, sem "R$".
14. Datas devem ser retornadas como AAAA-MM-DD quando identificáveis.
15. EAN, código de produto, CNPJ, chave de acesso, número da nota e série devem ser strings.
16. Não remova zeros à esquerda de campos textuais.
17. Não retorne explicações fora do JSON.
18. Não use Markdown.
19. Não use bloco \`\`\`json.
20. Retorne apenas o objeto JSON.

REGRAS PARA CÓDIGOS E CÓDIGO DE BARRAS:

21. Se o documento possuir campos separados e claramente identificados para código do produto e EAN/GTIN/código de barras, preserve cada um no respectivo campo.
22. Se houver somente uma coluna chamada "Código", "COD", "Cód. Produto", "Código Produto" ou equivalente, trate o valor como "supplier_product_code".
23. NÃO considere um número como EAN/GTIN apenas porque possui 8, 12, 13 ou 14 dígitos ou começa com 789.
24. Preencha "barcode" somente quando o documento permitir identificar com segurança que aquele valor representa EAN, GTIN ou código de barras.
25. Em caso de dúvida, preserve o valor em "supplier_product_code", deixe "barcode" como null e registre a dúvida em "warnings" quando ela for relevante.

REGRAS PARA TABELAS E COLUNAS:

26. Respeite as fronteiras visuais das colunas.
27. Não incorpore à unidade, quantidade, código ou valor caracteres pertencentes à coluna vizinha.
28. Exemplo: se a coluna de unidade mostra "KG" e existe um número na coluna seguinte, não transforme a unidade em "KG9".
29. Se a separação entre duas colunas estiver ilegível e não for possível determinar o valor com segurança, use null e registre um warning em vez de adivinhar.
30. Não use valores de ICMS, IPI, NCM, CFOP, CST, desconto ou outras colunas fiscais como quantidade, preço unitário ou total do item.

REGRAS PARA EMBALAGEM:

31. "quantity" e "unit" devem representar exclusivamente a quantidade e a unidade das respectivas colunas fiscais do item.
32. Informações de embalagem presentes dentro da DESCRIÇÃO não devem substituir nem alterar quantity ou unit.
33. Não deduza conversões a partir da descrição.
34. Não multiplique nem divida a quantidade fiscal usando informações como "CX C/6", "4 CX", "6PT", "1X20UND", "30M" ou similares encontradas na descrição.
35. Preserve essas informações apenas dentro de "description" quando fizerem parte dela.

Exemplo:
Se a descrição contiver:
"PAO BRIOCHE FATIADO CX 6PT - 4 CX"

e as colunas fiscais indicarem:
QUANT = 24
UN = PT

retorne:
"quantity": 24,
"unit": "PT"

Não transforme a quantidade em 4 CX e não calcule outra quantidade.

FORMATO OBRIGATÓRIO:

{
  "schema_version": "1.0",
  "document": {
    "supplier_name": null,
    "supplier_cnpj": null,
    "invoice_number": null,
    "series": null,
    "issue_date": null,
    "access_key": null,
    "products_total": null,
    "invoice_total": null
  },
  "items": [
    {
      "line_number": 1,
      "supplier_product_code": null,
      "barcode": null,
      "description": "",
      "quantity": null,
      "unit": null,
      "unit_price": null,
      "gross_amount": null,
      "net_amount": null
    }
  ],
  "warnings": []
}

REGRAS PARA OS TOTAIS:

36. "products_total" significa o VALOR MONETÁRIO TOTAL DOS PRODUTOS do documento, e não a quantidade de itens.
37. Preencha "products_total" somente quando esse valor puder ser identificado no documento.
38. "invoice_total" significa o valor monetário total da nota/documento.
39. Não use "Qtd. total de itens", número de volumes ou quantidade de produtos em "products_total".

IMPORTANTE:

- Gere um objeto em "items" para cada linha real de produto encontrada no documento.
- Não agrupe duas linhas iguais em uma única linha.
- Não misture frete, desconto, imposto, pagamento ou total geral como se fossem produtos.
- Preserve linhas repetidas quando elas realmente aparecerem separadamente no documento.
- Se algum texto estiver parcialmente ilegível, não substitua letras por aproximação apenas para completar a palavra.
- Se o nome do fornecedor não puder ser lido com segurança, use null e registre warning.
- Não tente melhorar os dados do documento.
- Extração fiel é mais importante do que preenchimento completo.
- Quando houver dúvida, prefira null + warning a uma suposição.

Agora analise o documento que vou anexar.`
