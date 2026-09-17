import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'

const source = readFileSync(new URL('../src/services/marketProducts.ts', import.meta.url), 'utf8')
const compiled = stripTypeScriptTypes(source.replace("import { supabase } from '../lib/supabase'", 'const supabase = globalThis.duplicateTestClient'))
let moduleId = 0
async function load(client = {}) {
  globalThis.duplicateTestClient = client
  return import(`data:text/javascript;base64,${Buffer.from(compiled + `\n// ${moduleId++}`).toString('base64')}`)
}
const row = (id, description, ean) => ({ id, description, ean })
const nescau = 'NESCAU ACHOCOLATADO ORIGINAL 370G'

test('caso Nescau: dois EANs distintos no mesmo grupo, normalizando caixa e espaços', async () => {
  const { groupDuplicateProducts } = await load()
  const result = groupDuplicateProducts([
    row('1', nescau, '7891000352175'),
    row('2', '  nescau  achocolatado\toriginal 370g ', '7891000426210'),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].description, nescau)
  assert.deepEqual(result[0].products.map((p) => p.ean), ['7891000352175', '7891000426210'])
})

test('EAN ausente, vazio ou repetido não forma duplicidade; não aproxima descrições', async () => {
  const { groupDuplicateProducts } = await load()
  assert.deepEqual(groupDuplicateProducts([
    row('1', 'Produto', '001'), row('2', 'Produto', ' 001 '),
    row('3', 'Produto', null), row('4', 'Produto', '  '),
    row('5', 'Produto diferente', '002'), row('6', null, '003'), row('7', ' ', '004'),
  ]), [])
  assert.equal(groupDuplicateProducts([row('1', 'Produto', '001'), row('2', 'Produto', '002'), row('3', 'Produto', null)])[0].products.length, 2)
})

function clientFor(rows, { failAfter = Infinity } = {}) {
  let calls = 0
  return { from(table) {
    assert.equal(table, 'market_products')
    const filters = []
    let cursor
    const query = {
      select(fields) { assert.equal(fields, 'id,description,ean'); return this },
      eq(field, value) { filters.push([field, value]); return this },
      not() { return this },
      order(field, options) { assert.equal(field, 'id'); assert.equal(options.ascending, true); return this },
      limit() { return this },
      gt(field, value) { assert.equal(field, 'id'); cursor = value; return this },
      abortSignal() { return this },
      then(resolve, reject) {
        assert.deepEqual(filters, [['market_account_id', 'alderi'], ['status', 'active']])
        const data = rows.filter((r) => filters.every(([key, value]) => r[key] === value) && (!cursor || r.id > cursor)).slice(0, 1)
        return Promise.resolve(++calls > failAfter ? { data: null, error: new Error('consulta falhou') } : { data, error: null }).then(resolve, reject)
      },
    }
    return query
  } }
}

test('consulta mantém escopo/ativos e encontra duplicados entre páginas menores que o limite', async () => {
  const rows = [
    { ...row('1', nescau, '7891000352175'), market_account_id: 'alderi', status: 'active' },
    { ...row('2', nescau, '7891000426210'), market_account_id: 'alderi', status: 'active' },
    { ...row('3', nescau, '003'), market_account_id: 'outra', status: 'active' },
    { ...row('4', nescau, '004'), market_account_id: 'alderi', status: 'inactive' },
  ]
  const { listDuplicateMarketProducts } = await load(clientFor(rows))
  const groups = await listDuplicateMarketProducts('alderi')
  assert.equal(groups.length, 1)
  assert.equal(groups[0].products.length, 2)
  await assert.rejects(listDuplicateMarketProducts(' '), /Conta Market/)
})

test('falha em página posterior não retorna resultado parcial', async () => {
  const { listDuplicateMarketProducts } = await load(clientFor([
    { ...row('1', nescau, '7891000352175'), market_account_id: 'alderi', status: 'active' },
  ], { failAfter: 1 }))
  await assert.rejects(listDuplicateMarketProducts('alderi'), /consulta falhou/)
})
