import ExcelJS from 'exceljs'
import type { SaleMarginRow } from '../services/marketSaleMargin'

export async function createSaleMarginSpreadsheet(rows: readonly SaleMarginRow[], storeName: string, date = new Date()) {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Margem de venda')
  sheet.columns = [
    { header: 'Produto', key: 'product_name', width: 55 },
    { header: 'EAN', key: 'ean', width: 22 },
    { header: 'Código/SKU', key: 'code', width: 24 },
    { header: 'Custo', key: 'cost', width: 18 },
    { header: 'Origem do custo', key: 'cost_source', width: 24 },
    { header: 'Data última compra', key: 'purchase_date', width: 22 },
    { header: 'Fornecedor/Nota', key: 'purchase_reference', width: 45 },
    { header: 'Preço de venda', key: 'sale_price', width: 20 },
    { header: 'Margem atual (%)', key: 'current_margin_pct', width: 22 },
    { header: 'Margem desejada (%)', key: 'desired_margin_pct', width: 24 },
    { header: 'Diferença (p.p.)', key: 'difference_pp', width: 22 },
  ]
  for (const key of ['ean', 'code']) sheet.getColumn(key).numFmt = '@'
  for (const key of ['cost', 'sale_price', 'current_margin_pct', 'desired_margin_pct', 'difference_pp']) sheet.getColumn(key).numFmt = '0.00'
  sheet.getColumn('purchase_date').numFmt = 'dd/mm/yyyy'
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  // Todos os resultados da mesma consulta/loja, sem o limite visual de 20.
  for (const row of rows) sheet.addRow({ ...row,
    purchase_date: row.purchase_date ? new Date(row.purchase_date) : null,
    purchase_reference: [row.supplier_name, row.invoice_number ? `Nota ${row.invoice_number}` : null].filter(Boolean).join(' · '),
  })
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const name = storeName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80)
  return { filename: `margem-venda-${name}-${day}.xlsx`, buffer: await workbook.xlsx.writeBuffer() }
}
