import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  canRefreshMarketSales,
  formatMarketSalesSyncStatus,
  marketSalesRefreshRequest,
  marketSalesStatusRequest,
} from '../../../src/services/marketSalesSyncContract.ts'

const dashboardSource = readFileSync(
  new URL('../../../src/pages/MarketCommercialDashboard.tsx', import.meta.url),
  'utf8',
)

test('botao de atualizar e visivel somente para owner admin e manager', () => {
  assert.equal(canRefreshMarketSales('owner'), true)
  assert.equal(canRefreshMarketSales('admin'), true)
  assert.equal(canRefreshMarketSales('manager'), true)
  assert.equal(canRefreshMarketSales('operator'), false)
  assert.equal(canRefreshMarketSales('viewer'), false)
})

test('status tecnico e traduzido somente para apresentacao com fallback seguro', () => {
  assert.equal(formatMarketSalesSyncStatus('completed'), 'Concluída')
  assert.equal(formatMarketSalesSyncStatus('partial'), 'Concluída parcialmente')
  assert.equal(formatMarketSalesSyncStatus('failed'), 'Falhou')
  assert.equal(formatMarketSalesSyncStatus('running'), 'Em andamento')
  assert.equal(formatMarketSalesSyncStatus('unexpected'), 'Desconhecido')
  assert.equal(formatMarketSalesSyncStatus(null), 'Desconhecido')
})

test('request Market nunca envia integracao periodo role ou userId', () => {
  assert.deepEqual(marketSalesRefreshRequest('account-id'), {
    action: 'refresh', marketAccountId: 'account-id',
  })
  assert.deepEqual(marketSalesStatusRequest('account-id'), {
    action: 'status', marketAccountId: 'account-id',
  })
})

test('dashboard usa confirmacao loading e recarrega status e indicadores', () => {
  assert.match(dashboardSource, /<ConfirmDialog/)
  assert.match(dashboardSource, /onCancel=\{\(\) => setConfirmSync\(false\)\}/)
  assert.match(dashboardSource, /if \(syncing\) return/)
  assert.match(dashboardSource, /disabled=\{syncing\}/)
  assert.match(dashboardSource, /result\.status === 'completed' \|\| result\.status === 'partial'/)
  assert.match(dashboardSource, /await loadDashboard\(\)/)
  assert.match(dashboardSource, /await loadSyncStatus\(\)/)
})

test('dashboard nao chama Accesys diretamente e apresenta feedback amigavel', () => {
  assert.doesNotMatch(dashboardSource, /apigateway|accesyslab|fetch\(/i)
  assert.doesNotMatch(dashboardSource, /importe regularmente|relatório “Ontem”/i)
  assert.match(dashboardSource, /Vendas atualizadas parcialmente/)
  assert.match(dashboardSource, /Não foi possível atualizar as vendas/)
})
