import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'
registerHooks({ resolve(s,c,n) { return n(s.startsWith('.') && !/\.[a-z]+$/.test(s) ? `${s}.ts` : s,c) } })
const {
  pdfStagingDocument, canReviewPurchaseItem, isHumanReviewed, reviewProblems,
  purchaseConversionRequired, purchaseStockQuantity, purchaseStockUnitCost, reviewValueChanged,
  shouldSuggestNetAmountFromGross,
} = await import('../src/utils/purchaseReview.ts')
const { extractPurchaseOcrDocumentFromPdfTextItems: parse } = await import('../src/utils/purchaseOcrExtraction.ts')
for (const name of ['jf','carmel']) test(`${name}: original, código e EAN separados no payload`, () => {
  const pdf = JSON.parse(readFileSync(new URL(`fixtures/${name}.json`,import.meta.url)))[0]
  const parsed = parse(pdf)
  const original = pdfStagingDocument(parsed)
  const draft = structuredClone(original)
  draft.items[0].quantity = 7
  assert.equal(original.items[0].quantity,name === 'jf' ? 15 : 1)
  assert.equal(original.items[0].supplier_product_code,name === 'jf' ? '7892840825133' : '1732')
  assert.equal(original.items[0].barcode_raw,name === 'jf' ? '7892840825133' : null)
  assert.equal(draft.items[0].quantity,7)
})
test('match automático não confere nem bloqueia edição', () => {
  const item={ reconciliationStatus:'matched_auto', marketProductId:'product',stockEntryStatus:'pending',reviewedAt:null,reviewedBy:null }
  assert.equal(isHumanReviewed(item),false)
  assert.equal(canReviewPurchaseItem(item),true)
  assert.equal(canReviewPurchaseItem({...item,stockEntryStatus:'received'}),false)
})
test('conferência exige dados e conta consistente, com precisão do preço', () => {
  const values={description_raw:'Produto',unit:'UN',quantity:1,unit_price:107.8167,gross_amount:107.82,net_amount:107.82,discount_amount:0,freight_amount:0,other_amount:0}
  assert.deepEqual(reviewProblems(values),[])
  assert.ok(reviewProblems({...values,quantity:2}).length)
  assert.ok(reviewProblems({...values,quantity:NaN}).length)
})
test('conversão de embalagem: exigência, cálculo e nunca "?" como unidade', () => {
  assert.equal(purchaseConversionRequired({marketProductId:null,conversionFactor:null,stockUnit:null}),false)
  assert.equal(purchaseConversionRequired({marketProductId:'p',conversionFactor:null,stockUnit:'UN'}),true)
  assert.equal(purchaseConversionRequired({marketProductId:'p',conversionFactor:6,stockUnit:null}),true)
  assert.equal(purchaseConversionRequired({marketProductId:'p',conversionFactor:6,stockUnit:'UN'}),false)
  assert.equal(purchaseStockQuantity(1,6),6); assert.equal(purchaseStockQuantity(1,null),null)
  assert.equal(purchaseStockUnitCost(167.4,1,6),27.9); assert.equal(purchaseStockUnitCost(167.4,1,null),null)
  // net_amount ausente cai para grossAmount (mesmo fallback da coluna gerada
  // stock_unit_cost no banco); sem nenhum dos dois, continua null — nunca inventa valor.
  assert.equal(purchaseStockUnitCost(null,1,6,167.4),27.9)
  assert.equal(purchaseStockUnitCost(null,1,6,null),null)
  assert.equal(purchaseStockUnitCost(null,1,null,167.4),null)
  // O componente de conversão não deve mais usar "?" como unidade de fallback
  // (bug corrigido em 202609070003): valida por código, sem framework de DOM.
  const source = readFileSync(new URL('../src/components/PurchaseUnitConversionFields.tsx',import.meta.url),'utf8')
  assert.doesNotMatch(source,/\?\?\s*'\?'/)
  assert.match(source,/Unidade de estoque não identificada/)
})
test('destaque de "Original" só aparece quando o valor mudou', () => {
  assert.equal(reviewValueChanged(15,15),false)
  assert.equal(reviewValueChanged(15,10),true)
  assert.equal(reviewValueChanged('UN','UN'),false)
  assert.equal(reviewValueChanged('UN','CX'),true)
  assert.equal(reviewValueChanged(null,null),false)
  assert.equal(reviewValueChanged(null,'UN'),true)
})
test('aviso "valor total usado como custo" só aparece com net_amount ausente e gross_amount preenchido; nunca sobrescreve net_amount existente', () => {
  assert.equal(shouldSuggestNetAmountFromGross({net_amount:null,gross_amount:167.4}),true) // caso real Norac
  assert.equal(shouldSuggestNetAmountFromGross({net_amount:null,gross_amount:null}),false) // nada para sugerir
  assert.equal(shouldSuggestNetAmountFromGross({net_amount:167.4,gross_amount:167.4}),false) // já informado, não mostra
  assert.equal(shouldSuggestNetAmountFromGross({net_amount:0,gross_amount:167.4}),false) // 0 é um valor informado, não "ausente"
})
