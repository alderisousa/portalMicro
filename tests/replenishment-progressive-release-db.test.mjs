// Teste focado da liberacao progressiva por loja
// (market_release_replenishment_order_store, 202609150003): uma loja pode
// ser revisada e liberada sem exigir que as demais lojas da mesma ordem
// consolidada tambem estejam prontas.
//
// Reusa o fixture de replenishment-order-contract-db (schema + dados +
// generate/approve/reject/contractTest) e empilha por cima as mesmas
// migrations que os demais testes de reposicao ja usam para ter compra + NF
// + abastecimento funcionando de ponta a ponta, mais a migration desta
// tarefa.
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

const fixtureUrl = new URL('./replenishment-order-contract-db.test.mjs', import.meta.url)
let setup = readFileSync(fixtureUrl, 'utf8').split("\ntest('materializacao")[0]
setup = setup.replaceAll('import.meta.url', JSON.stringify(fixtureUrl.href))
  .replace(/from '(\.\.[^']+)'/g, (_match, path) => `from '${new URL(path, fixtureUrl).href}'`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(setup + '\nexport {db,query,generate,account,warehouseA,storeA,storeB,storeC,productA,request,reject,contractTest,reopen,approve};').toString('base64')}`)
const { db, query, generate, account, warehouseA, storeA, storeB, storeC, productA, request, reject, contractTest, reopen, approve } = fixture

const sqlFile = (name) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
await db.exec(sqlFile('202609130002_replenishment_purchase_tracking.sql'))
await db.exec(sqlFile('202609130003_replenishment_atomic_store_supply.sql'))
await db.exec(sqlFile('202609130004_fix_replenishment_active_order_reuse.sql'))
await db.exec(sqlFile('202609140004_integrate_replenishment_purchase_progress.sql'))
await db.exec(`alter table market_purchase_items add column conversion_factor numeric,add column reviewed_at timestamptz,add column reviewed_by uuid,add column received_by uuid;
 alter table market_stock_movements add column notes text,add column created_by uuid;
 create unique index receipt_test_source on market_stock_movements(market_account_id,movement_type,reference_type,reference_id,reference_item_id)
 where reference_type is not null and reference_id is not null and reference_item_id is not null;
 create or replace function market_has_role(p_account uuid,p_roles text[]) returns boolean language sql as $$
 select exists(select 1 from market_account_members where market_account_id=p_account and user_id=auth.uid() and role=any(p_roles) and status='active') $$;
 create or replace function market_is_accesys_current_product(p_account uuid,p_product uuid) returns boolean language sql as $$
 select exists(select 1 from market_products where id=p_product and market_account_id=p_account and status='active') $$;`)
await db.exec(sqlFile('202609140005_replenishment_post_purchase.sql'))
await db.exec(sqlFile('202609150003_replenishment_progressive_store_release.sql'))

const release = (orderId, storeId, req = request()) =>
  query('select market_release_replenishment_order_store($1,$2,$3,$4) id', [account, orderId, storeId, req]).then((rows) => rows[0].id)
const review = (orderId, allocationId, warehouse, purchase) =>
  query('select market_update_replenishment_allocation_review($1,$2,$3,$4,$5)', [account, orderId, allocationId, warehouse, purchase])
const allocationsOf = (orderId, storeId) => query(
  `select a.*,i.product_id,i.warehouse_stock_snapshot from market_replenishment_order_allocations a
   join market_replenishment_order_items i on i.id=a.order_item_id
   where i.order_id=$1 and a.store_id=$2 and a.status<>'cancelled' and i.status<>'cancelled'`,
  [orderId, storeId],
)
const operationLines = (orderId, storeId) => query(
  `select l.* from market_replenishment_operation_lines l
   join market_replenishment_order_allocations a on a.id=l.allocation_id
   where l.order_id=$1 and a.store_id=$2`,
  [orderId, storeId],
)
const purchaseDeclaration = (orderId, product) => query(
  'select * from market_replenishment_purchase_declarations where order_id=$1 and product_id=$2',
  [orderId, product],
).then((rows) => rows[0])
const read = (id) => query('select market_get_replenishment_order($1,$2) result', [account, id]).then((rows) => rows[0].result)
const orderStatus = (id) => query('select status,approval_revision from market_replenishment_orders where id=$1', [id]).then((rows) => rows[0])

