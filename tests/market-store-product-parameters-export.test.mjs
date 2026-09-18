import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import ExcelJS from 'exceljs'
const source=readFileSync('src/utils/marketStoreProductParametersExport.ts','utf8')
const compiled=stripTypeScriptTypes(source.replace("'exceljs'",JSON.stringify(import.meta.resolve('exceljs'))))
const {createStoreProductParametersSpreadsheet:create}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
test('XLSX real: seis colunas, zeros, nulos, EAN/SKU texto e margem numerica',async()=>{
 const rows=[{id:'2',product:{name:'Z Produto',ean:'000123',sku:'00002'},minimum_stock:0,is_essential:true,minimum_margin_pct:0},
 {id:'1',product:{name:'=Produto',ean:null,sku:null},minimum_stock:null,is_essential:false,minimum_margin_pct:25}]
 const before=structuredClone(rows)
 const {filename,buffer}=await create(rows,'Loja A',new Date(2026,8,18))
 assert.equal(filename,'parametros-Loja A-2026-09-18.xlsx')
 const book=new ExcelJS.Workbook();await book.xlsx.load(buffer);const sheet=book.worksheets[0]
 assert.equal(sheet.columnCount,6);assert.equal(sheet.rowCount,3)
 assert.deepEqual(sheet.getRow(1).values.slice(1),['Produto','EAN','Código/SKU','Estoque mínimo','Produto essencial','Margem mínima desejada (%)'])
 assert.equal(sheet.getCell('A2').value,'=Produto');assert.equal(sheet.getCell('A2').type,ExcelJS.ValueType.String)
 assert.equal(sheet.getCell('D2').value,null);assert.equal(sheet.getCell('F2').value,25)
 assert.equal(sheet.getCell('B3').value,'000123');assert.equal(sheet.getCell('C3').value,'00002')
 assert.equal(sheet.getCell('B3').numFmt,'@');assert.equal(sheet.getCell('D3').value,0);assert.equal(sheet.getCell('F3').value,0)
 assert.equal(sheet.getCell('E2').value,'Não');assert.equal(sheet.getCell('E3').value,'Sim')
 assert.deepEqual(rows,before)
})
