import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
registerHooks({ resolve(s,c,n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s,c) } })

const { parseAiTextResponse, aiTextStagingDocument, AI_TEXT_SCHEMA_VERSION } = await import('../src/utils/purchaseAiTextParser.ts')
const { PURCHASE_AI_TEXT_PROMPT, PURCHASE_AI_TEXT_SCHEMA_VERSION } = await import('../src/constants/purchaseAiTextPrompt.ts')

const validPayload = () => ({
  schema_version: '1.0',
  document: {
    supplier_name: 'CARMEL INDUSTRIA E COMERCIO DE SOBREMESAS LTDA', supplier_cnpj: '28620040000155',
    invoice_number: '000081176', series: '1', issue_date: '2026-08-31', access_key: null,
    products_total: 275.22, invoice_total: 278.72,
  },
  items: [
    { line_number: 1, supplier_product_code: '1732', barcode: null, description: 'CREME ACAI ULTRACAI POTE 1LT TRADICIONAL CX 6 UN', quantity: 1, unit: 'CX', unit_price: 167.4, gross_amount: 167.4, net_amount: 167.4 },
    { line_number: 2, supplier_product_code: '3728', barcode: null, description: 'CX C/4 PT 1L PREMIUM CHOCOLATE BELGA COM AMARENA', quantity: 1, unit: 'CX', unit_price: 107.8167, gross_amount: 107.82, net_amount: 107.82 },
  ],
  warnings: [],
})

test('1. JSON válido puro é aceito', () => {
  const result = parseAiTextResponse(JSON.stringify(validPayload()))
  assert.equal(result.ok, true)
  assert.equal(result.data.items.length, 2)
})

test('2. JSON dentro de fence ```json é aceito e produz os mesmos dados', () => {
  const fenced = '```json\n' + JSON.stringify(validPayload(), null, 2) + '\n```'
  const result = parseAiTextResponse(fenced)
  assert.equal(result.ok, true)
  assert.equal(result.data.document.supplier_cnpj, '28620040000155')
})

test('3. JSON inválido (objeto malformado) é rejeitado com mensagem clara', () => {
  const result = parseAiTextResponse('{ "schema_version": "1.0", "document": {}, "items": [1,2,] }')
  assert.equal(result.ok, false)
  assert.match(result.error, /interpretar o JSON/)
})

test('4. texto antes/depois do JSON é rejeitado, mesmo com fence', () => {
  const withProse = 'Aqui está o JSON:\n' + JSON.stringify(validPayload()) + '\nEspero que ajude!'
  const result = parseAiTextResponse(withProse)
  assert.equal(result.ok, false)
  assert.match(result.error, /antes ou depois/)

  const fencedWithProse = 'Segue:\n```json\n' + JSON.stringify(validPayload()) + '\n```\nObrigado.'
  const result2 = parseAiTextResponse(fencedWithProse)
  assert.equal(result2.ok, false)
})

test('5. schema_version não suportado é rejeitado', () => {
  const result = parseAiTextResponse(JSON.stringify({ ...validPayload(), schema_version: '2.0' }))
  assert.equal(result.ok, false)
  assert.match(result.error, /não suportada/)
})

test('6. items vazio é rejeitado', () => {
  const result = parseAiTextResponse(JSON.stringify({ ...validPayload(), items: [] }))
  assert.equal(result.ok, false)
  assert.match(result.error, /Nenhum item/)
})

test('7. e 8. barcode e código do fornecedor preservam zeros à esquerda como string', () => {
  const payload = validPayload()
  payload.items[0].barcode = '07891000457474'
  payload.items[0].supplier_product_code = '007'
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.equal(result.data.items[0].barcode, '07891000457474')
  assert.equal(result.data.items[0].supplier_product_code, '007')
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.items[0].barcode_raw, '07891000457474')
  assert.equal(staged.items[0].supplier_product_code, '007')
})

test('9. campo ausente permanece null, nunca vira 0 ou string vazia', () => {
  const payload = validPayload()
  payload.items[0].quantity = null
  payload.items[0].unit_price = null
  payload.document.access_key = null
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.equal(result.data.items[0].quantity, null)
  assert.equal(result.data.items[0].unit_price, null)
  assert.equal(result.data.document.access_key, null)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.items[0].quantity, null)
  assert.equal(staged.items[0].unit_price, null)
  assert.equal(staged.header.accessKey, null)
})

test('10. warnings são aceitos e repassados', () => {
  const payload = { ...validPayload(), warnings: ['Descrição do item 2 ambígua quanto à embalagem.'] }
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.warnings, ['Descrição do item 2 ambígua quanto à embalagem.'])
})

test('11. quantidade em CX não é convertida para UN pelo mapeamento', () => {
  const result = parseAiTextResponse(JSON.stringify(validPayload()))
  assert.equal(result.ok, true)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.items[0].quantity, 1)
  assert.equal(staged.items[0].unit, 'CX')
  // net_amount ausente cai para gross_amount (mesma convenção do PDF), nunca inventa desconto
  assert.equal(staged.items[1].net_amount, 107.82)
})

test('data de emissão AAAA-MM-DD vira DD/MM/AAAA (formato que o staging já espera)', () => {
  const result = parseAiTextResponse(JSON.stringify(validPayload()))
  assert.equal(result.ok, true)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.header.issueDate, '31/08/2026')
})

test('data inválida é rejeitada sem tentar adivinhar', () => {
  const payload = validPayload(); payload.document.issue_date = '2026-02-30'
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, false)
  assert.match(result.error, /issue_date/)
})