contractTest('Vitality (storeA) liberada mantem Manhattan (storeB) pendente e editavel; Comprar so mostra Vitality', async () => {
  const id = await generate()
  const before = await allocationsOf(id, storeA)
  assert.ok(before.length > 0)

  // 1/2: libera so storeA.
  await release(id, storeA)
  let status = await orderStatus(id)
  assert.equal(status.status, 'approved')
  assert.equal(status.approval_revision, 1)

  const linesA = await operationLines(id, storeA)
  assert.ok(linesA.length > 0, 'storeA precisa ganhar operation_lines')
  const linesB = await operationLines(id, storeB)
  assert.equal(linesB.length, 0, 'storeB ainda nao liberada nao pode ter operation_lines')

  // market_get_replenishment_purchasing so enxerga operation_lines: so storeA aparece.
  const purchasing = (await query('select market_get_replenishment_purchasing($1,$2) data', [account, id]))[0].data
  for (const line of purchasing) {
    const storeIds = line.stores.map((s) => s.storeId)
    assert.ok(storeIds.includes(storeA))
    assert.ok(!storeIds.includes(storeB), 'storeB pendente nao pode aparecer em Comprar')
  }

  // 3: storeB continua editavel mesmo com a ordem fora de draft.
  // Galpao do produto ja esta todo comprometido por storeA/storeC (materializacao);
  // a revisao de storeB usa warehouse=0 para nao esbarrar nesse orcamento.
  const storeBAlloc = (await allocationsOf(id, storeB))[0]
  await review(id, storeBAlloc.id, 0, Number(storeBAlloc.suggested_quantity))
  const reviewed = (await allocationsOf(id, storeB)).find((a) => a.id === storeBAlloc.id)
  assert.equal(Number(reviewed.purchase_needed_quantity), Number(storeBAlloc.suggested_quantity))

  // 7: storeA (ja liberada) nao pode mais ter seu plano alterado.
  const storeAAlloc = (await allocationsOf(id, storeA))[0]
  await reject(() => review(id, storeAAlloc.id, 0, 1), /REPLENISHMENT_ORDER_STORE_RELEASED/)

  // Detalhe da ordem expoe releasedAt por allocation.
  const detail = await read(id)
  const item = detail.items.find((i) => i.productId === productA)
  const allocA = item.allocations.find((a) => a.storeId === storeA)
  const allocB = item.allocations.find((a) => a.storeId === storeB)
  assert.ok(allocA.releasedAt, 'allocation de storeA precisa mostrar releasedAt')
  assert.equal(allocB.releasedAt, null, 'allocation de storeB ainda nao liberada nao deve ter releasedAt')
})

contractTest('liberar Manhattan depois consolida a purchase declaration sem perder progresso; retry nao duplica', async () => {
  const id = await generate()
  const reqA = request()
  await release(id, storeA, reqA)

  const declBefore = await purchaseDeclaration(id, productA)
  assert.ok(declBefore, 'declaration deveria existir so com storeA')
  const targetOnlyA = Number(declBefore.target_quantity)

  // Marca parte como comprada antes da segunda liberacao.
  await query('select market_set_replenishment_purchased($1,$2,$3,$4)', [
    account, id, JSON.stringify([{ declarationId: declBefore.id, version: declBefore.purchase_version, quantity: targetOnlyA }]), request(),
  ])
  const declAfterBuy = await purchaseDeclaration(id, productA)
  assert.equal(Number(declAfterBuy.purchased_quantity), targetOnlyA)

  // Garante que storeB esta pronta (materializada com quantidade conhecida) e libera.
  await release(id, storeB)

  const declAfterRelease = await purchaseDeclaration(id, productA)
  assert.equal(declAfterRelease.approval_revision, declBefore.approval_revision, 'mesma revisao consolidada, sem fragmentar a compra')
  assert.ok(Number(declAfterRelease.target_quantity) > targetOnlyA, 'target precisa crescer com a necessidade de storeB somada')
  // 6: purchased_quantity da primeira liberacao nao pode ser perdido.
  assert.equal(Number(declAfterRelease.purchased_quantity), targetOnlyA)

  const linesB = await operationLines(id, storeB)
  assert.ok(linesB.length > 0)

  // 10: retry com o MESMO request_id da liberacao de storeB nao duplica linhas nem eventos.
  const storeBRelease = (await query(
    "select request_id from market_replenishment_order_store_releases where order_id=$1 and store_id=$2",
    [id, storeB],
  ))[0]
  await release(id, storeB, storeBRelease.request_id)
  const linesBAfterRetry = await operationLines(id, storeB)
  assert.equal(linesBAfterRetry.length, linesB.length, 'retry nao pode duplicar operation_lines')
  const events = await query(
    "select count(*)::int n from market_replenishment_order_events where order_id=$1 and event_type='ORDER_STORE_RELEASED' and request_id=$2",
    [id, storeBRelease.request_id],
  )
  assert.equal(events[0].n, 1, 'retry nao pode duplicar evento de liberacao')

  // Re-chamar liberar storeB com um request_id NOVO tambem nao duplica linhas
  // (idempotente pela ausencia de operation_lines pendentes, nao so pelo request_id).
  await release(id, storeB, request())
  const linesBAfterSecondCall = await operationLines(id, storeB)
  assert.equal(linesBAfterSecondCall.length, linesB.length)
})

