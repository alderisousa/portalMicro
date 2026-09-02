import assert from 'node:assert/strict'
import test from 'node:test'
import { mapAccesysOrder, mapAccesysPage, nextAccesysPage } from './accesysMapper.ts'
import { parseAccesysDateTime } from './dateTime.ts'
import { parseAccesysMoney } from './money.ts'

function fixture() {
  return {
    order: {
      id: 98765432, siteId: 4321, siteName: 'Loja Exemplo',
      customerId: 123, customerName: 'Pessoa Exemplo', customerDocument: '00000000000',
      itemsSumQuantity: 2, itemsQuantity: 1,
      itemsTotalValue: 'R$ 2.345,67', discountsAmount: 'R$ 45,67',
      couponValue: 'R$ 100,00', totalValue: 'R$ 2.200,00',
      createdAt: '01-09-2026 23:41:28', partnerId: 9,
    },
    orderItems: [{
      id: 111, orderId: 98765432, productId: 222, sku: ' 7890000000000 ',
      description: ' Produto ', quantity: 2, unitValue: 'R$ 1.172,84',
      totalValue: 'R$ 2.345,67', salePrice: 'R$ 1.150,00',
      totalSalePrice: 'R$ 2.300,00', subTotal: 'R$ 2.345,67',
      discount: 'R$ 45,67', netValueWithoutCoupons: 'R$ 2.300,00',
      couponsDiscountAmount: 'R$ 100,00', netValue: 'R$ 2.200,00',
    }],
    orderPayments: [{
      id: 333, orderId: 98765432, description: 'PIX', amount: 'R$ 2.200,00',
      date: '02-09-2026 00:01:02', detailDescription: ' Pix recebido ',
      detailBrand: '  ', detailCardType: null, authorizationId: ' AUTH-1 ',
    }],
    orderStatuses: [{ id: 444, orderId: 98765432, status: 'FINALIZED', refunded: false, error: false }],
  }
}

test('converte dinheiro pt-BR, inclusive milhares e NBSP', () => {
  assert.equal(parseAccesysMoney('R$ 1.234,56', 'amount'), 1234.56)
  assert.equal(parseAccesysMoney('R$\u00a00,00', 'amount'), 0)
})

test('rejeita dinheiro ausente, negativo ou malformado', () => {
  for (const value of [undefined, '10.00', 'R$ -1,00', 'R$ 1,2']) {
    assert.throws(() => parseAccesysMoney(value, 'amount'), /SYNC_INVALID_MONEY/)
  }
})

test('interpreta datetime Accesys em America/Sao_Paulo com offset explicito', () => {
  const result = parseAccesysDateTime('01-09-2026 23:41:28', 'createdAt')
  assert.equal(result, '2026-09-01T23:41:28-03:00')
  assert.equal(new Date(result).toISOString(), '2026-09-02T02:41:28.000Z')
})

test('rejeita datetime invalido ou sem o formato oficial', () => {
  assert.throws(() => parseAccesysDateTime('31-02-2026 10:00:00', 'createdAt'), /SYNC_INVALID_DATETIME/)
  assert.throws(() => parseAccesysDateTime('2026-09-01T10:00:00', 'createdAt'), /SYNC_INVALID_DATETIME/)
})

test('normaliza IDs numericos externos como strings estaveis', () => {
  const mapped = mapAccesysOrder(fixture())
  assert.equal(mapped.sale.externalOrderId, '98765432')
  assert.equal(mapped.sale.externalStoreId, '4321')
  assert.equal(mapped.items[0].externalItemId, '111')
  assert.equal(mapped.payments[0].externalPaymentId, '333')
})

test('mapeia productId Accesys apenas como externalProductId', () => {
  const item = mapAccesysOrder(fixture()).items[0]
  assert.equal(item.externalProductId, '222')
  assert.equal(item.productId, null)
})

test('nao inventa snapshots de custo', () => {
  const item = mapAccesysOrder(fixture()).items[0]
  assert.equal(item.unitCostSnapshot, null)
  assert.equal(item.totalCostSnapshot, null)
})

