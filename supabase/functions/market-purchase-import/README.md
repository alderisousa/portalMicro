# market-purchase-import

Edge Function autenticada para importar uma NF-e estruturada para o staging de compras.

## Fluxo QR Code — SEFAZ-SP (NFC-e modelo 65)

Quando o `sourceValue` é uma URL de QR Code cujo host é `www.nfce.fazenda.sp.gov.br`, a
função usa o `SefazSpNfceProvider` (`sefazSpProvider.ts`) em vez do provider genérico:

- a própria URL do QR Code (validada) é o endpoint consultado — não depende de
  `NFE_PROVIDER_URL` nem de `NFE_PROVIDER_TOKEN`;
- o parâmetro `p` pode ter qualquer quantidade de segmentos separados por `|`; somente
  o primeiro segmento (a chave de 44 dígitos) é usado, a URL nunca é reconstruída;
- somente NFC-e modelo 65 é aceita (validado a partir da própria chave); modelo 55
  (NF-e) é rejeitado com erro controlado;
- path aceito: `/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx` (case-insensitive);
- o HTML da consulta pública é convertido para o mesmo formato aceito por
  `normalizeProviderDocument` (core.ts), reaproveitando toda a validação já existente;
- cada `<tr>` da tabela de itens vira uma linha independente — produtos repetidos na
  mesma nota NÃO são deduplicados na importação;
- unidade/quantidade fiscais são preservadas como estão (ex.: `Qtde.: 1`, `UN: DP`,
  descrição contendo `DP0030UN`) — nenhuma conversão de embalagem é feita aqui;
- `barcode` só é preenchido se a página trouxer um GTIN/EAN confiável; a página pública
  da SEFAZ-SP não expõe esse campo hoje, então `barcode` fica sempre ausente por este
  provider — o código interno do fornecedor vai em `supplierProductCode`;
- o "Vl. Total" de cada linha é o valor **bruto** (antes do desconto global do
  documento, que a página não rateia por item) — vai para `grossAmount`. Não existe
  líquido individual confiável nesta fonte: `netAmount` fica ausente, e por consequência
  `calculated_unit_cost` (gerado a partir de `net_amount / quantity`) permanece `null`
  até existir uma fonte real de líquido por item.

Outros hosts continuam pelo fluxo genérico abaixo (`StructuredHttpNfeProvider`).

## Configuração server-side

- `NFE_PROVIDER_URL`: endpoint HTTPS confiável que aceita `POST { "accessKey": "44 dígitos" }`.
- `NFE_PROVIDER_TOKEN`: bearer token do provider.
- `NFE_QR_ALLOWED_HOSTS`: hosts estaduais permitidos, separados por vírgula. Subdomínios são aceitos.

Não coloque essas variáveis no frontend. A função não acessa a URL informada pelo usuário: valida o host permitido, extrai a chave e consulta somente `NFE_PROVIDER_URL`. Redirects do provider são rejeitados.

## Contrato de resposta do provider

```json
{
  "accessKey": "...",
  "invoiceNumber": "123",
  "series": "1",
  "issuedAt": "2026-09-04T12:00:00-03:00",
  "supplier": { "name": "Fornecedor", "document": "00000000000100" },
  "totals": { "productsAmount": 100, "freightAmount": 0, "discountAmount": 0, "otherAmount": 0, "totalAmount": 100 },
  "items": [
    { "lineNumber": 1, "supplierProductCode": "ABC", "barcode": "789...", "description": "Produto", "unit": "UN", "quantity": 10, "unitPrice": 10, "grossAmount": 100, "netAmount": 100 }
  ]
}
```

Campos monetários ausentes permanecem ausentes. A função não inventa impostos ou rateios.