contractTest('erro em Manhattan nao bloqueia liberacao da Vitality; erro estruturado aponta a allocation', async () => {
  const id = await generate()
  const storeBAlloc = (await allocationsOf(id, storeB))[0]
  // Simula "ainda nao revisada" (equivalente a suggested_quantity desconhecida
  // que ainda nao foi resolvida): o guard permite, pois storeB nao esta liberada.
  await query('update market_replenishment_order_allocations set warehouse_allocated_quantity=null,purchase_needed_quantity=null,adjusted_quantity=null,suggested_quantity=null where id=$1', [storeBAlloc.id])

  await reject(() => release(id, storeB), (error) => {
    assert.match(error.message, /REPLENISHMENT_RELEASE_REVIEW_PENDING/)
    const detail = JSON.parse(error.detail)
    assert.equal(detail.allocationId, storeBAlloc.id)
    assert.equal(detail.storeId, storeB)
    assert.equal(detail.productId, productA)
    return true
  })

  // storeA nao foi tocada pela falha de storeB: libera normalmente.
  await release(id, storeA)
  const status = await orderStatus(id)
  assert.equal(status.status, 'approved')
  const linesA = await operationLines(id, storeA)
  assert.ok(linesA.length > 0)
})

contractTest('saldo de Galpao nao pode ser comprometido acima do disponivel somando lojas ja liberadas', async () => {
  const id = await generate()
  const allocA = (await allocationsOf(id, storeA))[0]
  const allocB = (await allocationsOf(id, storeB))[0]
  const allocC = (await allocationsOf(id, storeC))[0]
  const snapshot = Number(allocA.warehouse_stock_snapshot)
  assert.ok(snapshot > 0, 'fixture precisa ter saldo de Galpao conhecido para este teste')

  // Zera o Galpao de storeB/storeC para liberar todo o saldo do produto para storeA.
  await review(id, allocB.id, 0, Number(allocB.suggested_quantity))
  await review(id, allocC.id, 0, Number(allocC.suggested_quantity))
  // storeA usa TODO o saldo de Galpao conhecido para o produto.
  await review(id, allocA.id, snapshot, 0)
  await release(id, storeA)

  // A revisao normal (market_update_replenishment_allocation_review) ja
  // impede sozinha que a SOMA de todas as lojas ultrapasse o snapshot --
  // por isso, para exercitar especificamente o orcamento consolidado por
  // LOJA JA LIBERADA no momento da liberacao (e nao no momento da revisao),
  // simula aqui uma allocation que chegou com Galpao>0 sem ter passado pela
  // revisao normal (ex.: estado legado/corrigido fora do fluxo padrao).
  await query(
    'update market_replenishment_order_allocations set warehouse_allocated_quantity=1,purchase_needed_quantity=0,adjusted_quantity=1 where id=$1',
    [allocC.id],
  )
  await reject(() => release(id, storeC), (error) => {
    assert.match(error.message, /REPLENISHMENT_RELEASE_WAREHOUSE_EXCEEDED/)
    const detail = JSON.parse(error.detail)
    assert.equal(detail.productId, productA)
    assert.equal(detail.storeId, storeC)
    assert.ok(detail.requestedWarehouse > detail.availableWarehouse)
    return true
  })
})

