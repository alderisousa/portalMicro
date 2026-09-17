import ExcelJS from 'exceljs'
import type { MarketDuplicateGroup } from '../types/marketProducts'

export async function createDuplicateProductsSpreadsheet(groups: readonly MarketDuplicateGroup[], date = new Date()) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Duplicados no cadastro')
  sheet.columns = [
    { header: 'Descrição atual', key: 'description', width: 60 },
    { header: 'EAN', key: 'ean', width: 22 },
  ]
  sheet.getColumn('ean').numFmt = '@'
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]

  // Ordena cópias: não muda a análise nem separa variantes da mesma descrição.
  for (const group of [...groups].sort((a, b) => a.description.localeCompare(b.description, 'pt-BR'))) {
    for (const product of [...group.products].sort((a, b) => a.ean.localeCompare(b.ean, 'pt-BR', { numeric: true }))) {
      sheet.addRow({ description: product.description, ean: product.ean })
    }
  }
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return {
    filename: `produtos-duplicados-${day}.xlsx`,
    buffer: await workbook.xlsx.writeBuffer(),
  }
}