test('número negativo é rejeitado; string em campo numérico é rejeitada', () => {
  const negative = validPayload(); negative.items[0].quantity = -1
  assert.equal(parseAiTextResponse(JSON.stringify(negative)).ok, false)
  const wrongType = validPayload(); wrongType.items[0].unit_price = 'sete reais'
  assert.equal(parseAiTextResponse(JSON.stringify(wrongType)).ok, false)
})

test('descrição obrigatória por item', () => {
  const payload = validPayload(); payload.items[0].description = '   '
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, false)
  assert.match(result.error, /descrição é obrigatória/)
})

test('resposta vazia é rejeitada com mensagem amigável', () => {
  assert.equal(parseAiTextResponse('').ok, false)
  assert.equal(parseAiTextResponse('   ').ok, false)
})

test('14. revisão antes da persistência: validar nunca chama a persistência diretamente', () => {
  const capture = readFileSync(new URL('../src/components/PurchaseAiTextCapture.tsx', import.meta.url), 'utf8')
  const validateBody = capture.match(/const validate = async \(\) => \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  assert.doesNotMatch(validateBody, /importAiTextPurchase|importPdfPurchase|\.rpc\(/, 'validate() só deve validar/mapear, nunca persistir')
  assert.match(capture, /PurchaseStagingReview/, 'a revisão reaproveita o componente compartilhado')
})

test('prompt armazenado reflete o contrato v2 realmente implementado (products_total, não items_total)', () => {
  assert.equal(PURCHASE_AI_TEXT_SCHEMA_VERSION, AI_TEXT_SCHEMA_VERSION)
  for (const field of ['supplier_name','supplier_cnpj','invoice_number','series','issue_date','access_key','products_total','invoice_total']) {
    assert.ok(PURCHASE_AI_TEXT_PROMPT.includes(`"${field}"`), `prompt deve mencionar document.${field}`)
  }
  assert.doesNotMatch(PURCHASE_AI_TEXT_PROMPT, /"items_total"/, 'items_total não é mais o campo oficial')
  for (const field of ['line_number','supplier_product_code','barcode','description','quantity','unit','unit_price','gross_amount','net_amount']) {
    assert.ok(PURCHASE_AI_TEXT_PROMPT.includes(`"${field}"`), `prompt deve mencionar items[].${field}`)
  }
  assert.match(PURCHASE_AI_TEXT_PROMPT, /Não converta caixa, pacote, display, fardo/)
  assert.match(PURCHASE_AI_TEXT_PROMPT, /Não faça conciliação com produtos de catálogo/)
  assert.match(PURCHASE_AI_TEXT_PROMPT, /NÃO considere um número como EAN\/GTIN apenas porque possui 8, 12, 13 ou 14 dígitos/)
  assert.match(PURCHASE_AI_TEXT_PROMPT, /VALOR MONETÁRIO TOTAL DOS PRODUTOS/)
})

test('1./3. products_total é aceito e mapeia para productsTotal no staging; items_total não tem efeito', () => {
  const result = parseAiTextResponse(JSON.stringify(validPayload()))
  assert.equal(result.ok, true)
  assert.equal(result.data.document.products_total, 275.22)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.header.productsTotal, 275.22)
})

test('2. items_total (campo antigo) é ignorado; sem fallback silencioso', () => {
  const payload = validPayload()
  delete payload.document.products_total
  payload.document.items_total = 999 // resquício do contrato v1, não deve ser lido
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.equal(result.data.document.products_total, null)
  assert.equal(aiTextStagingDocument(result.data).header.productsTotal, null)
})

test('4./5. código de fornecedor com "cara" de EAN-13 não vira barcode automaticamente', () => {
  const payload = validPayload()
  payload.items[0].supplier_product_code = '7896076000548'
  payload.items[0].barcode = null
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.equal(result.data.items[0].supplier_product_code, '7896076000548')
  assert.equal(result.data.items[0].barcode, null)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.items[0].supplier_product_code, '7896076000548')
  assert.equal(staged.items[0].barcode_raw, null, 'parser não deve promover código a EAN por parecer um')
})

test('6./7. net_amount null permanece null no Texto IA; gross_amount nunca é copiado para net_amount', () => {
  const payload = validPayload()
  payload.items[0].net_amount = null
  payload.items[0].gross_amount = 167.4
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  assert.equal(result.data.items[0].net_amount, null)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.items[0].net_amount, null)
  assert.equal(staged.items[0].gross_amount, 167.4)
})

test('8. unidades são preservadas exatamente como string, sem contaminação de coluna vizinha', () => {
  const payload = validPayload()
  payload.items[0].unit = 'UND'
  payload.items[1].unit = 'KG'
  const result = parseAiTextResponse(JSON.stringify(payload))
  assert.equal(result.ok, true)
  const staged = aiTextStagingDocument(result.data)
  assert.equal(staged.items[0].unit, 'UND')
  assert.equal(staged.items[1].unit, 'KG')
})

test('segurança: nenhum campo do contrato JSON carrega tenant/loja/conta — sempre vem do contexto autenticado', () => {
  const payload = validPayload()
  const keys = [...Object.keys(payload.document), ...Object.keys(payload.items[0])]
  for (const forbidden of ['market_account_id', 'account_id', 'tenant', 'store_id', 'destination_store_id', 'user_id', 'role']) {
    assert.ok(!keys.includes(forbidden), `contrato não deve ter campo "${forbidden}"`)
  }
  const parser = readFileSync(new URL('../src/utils/purchaseAiTextParser.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(parser, /market_account_id|destinationStoreId|destination_store_id/, 'o parser não deve ler nem derivar contexto de tenant/loja do JSON')
})