contractTest('ordem nao conclui enquanto Manhattan (storeB) continuar pendente; supply funciona para a loja liberada', async () => {
  const id = await generate()
  await release(id, storeA)

  // Saldo de Galpao suficiente NUM UNICO deposito (a fixture base o divide
  // entre warehouseA/warehouseB, e o FIFO de abastecimento exige que a
  // necessidade inteira caiba em um deposito so).
  await query(
    "insert into market_stock_movements(market_account_id,market_store_id,product_id,movement_type,direction,quantity,reference_type,reference_id,reference_item_id) values($1,$2,$3,'PURCHASE','IN',$4,'PURCHASE',$5,$6)",
    [account, warehouseA, productA, 999, request(), request()],
  )

  const supplyLine = (await query('select market_get_replenishment_store_supply($1,$2,null) data', [account, id]))[0].data
    .find((line) => line.storeId === storeA)
  assert.ok(supplyLine, 'storeA liberada precisa poder aparecer para abastecimento')
  const supplyForB = (await query('select market_get_replenishment_store_supply($1,$2,null) data', [account, id]))[0].data
    .find((line) => line.storeId === storeB)
  assert.equal(supplyForB, undefined, 'storeB pendente nao pode aparecer para abastecimento')

  const line = (await query('select market_get_replenishment_store_supply($1,$2,null) data', [account, id]))[0].data
    .find((entry) => entry.storeId === storeA)
  await query('select market_execute_replenishment_store_supply($1,$2,$3,$4,$5,$6,$7)', [
    account, id, line.allocationId, line.operationLineId, line.sourceStoreId, line.remainingQuantity, request(),
  ])

  // Mesmo com storeA totalmente entregue, a ordem nao pode concluir com storeB ainda pendente.
  const completed = await query('select market_complete_replenishment_order_internal($1,$2,$3) done', [account, id, request()])
  assert.equal(completed[0].done, false)
  const status = await orderStatus(id)
  assert.notEqual(status.status, 'completed')
})

// Ponto 1 (correcao desta rodada): market_replenishment_guard_review_internal,
// market_update_replenishment_allocation_review e
// market_cancel_replenishment_order_item_review passam a comparar
// r.approval_revision=v_order.approval_revision -- uma liberacao de uma
// revisao anterior (reopen + nova aprovacao) nao pode continuar congelando
// a loja. Cenarios 1-5 pedidos na revisao.
contractTest('Ponto 1: release rev1 -> reopen -> loja volta editavel -> release rev2 funciona; loja realmente liberada na revisao atual continua congelada', async () => {
  const id = await generate()

  // 1) release loja rev1.
  await release(id, storeA)
  let status = await orderStatus(id)
  assert.equal(status.status, 'approved')
  assert.equal(status.approval_revision, 1)
  const releaseRowRev1 = (await query(
    'select approval_revision from market_replenishment_order_store_releases where order_id=$1 and store_id=$2',
    [id, storeA],
  ))[0]
  assert.equal(releaseRowRev1.approval_revision, 1)

  // 2) reopen.
  await reopen(id)
  status = await orderStatus(id)
  assert.equal(status.status, 'draft')
  assert.equal(status.approval_revision, 1, 'reopen nao mexe na approval_revision -- a linha de release rev1 fica desatualizada de proposito')

  // 3) mesma loja volta a ficar editavel, mesmo com a linha de release (rev1) ainda existindo.
  const allocA = (await allocationsOf(id, storeA))[0]
  const newPurchase = Number(allocA.suggested_quantity) + 1
  await review(id, allocA.id, 0, newPurchase) // nao pode lancar REPLENISHMENT_ORDER_STORE_RELEASED
  const reviewed = (await allocationsOf(id, storeA)).find((a) => a.id === allocA.id)
  assert.equal(Number(reviewed.purchase_needed_quantity), newPurchase)

  // 4) release da mesma loja na nova revisao funciona.
  await release(id, storeA)
  status = await orderStatus(id)
  assert.equal(status.status, 'approved')
  assert.equal(status.approval_revision, 2)
  const releaseRowRev2 = (await query(
    'select approval_revision from market_replenishment_order_store_releases where order_id=$1 and store_id=$2',
    [id, storeA],
  ))[0]
  assert.equal(releaseRowRev2.approval_revision, 2)
  // operation_lines sao append-only: a rev1 (orfa apos o reopen) continua
  // existindo para historico/auditoria; a nova liberacao precisa ter criado
  // linhas FRESCAS na rev2 (nao apenas reaproveitado as antigas).
  const linesAllRevisions = await operationLines(id, storeA)
  const linesRev2 = linesAllRevisions.filter((line) => line.approval_revision === 2)
  assert.ok(linesRev2.length > 0, 'a nova liberacao precisa ter criado operation_lines na revisao 2')
  assert.ok(linesAllRevisions.some((line) => line.approval_revision === 1), 'as operation_lines da revisao 1 continuam existindo (append-only, nao apagadas pelo reopen)')

  // 5) loja realmente liberada NA REVISAO CORRENTE continua congelada (o fix
  // nao pode desligar a checagem, so escopa-la corretamente).
  await reject(() => review(id, allocA.id, 0, 1), /REPLENISHMENT_ORDER_STORE_RELEASED/)
  await reject(
    () => query('select market_cancel_replenishment_order_item_review($1,$2,$3,$4)', [account, id, allocA.order_item_id, 'teste']),
    /REPLENISHMENT_ORDER_ITEM_PARTIALLY_RELEASED/,
  )
})

