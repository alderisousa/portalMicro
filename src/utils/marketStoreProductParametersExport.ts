import ExcelJS from 'exceljs'
import type { StoreProductExportRow } from '../services/marketStoreProductParameters'

export async function createStoreProductParametersSpreadsheet(rows: readonly StoreProductExportRow[], storeName: string, date = new Date()) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Parâmetros por loja')
  sheet.columns = [
    { header: 'Produto', key: 'product', width: 60 },
    { header: 'EAN', key: 'ean', width: 22 },
    { header: 'Código/SKU', key: 'sku', width: 24 },
    { header: 'Estoque mínimo', key: 'stock', width: 20 },
    { header: 'Produto essencial', key: 'essential', width: 22 },
    { header: 'Margem mínima desejada (%)', key: 'margin', width: 30 },
  ]
  sheet.getColumn('ean').numFmt = '@'
  sheet.getColumn('sku').numFmt = '@'
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  for (const row of [...rows].sort((a, b) => a.product.name.localeCompare(b.product.name, 'pt-BR'))) {
    sheet.addRow({ product: row.product.name, ean: row.product.ean, sku: row.product.sku,
      stock: row.minimum_stock === null ? null : Number(row.minimum_stock), essential: row.is_essential ? 'Sim' : 'Não',
      margin: row.minimum_margin_pct === null ? null : Number(row.minimum_margin_pct) })
  }
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const name = storeName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80)
  return { filename: `parametros-${name}-${day}.xlsx`, buffer: await workbook.xlsx.writeBuffer() }
}
