import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import ExcelJS from 'exceljs'

const source = readFileSync(new URL('../src/utils/marketDuplicateProductsExport.ts', import.meta.url), 'utf8')
const compiled = stripTypeScriptTypes(source.replace("'exceljs'", JSON.stringify(import.meta.resolve('exceljs'))))
const { createDuplicateProductsSpreadsheet } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('XLSX real preserva textos/EANs, ordena grupos e produtos sem modificar a análise', async () => {
  const groups = [
    { description: 'NESCAU ACHOCOLATADO ORIGINAL 370G', products: [
      { id: '2', description: 'nescau  achocolatado original 370g ', ean: '7891000426210' },
      { id: '1', description: 'NESCAU ACHOCOLATADO ORIGINAL 370G', ean: '7891000352175' },
    ] },
    { description: 'ARROZ', products: [
      { id: '4', description: 'arroz', ean: '00010' },
      { id: '3', description: ' ARROZ ', ean: '00002' },
    ] },
  ]
  const before = structuredClone(groups)
  groups.forEach((g) => { g.products.forEach(Object.freeze); Object.freeze(g.products); Object.freeze(g) })
  Object.freeze(groups)
  const { buffer, filename } = await createDuplicateProductsSpreadsheet(groups, new Date(2026, 8, 17, 23, 30))
  assert.equal(filename, 'produtos-duplicados-2026-09-17.xlsx')
  assert.equal(Buffer.from(buffer).subarray(0, 2).toString(), 'PK')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.worksheets[0]
  assert.equal(workbook.worksheets.length, 1)
  assert.equal(sheet.rowCount, 5)
  assert.equal(sheet.columnCount, 2)
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Descrição atual', 'EAN'])
  const rows = [2, 3, 4, 5].map((i) => [1, 2].map((j) => sheet.getRow(i).getCell(j).value))
  assert.deepEqual(rows, [
    [' ARROZ ', '00002'], ['arroz', '00010'],
    ['NESCAU ACHOCOLATADO ORIGINAL 370G', '7891000352175'],
    ['nescau  achocolatado original 370g ', '7891000426210'],
  ])
  assert.equal(sheet.getCell('B2').type, ExcelJS.ValueType.String)
  assert.equal(sheet.getCell('B2').numFmt, '@')
  assert.deepEqual(groups, before)
})

test('descrição iniciada com sinal de fórmula é preservada como texto', async () => {
  const { buffer } = await createDuplicateProductsSpreadsheet([
    { description: '=PRODUTO', products: [{ id: '1', description: '=PRODUTO', ean: '001' }] },
  ])
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  assert.equal(workbook.worksheets[0].getCell('A2').value, '=PRODUTO')
  assert.equal(workbook.worksheets[0].getCell('A2').type, ExcelJS.ValueType.String)
})

test('XLSX exporta somente os produtos carregados, sem acessar a rede', async () => {
  const groups = [{ description: 'PRODUTO', products: ['001', '002', '003', '004'].map((ean) => ({ id: ean, description: 'Produto', ean })) }]
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('Exportação não pode acessar a rede') }
  try {
    const { buffer } = await createDuplicateProductsSpreadsheet(groups, new Date(2026, 8, 17))
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)
    const sheet = workbook.worksheets[0]
    assert.equal(sheet.columnCount, 2)
    assert.deepEqual([2, 3, 4, 5].map((row) => sheet.getRow(row).values.slice(1)), [
      ['Produto', '001'], ['Produto', '002'], ['Produto', '003'], ['Produto', '004'],
    ])
    assert.equal(sheet.rowCount, 5)
  } finally {
    globalThis.fetch = originalFetch
  }
})
