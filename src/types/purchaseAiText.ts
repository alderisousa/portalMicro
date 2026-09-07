// Contrato JSON que a resposta de uma IA externa (ChatGPT/Claude/etc, colada
// manualmente pelo operador) precisa seguir para virar um documento de compra
// no MESMO staging usado por PDF. Versionado explicitamente: uma mudança de
// formato futura sobe schema_version e o parser passa a validar a nova forma.
export const AI_TEXT_SCHEMA_VERSION = '1.0'

export interface AiTextPurchaseDocumentHeader {
  supplier_name: string | null
  supplier_cnpj: string | null
  invoice_number: string | null
  series: string | null
  // AAAA-MM-DD; convertido para DD/MM/AAAA (formato que o staging já espera)
  // por aiTextStagingDocument, nunca pelo próprio parser de validação.
  issue_date: string | null
  access_key: string | null
  // Valor MONETÁRIO total dos produtos (nunca quantidade de itens/volumes) —
  // renomeado de items_total (v1) para products_total (v2) depois de smoke
  // tests reais mostrarem IA confundindo "items_total" com contagem de itens.
  products_total: number | null
  invoice_total: number | null
}

export interface AiTextPurchaseItem {
  line_number: number
  supplier_product_code: string | null
  barcode: string | null
  description: string
  quantity: number | null
  unit: string | null
  unit_price: number | null
  gross_amount: number | null
  net_amount: number | null
}

export interface AiTextPurchaseDocument {
  schema_version: string
  document: AiTextPurchaseDocumentHeader
  items: AiTextPurchaseItem[]
  warnings: string[]
}
