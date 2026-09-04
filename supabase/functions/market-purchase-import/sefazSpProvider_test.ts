import { assertEquals, assertThrows } from 'jsr:@std/assert@1'
import { normalizeProviderDocument } from './core.ts'
import { isSefazSpQrUrl, parseSefazSpNfceHtml, parseSefazSpQrUrl } from './sefazSpProvider.ts'

const fixture1 = Deno.readTextFileSync(new URL('./fixtures/sefaz-sp-nfce-sample.html', import.meta.url))
const fixture2 = Deno.readTextFileSync(new URL('./fixtures/sefaz-sp-nfce-sample-2.html', import.meta.url))

const qrUrl1 =
  'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35260961182051000176651120000245051357523012|2|1|1|04eb7564af4add673269445b04685ae87c681e10'
const qrUrl2 =
  'https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35260906057223050438650190000332231191914870|3|1'

Deno.test('recognizes only the SEFAZ-SP host', () => {
  assertEquals(isSefazSpQrUrl(qrUrl1), true)
  assertEquals(isSefazSpQrUrl('https://outro-host.gov.br/qrcode?p=123'), false)
  assertEquals(isSefazSpQrUrl('not a url'), false)
})

Deno.test('parses the QR access key regardless of how many segments follow it after "|"', () => {
  const a = parseSefazSpQrUrl(qrUrl1)
  const b = parseSefazSpQrUrl(qrUrl2)
  assertEquals(a.accessKey, '35260961182051000176651120000245051357523012')
  assertEquals(b.accessKey, '35260906057223050438650190000332231191914870')
  // a URL completa e validada e preservada como esta, nunca reconstruida a partir da chave
  assertEquals(a.url, qrUrl1)
  assertEquals(b.url, qrUrl2)
})

Deno.test('rejects hosts outside the SEFAZ-SP allowlist and non-model-65 keys', () => {
  assertThrows(() => parseSefazSpQrUrl('http://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35260961182051000176651120000245051357523012|2|1'))
  assertThrows(() => parseSefazSpQrUrl('https://outro-host.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=35260961182051000176651120000245051357523012|2|1'))
  assertThrows(() => parseSefazSpQrUrl('https://www.nfce.fazenda.sp.gov.br/outro/caminho.aspx?p=35260961182051000176651120000245051357523012|2|1'))
  // Mesma chave real com o campo de modelo trocado de 65 para 55 e DV recalculado
  // (garante checksum valido, exercitando a rejeicao por modelo e nao por DV).
  const model55Key = '35260961182051000176551120000245051357523010'
  assertThrows(() => parseSefazSpQrUrl(`https://www.nfce.fazenda.sp.gov.br/NFCeConsultaPublica/Paginas/ConsultaQRCode.aspx?p=${model55Key}|2|1`))
})