contractTest('Ponto 1 nao regride o Ponto 2: top-up same-revision preserva released_at/released_by e retry com mesmo request_id continua idempotente', async () => {
  const id = await generate()
  const firstRequest = request()
  await release(id, storeA, firstRequest)
  const releaseBefore = (await query(
    'select released_at,released_by,request_id,approval_revision from market_replenishment_order_store_releases where order_id=$1 and store_id=$2',
    [id, storeA],
  ))[0]

  // 6) top-up same-revision: inclui produto manual para storeA (ja liberada)
  // e libera de novo com um request_id NOVO -- deve so acrescentar
  // operation_lines da allocation nova, preservando released_at/released_by/
  // request_id da linha original (comportamento do Ponto 2, inalterado).
  const newProduct = request()
  await query("insert into market_products(id,market_account_id,name) values($1,$2,'Produto Top-up Ponto 1')", [newProduct, account])
  await query(
    'select market_add_replenishment_order_manual_item($1,$2,$3,$4,$5)',
    [account, id, newProduct, 4, storeA],
  )
  await release(id, storeA, request())

  const releaseAfterTopUp = (await query(
    'select released_at,released_by,request_id,approval_revision from market_replenishment_order_store_releases where order_id=$1 and store_id=$2',
    [id, storeA],
  ))[0]
  assert.equal(releaseAfterTopUp.approval_revision, releaseBefore.approval_revision, 'top-up nao muda a revisao')
  assert.deepEqual(releaseAfterTopUp.released_at, releaseBefore.released_at, 'top-up same-revision preserva released_at original (Ponto 2 nao alterado)')
  assert.equal(releaseAfterTopUp.request_id, releaseBefore.request_id, 'top-up same-revision preserva request_id original (Ponto 2 nao alterado)')

  const newProductLines = await query(
    `select l.* from market_replenishment_operation_lines l
     join market_replenishment_order_allocations a on a.id=l.allocation_id
     join market_replenishment_order_items i on i.id=a.order_item_id
     where l.order_id=$1 and a.store_id=$2 and i.product_id=$3`,
    [id, storeA, newProduct],
  )
  assert.ok(newProductLines.length > 0, 'top-up precisa ter criado operation_lines para a allocation manual nova')

  // 7) retry com o MESMO request_id da primeira liberacao continua idempotente.
  const linesBeforeRetry = await operationLines(id, storeA)
  await release(id, storeA, firstRequest)
  const linesAfterRetry = await operationLines(id, storeA)
  assert.equal(linesAfterRetry.length, linesBeforeRetry.length, 'retry com mesmo request_id nao pode duplicar operation_lines')
  const eventsForFirstRequest = await query(
    "select count(*)::int n from market_replenishment_order_events where order_id=$1 and event_type='ORDER_STORE_RELEASED' and request_id=$2",
    [id, firstRequest],
  )
  assert.equal(eventsForFirstRequest[0].n, 1, 'retry nao pode duplicar o evento da primeira liberacao')
})

