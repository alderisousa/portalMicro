import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { accessKeyFromQrUrl, normalizeAccessKey, normalizeProviderDocument, parseImportRequest } from './core.ts'

const validKey = '35240511111111111111550010000000011000000013'

Deno.test('normalizes and validates an NF-e access key', () => {
  assertEquals(normalizeAccessKey(validKey.replace(/(.{4})/g, '$1 ')), validKey)
  assertThrows(() => normalizeAccessKey(validKey.slice(0, 43) + '9'))
})

Deno.test('extracts key only from an allowlisted HTTPS QR URL', () => {
  assertEquals(accessKeyFromQrUrl(`https://consulta.fazenda.gov.br/qrcode?p=${validKey}|2|x`, ['fazenda.gov.br']), validKey)
  assertThrows(() => accessKeyFromQrUrl(`http://consulta.fazenda.gov.br/?p=${validKey}`, ['fazenda.gov.br']))
  assertThrows(() => accessKeyFromQrUrl(`https://localhost/?p=${validKey}`, ['fazenda.gov.br']))
})

Deno.test('normalizes a structured provider document without inventing values', () => {
  const result = normalizeProviderDocument({
    accessKey: validKey, invoiceNumber: '1', supplier: { name: 'Fornecedor' }, totals: { totalAmount: 10 },
    items: [{ lineNumber: 1, description: 'Produto', quantity: 2, netAmount: 10 }],
  }, validKey, 'provider.example')
  assertEquals(result.items[0].netAmount, 10)
  assertEquals(result.items[0].unitPrice, undefined)
})

Deno.test('parseImportRequest defaults mode to import and only accepts explicit reimport', () => {
  const base = { marketAccountId: '00000000-0000-4000-8000-000000000001', destinationStoreId: '00000000-0000-4000-8000-000000000002', sourceType: 'access_key', sourceValue: validKey }
  assertEquals(parseImportRequest(base).mode, 'import')
  assertEquals(parseImportRequest({ ...base, mode: 'reimport' }).mode, 'reimport')
  assertEquals(parseImportRequest({ ...base, mode: 'delete-everything' }).mode, 'import')
  assertThrows(() => parseImportRequest({ ...base, marketAccountId: 'not-a-uuid' }))
})