test('usa itemsSumQuantity como soma de unidades da venda', () => {
  assert.equal(mapAccesysOrder(fixture()).sale.itemsQuantity, 2)
})

test('mapeia totais da venda sem substituir ausencias por zero', () => {
  const sale = mapAccesysOrder(fixture()).sale
  assert.deepEqual(
    [sale.subtotalAmount, sale.discountAmount, sale.couponAmount, sale.totalAmount],
    [2345.67, 45.67, 100, 2200],
  )
  const invalid = fixture()
  delete (invalid.order as Record<string, unknown>).couponValue
  assert.throws(() => mapAccesysOrder(invalid), /SYNC_INVALID_MONEY/)
})

test('usa totalValue bruto e netValue liquido do item', () => {
  const item = mapAccesysOrder(fixture()).items[0]
  assert.equal(item.totalAmount, 2345.67)
  assert.equal(item.netAmount, 2200)
})

test('preserva PIX e limpa campos opcionais vazios', () => {
  const payment = mapAccesysOrder(fixture()).payments[0]
  assert.equal(payment.method, 'PIX')
  assert.equal(payment.description, 'Pix recebido')
  assert.equal(payment.brand, null)
  assert.equal(payment.authorizationId, 'AUTH-1')
})

test('preserva dados de cartao quando fornecidos', () => {
  const input = fixture()
  input.orderPayments[0].detailBrand = ' VISA '
  input.orderPayments[0].detailCardType = ' CREDIT '
  const payment = mapAccesysOrder(input).payments[0]
  assert.equal(payment.brand, 'VISA')
  assert.equal(payment.cardType, 'CREDIT')
})

test('arrays presentes, inclusive vazios, formam snapshots completos', () => {
  const input = fixture()
  input.orderItems = []
  input.orderPayments = []
  const mapped = mapAccesysOrder(input)
  assert.equal(mapped.sale.itemsSnapshotComplete, true)
  assert.equal(mapped.sale.paymentsSnapshotComplete, true)
})

test('arrays ausentes nao autorizam remocao de filhos anteriores', () => {
  const input = fixture() as Record<string, unknown>
  delete input.orderItems
  delete input.orderPayments
  const mapped = mapAccesysOrder(input)
  assert.equal(mapped.sale.itemsSnapshotComplete, false)
  assert.equal(mapped.sale.paymentsSnapshotComplete, false)
  assert.deepEqual(mapped.items, [])
  assert.deepEqual(mapped.payments, [])
})

test('multiplos status nao escolhem ordem arbitraria e agregam flags verdadeiras', () => {
  const input = fixture()
  input.orderStatuses = [
    { id: 1, orderId: 98765432, status: 'CREATED', refunded: false, error: false },
    { id: 2, orderId: 98765432, status: 'UNKNOWN', refunded: true, error: true },
  ]
  const sale = mapAccesysOrder(input).sale
  assert.equal(sale.externalStatus, null)
  assert.equal(sale.isRefunded, true)
  assert.equal(sale.hasError, true)
})

test('DTO serializado nao contem PII recebida nem raw payload', () => {
  const serialized = JSON.stringify(mapAccesysOrder(fixture()))
  assert.equal(serialized.includes('Pessoa Exemplo'), false)
  assert.equal(serialized.includes('00000000000'), false)
  assert.equal(serialized.includes('customerDocument'), false)
})

test('pagina comeca em 1, avanca ate pages e mapeia registros', () => {
  const page = mapAccesysPage({ records: 1, page: 1, pages: 2, items: [fixture()] })
  assert.equal(page.orders.length, 1)
  assert.equal(nextAccesysPage(page.page, page.pages), 2)
  assert.equal(nextAccesysPage(2, 2), null)
  assert.throws(() => mapAccesysPage({ records: 0, page: 0, pages: 1, items: [] }), /SYNC_INVALID_NUMBER/)
})

test('mapper nao produz campos ou comandos de estoque', () => {
  const serialized = JSON.stringify(mapAccesysOrder(fixture())).toLowerCase()
  assert.equal(serialized.includes('stock'), false)
  assert.equal(serialized.includes('estoque'), false)
})