contractTest('Correcao Contrato 1: aprovacao global (fluxo legado) libera todas as lojas da ordem na mesma revisao', async () => {
  const id = await generate()
  const req = request()

  // 1) aprovacao global continua criando operation_lines para TODAS as
  // lojas com allocation ativa (storeA, storeB, storeC no fixture padrao).
  await approve(id, req)
  const status = await orderStatus(id)
  assert.equal(status.status, 'approved')
  assert.equal(status.approval_revision, 1)

  const linesA = await operationLines(id, storeA)
  const linesB = await operationLines(id, storeB)
  const linesC = await operationLines(id, storeC)
  assert.ok(linesA.length > 0, 'storeA precisa ganhar operation_lines na aprovacao global')
  assert.ok(linesB.length > 0, 'storeB precisa ganhar operation_lines na aprovacao global')
  assert.ok(linesC.length > 0, 'storeC precisa ganhar operation_lines na aprovacao global')
  assert.ok(linesA.every((l) => l.approval_revision === 1))
  assert.ok(linesB.every((l) => l.approval_revision === 1))
  assert.ok(linesC.every((l) => l.approval_revision === 1))

  // 2) cria release para todas as lojas ativas, na mesma revisao, com
  // released_by/request_id preenchidos.
  const releases = await query(
    'select store_id,approval_revision,released_by,request_id,released_at from market_replenishment_order_store_releases where order_id=$1 order by store_id',
    [id],
  )
  const releasedStoreIds = releases.map((r) => r.store_id).sort()
  assert.deepEqual(releasedStoreIds, [storeA, storeB, storeC].sort())
  for (const r of releases) {
    assert.equal(r.approval_revision, 1)
    assert.ok(r.released_at)
    assert.equal(r.request_id, req)
  }

  // 3) lifecycle consistency aceita a aprovacao: contractTest roda "set
  // constraints all immediate" no final do teste (dispara o constraint
  // trigger deferred sobre TODO o estado final, incluindo a conclusao do
  // item 4) -- se REPLENISHMENT_ORDER_TARGET_MISMATCH fosse levantado por
  // causa da aprovacao global, o teste inteiro falharia nesse ponto. (Nao
  // adianta forcar "set constraints all immediate" aqui no meio do teste:
  // ao contrario de um savepoint, o modo IMMEDIATE nao e desfeito por
  // "release savepoint" e passaria a exigir, prematuramente, que o pedido
  // ja estivesse com todas as operation_lines confirmadas antes mesmo da
  // ordem ir para in_progress -- o que so acontece no proprio fluxo real
  // dentro de market_execute_replenishment_store_supply, na mesma
  // transacao da confirmacao.)

  // 4) completion nao considera essas lojas como "ainda sem liberacao":
  // confirma manualmente todas as operation_lines (simulando compra +
  // abastecimento completos) e verifica que a conclusao funciona.
  await query("update market_replenishment_orders set status='in_progress',started_at=now() where id=$1", [id])
  const allLines = await query('select id,target_quantity from market_replenishment_operation_lines where order_id=$1 and approval_revision=1', [id])
  for (const line of allLines) {
    await query(
      'update market_replenishment_operation_lines set confirmed_quantity=target_quantity,started_at=now(),completed_at=now() where id=$1',
      [line.id],
    )
  }
  const completed = await query('select market_complete_replenishment_order_internal($1,$2,$3) ok', [account, id, request()])
  assert.equal(completed[0].ok, true, 'ordem aprovada globalmente, com todas as operation_lines confirmadas, precisa conseguir concluir')
  const finalStatus = await orderStatus(id)
  assert.equal(finalStatus.status, 'completed')
})
