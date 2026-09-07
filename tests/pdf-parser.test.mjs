import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import test from 'node:test'

registerHooks({ resolve(specifier, context, next) {
  return next(specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { extractPurchaseOcrDocumentFromPdfTextItems: parse, extractPurchaseOcrDocumentFromLines, linesFromPdfTextItems } = await import('../src/utils/purchaseOcrExtraction.ts')
const { evaluateDocumentTotals } = await import('../src/utils/purchaseOcrMath.ts')
const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url)))[0]
const values = (fields) => Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value]))

for (const name of ['jf', 'carmel']) {
  test(`${name}: cabeçalho, itens, precisão e totais do PDF real`, () => {
    const { header, items } = parse(fixture(name))
    const jf = name === 'jf'
    assert.deepEqual(values(header), {
      supplierName: jf ? 'JF DISTRIBUIDORA DE DOCES E BEBIDAS - EIRELI' : 'CARMEL INDUSTRIA E COMERCIO DE SOBREMESAS LTDA',
      supplierCnpj: jf ? '32.193.036/0001-25' : '28.620.040/0001-55',
      documentNumber: jf ? '15915' : '000081176', series: '1', issueDate: jf ? '20/07/2026' : '31/08/2026',
      accessKey: jf ? null : '41260828620040000155550010000811761003893223',
      productsTotal: jf ? 2184.92 : 275.22, discount: 0, freight: 0, otherExpenses: 0, invoiceTotal: jf ? 2184.92 : 278.72,
    })
    assert.equal(items.length, jf ? 22 : 2)
    assert.ok(items.every((item) => item.lineStatus === 'ok'))
    assert.equal(evaluateDocumentTotals(header, items).status, 'match')
    const row = (item) => [item.barcode.value ?? item.supplierCode.value, item.description.value, item.unit.value, item.quantity.value, item.unitPrice.value, item.lineTotal.value]
    if (jf) {
      assert.deepEqual(row(items[0]), ['7892840825133', 'LAYS CLASSICAS 62G', 'UN', 15, 7.69, 115.35])
      assert.deepEqual(row(items[1]), ['7892840825126', 'CEBOLITOS 35G', 'UN', 15, 4.35, 65.25])
      assert.deepEqual(row(items.at(-1)), ['7622210575999', 'Lacta Bis Branco c/16', 'UN', 10, 5.5, 55])
    } else {
      assert.deepEqual(row(items[0]), ['1732', 'CREME ACAI ULTRACAI POTE 1Lt TRADICIONAL CX 6 UN', 'CX', 1, 167.4, 167.4])
      assert.deepEqual(row(items[1]), ['3728', 'CX C/4 PT 1L PREMIUM CHOCOLATE BELGA COM AMARENA', 'UN', 1, 107.8167, 107.82])
    }
  })
  test(`${name}: escala/translação e ordem de TextItems independentes do fornecedor`, () => {
    const original = fixture(name)
    const transformed = original.map((item) => ({ ...item, width: item.width * 1.4, height: item.height * 1.4, transform: item.transform.map((v, i) => i === 4 ? v * 1.4 + 70 : i === 5 ? v * 1.4 + 40 : v) })).reverse()
    const clean = (document) => ({ header: values(document.header), items: document.items.map(({ id, rawSourceText, ...item }) => item) })
    assert.deepEqual(clean(parse(transformed)), clean(parse(original)))
  })
}
test('inconsistência matemática permanece para revisão', () => {
  const input = fixture('jf').map((item) => item.str === '15,000' ? { ...item, str: '500,00' } : item)
  const result = parse(input)
  assert.equal(result.items.length, 22)
  assert.equal(result.items[0].lineStatus, 'review')
})
test('página administrativa sem tabela não cria itens', () => {
  assert.equal(parse(fixture('jf').filter((item) => item.transform[5] > 610)).items.length, 0)
})
test('entrada vazia e caminho OCR anterior preservados', () => {
  assert.equal(parse([]).items.length, 0)
  const line = [{ str: 'Fornecedor: Exemplo', transform: [1, 0, 0, 1, 20, 130], width: 140, height: 10 }, { str: '1234 BISCOITO 2 UN 3,00 6,00', transform: [1, 0, 0, 1, 20, 100], width: 240, height: 10 }]
  const result = extractPurchaseOcrDocumentFromLines(linesFromPdfTextItems(line))
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].quantity.value, 2)
})
