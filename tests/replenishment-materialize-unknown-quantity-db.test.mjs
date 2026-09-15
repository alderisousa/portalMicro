// Teste focado da correcao cirurgica em
// market_materialize_replenishment_order_draft_internal: um candidato
// critical/high/medium com suggested_quantity NULL ("a definir") precisa
// virar allocation na Lista de Compras, sem inventar quantidade, e a loja
// correspondente precisa aparecer no seletor. NULL continua bloqueando a
// aprovacao ate a revisao manual, exatamente como ja acontecia para
// candidatos com quantidade conhecida.
//
// Reusa apenas o schema/fixture/helpers de replenishment-order-contract-db
// (nao suas suites, que estao desatualizadas em relacao a 202609130004),
// no mesmo padrao ja usado por replenishment-purchasing-db.test.mjs.
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const fixtureUrl = new URL('./replenishment-order-contract-db.test.mjs', import.meta.url)
let setup = readFileSync(fixtureUrl, 'utf8').split("\ntest('materializacao")[0]
setup = setup.replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href))
  .replace(/from '(\.\.[^']+)'/g, (_match, path) => `from '${new URL(path, fixtureUrl).href}'`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,approve,account,run,storeA,productA,productB,productD,request,sqlFile};').toString('base64')}`)
const { db, query, generate, approve, account, run, storeA, productA, productB, productD, request, sqlFile } = fixture

// Correcao desta tarefa: materializacao preserva candidatos critical/high/medium
// com suggested_quantity NULL em vez de exclui-los.
await db.exec(sqlFile('202609150001_fix_replenishment_materialize_unknown_quantity.sql'))
// Sem isto, generate() desta fixture ainda chamaria a versao monolitica de
// 202609120004 (que nao delega para _internal); 202609130004 restaura a
// delegacao publica -> interna usada em producao.
await db.exec(sqlFile('202609130004_fix_replenishment_active_order_reuse.sql'))

test('candidato medium com suggested_quantity NULL gera allocation, nao inventa quantidade e bloqueia aprovacao ate revisao', async () => {
  const batchCandidate = (await query(
    'select priority_level, suggested_quantity from public.market_replenishment_candidates where run_id=$1 and product_id=$2 and store_id=$3',
    [run, productB, storeA],
  ))[0]
  assert.equal(batchCandidate.priority_level, 'medium')
  assert.equal(batchCandidate.suggested_quantity, null)

  const id = await generate()

  const item = (await query(
    'select total_suggested_quantity, suggested_purchase_quantity from public.market_replenishment_order_items where order_id=$1 and product_id=$2',
    [id, productB],
  ))[0]
  assert.ok(item, 'produto com necessidade medium desconhecida precisa virar item da lista')
  assert.equal(item.total_suggested_quantity, null)
  assert.equal(item.suggested_purchase_quantity, null)

  const allocation = (await query(`
    select a.id, a.store_id, a.candidate_id, a.status, a.suggested_quantity, a.warehouse_allocated_quantity, a.purchase_needed_quantity
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id
    where i.order_id=$1 and i.product_id=$2
  `, [id, productB]))[0]
  assert.ok(allocation, 'a loja com necessidade desconhecida precisa aparecer com allocation propria')
  assert.equal(allocation.store_id, storeA)
  assert.equal(allocation.status, 'pending')
  assert.ok(allocation.candidate_id, 'mantem rastreabilidade ate o candidato do batch')
  // Nada foi inventado: NULL permanece NULL, nunca vira 0.
  assert.equal(allocation.suggested_quantity, null)
  assert.equal(allocation.warehouse_allocated_quantity, null)
  assert.equal(allocation.purchase_needed_quantity, null)

  // Seletor de lojas da Lista de Compras: a loja aparece por ter allocation
  // ativa, nao-cancelada e de prioridade != low (mesmo criterio do front-end).
  const selectableStores = await query(`
    select distinct a.store_id
    from public.market_replenishment_order_allocations a
    join public.market_replenishment_order_items i on i.id=a.order_item_id
    join public.market_replenishment_candidates c on c.id=a.candidate_id
    where i.order_id=$1 and a.status<>'cancelled' and i.status<>'cancelled' and c.priority_level<>'low'
  `, [id])
  assert.ok(selectableStores.some((row) => row.store_id === storeA), 'a loja precisa poder ser selecionada para montar a lista')

  // Quantidade pendente continua bloqueando aprovacao (fluxo de revisao preservado).
  await assert.rejects(approve(id), /REVIEW_PENDING/)

  // Operador define as quantidades da loja: revisao resolve a pendencia.
  await query(
    'select public.market_update_replenishment_allocation_review($1,$2,$3,$4,$5)',
    [account, id, allocation.id, 2, 3],
  )
  const reviewed = (await query(
    'select suggested_quantity, adjusted_quantity, warehouse_allocated_quantity, purchase_needed_quantity from public.market_replenishment_order_allocations where id=$1',
    [allocation.id],
  ))[0]
  assert.equal(reviewed.suggested_quantity, null, 'a sugestao original do batch permanece NULL; so a revisao humana passa a ser explicita')
  assert.equal(Number(reviewed.adjusted_quantity), 5)
  assert.equal(Number(reviewed.warehouse_allocated_quantity), 2)
  assert.equal(Number(reviewed.purchase_needed_quantity), 3)

  // Demais candidatos (critical/high, quantidade ja conhecida) continuam intactos.
  const productAAllocations = await query(
    'select count(*)::int n from public.market_replenishment_order_allocations a join public.market_replenishment_order_items i on i.id=a.order_item_id where i.order_id=$1 and i.product_id=$2',
    [id, productA],
  )
  assert.equal(productAAllocations[0].n, 3)

  // Baixa prioridade continua fora da lista operacional (regra de 202609120001, nao alterada aqui).
  const productDItem = await query('select 1 from public.market_replenishment_order_items where order_id=$1 and product_id=$2', [id, productD])
  assert.equal(productDItem.length, 0)

  // Apos a revisao, a aprovacao deixa de ser bloqueada por esta pendencia.
  const req = request()
  await approve(id, req)
  const order = (await query('select status from public.market_replenishment_orders where id=$1', [id]))[0]
  assert.equal(order.status, 'approved')
})