Deno.test('parses real NFC-e #1 (Atacadão/Marsil) without converting packaging units', () => {
  const raw = parseSefazSpNfceHtml(fixture1) as Record<string, unknown>
  const doc = normalizeProviderDocument(raw, '35260961182051000176651120000245051357523012', 'sefaz-sp')

  assertEquals(doc.invoiceNumber, '24505')
  assertEquals(doc.series, '112')
  assertEquals(doc.issuedAt, '2026-09-03T14:05:36-03:00')
  assertEquals(doc.supplier.name, 'DISTRIBUIDORA DE PRODUTOS ALIMENTICIOS MARSIL LTDA')
  assertEquals(doc.supplier.document, '61.182.051/0001-76')
  assertEquals(doc.totals.productsAmount, 2815.2)
  assertEquals(doc.totals.discountAmount, 105.06)
  assertEquals(doc.totals.totalAmount, 2710.14)
  assertEquals(doc.totals.freightAmount, undefined)
  assertEquals(doc.totals.otherAmount, undefined)
  assertEquals(doc.items.length, 24)

  assertEquals(doc.items[0].description, 'SUCRILH 240GR KELLOG ORIGINAL . UN0001UN')
  assertEquals(doc.items[0].supplierProductCode, '1316445')
  assertEquals(doc.items[0].quantity, 9)
  assertEquals(doc.items[0].unit, 'UN')
  assertEquals(doc.items[0].unitPrice, 7.49)
  // O total da linha fiscal e bruto (antes do desconto global do documento) - vai para
  // grossAmount. Nao existe liquido individual confiavel nesta fonte: netAmount (e
  // portanto calculated_unit_cost, que e gerado a partir dele) fica ausente/null.
  assertEquals(doc.items[0].grossAmount, 67.41)
  assertEquals(doc.items[0].netAmount, undefined)
  assertEquals(doc.items[0].barcode, undefined)
  assertEquals(doc.items[0].ncm, undefined)

  // Item real com "DP0030UN" na descricao: quantidade e unidade fiscais devem
  // permanecer exatamente como informadas (1 display), sem conversao para 30 unidades.
  const kinderBWhite = doc.items[18]
  assertEquals(kinderBWhite.description, 'KINDER B WHITE 39GR CHOC BCO.AVELA . DP0030UN')
  assertEquals(kinderBWhite.quantity, 1)
  assertEquals(kinderBWhite.unit, 'DP')
  assertEquals(kinderBWhite.unitPrice, 221.7)
  assertEquals(kinderBWhite.grossAmount, 221.7)
  assertEquals(kinderBWhite.netAmount, undefined)

  // sum(grossAmount) dos itens deve bater com productsAmount do cabecalho (confirma a
  // semantica: bruto por linha, sem desconto ratado) - foi o que o smoke test real
  // expunha via sum(gross_amount) no banco apos esta correcao.
  const sumGross1 = Math.round(doc.items.reduce((total, item) => total + (item.grossAmount ?? 0), 0) * 100) / 100
  assertEquals(sumGross1, doc.totals.productsAmount)
})

Deno.test('parses real NFC-e #2 (Sendas) and preserves repeated products as separate lines', () => {
  const raw = parseSefazSpNfceHtml(fixture2) as Record<string, unknown>
  const doc = normalizeProviderDocument(raw, '35260906057223050438650190000332231191914870', 'sefaz-sp')

  assertEquals(doc.invoiceNumber, '33223')
  assertEquals(doc.series, '19')
  assertEquals(doc.issuedAt, '2026-09-02T11:46:07-03:00')
  assertEquals(doc.supplier.name, 'SENDAS DISTRIBUIDORA S/A')
  assertEquals(doc.supplier.document, '06.057.223/0504-38')
  assertEquals(doc.totals.productsAmount, 753.07)
  assertEquals(doc.totals.discountAmount, 45.15)
  assertEquals(doc.totals.totalAmount, 707.92)
  assertEquals(doc.items.length, 30)

  const repeated = doc.items.filter((item) => item.description === 'TOALHA YURI 50F 2RL')
  assertEquals(repeated.length, 2)
  assertEquals(new Set(repeated.map((item) => item.lineNumber)).size, 2)

  const lineNumbers = doc.items.map((item) => item.lineNumber)
  assertEquals(new Set(lineNumbers).size, doc.items.length)

  // Mesma checagem de semantica monetaria na segunda nota real, para garantir que a
  // correcao nao foi ajustada especificamente para a fixture 1.
  assertEquals(doc.items.every((item) => item.netAmount === undefined), true)
  const sumGross2 = Math.round(doc.items.reduce((total, item) => total + (item.grossAmount ?? 0), 0) * 100) / 100
  assertEquals(sumGross2, doc.totals.productsAmount)
})

Deno.test('fails in a controlled way when the page has no items table', () => {
  assertThrows(() => parseSefazSpNfceHtml('<html><body>pagina inesperada</body></html>'))
})
