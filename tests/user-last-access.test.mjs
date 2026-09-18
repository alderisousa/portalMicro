import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { build } from 'rolldown'

const codes = {}
for (const path of ['src/services/userAccess.ts', 'src/pages/AdminUsers.tsx']) {
  const result = await build({ input: path, external: () => true, write: false, output: { format: 'cjs' }, transform: { jsx: 'react-jsx' } })
  codes[path] = result.output[0].code
}
function load(path, globals, imports) {
  const module = { exports: {} }
  runInNewContext(codes[path], { module, exports: module.exports, require: id => imports[id] ?? {}, ...globals })
  return module.exports
}
function recorder(result = { error: null }) {
  const calls = [], tasks = [], errors = []
  const api = load('src/services/userAccess.ts', { setTimeout: fn => tasks.push(fn), console: { error: (...args) => errors.push(args) } }, {
    '../lib/supabase': { supabase: { rpc: async (...args) => { calls.push(args); if (result instanceof Error) throw result; return result } } },
  })
  return { ...api, calls, errors, flush: async () => { tasks.splice(0).forEach(fn => fn()); await new Promise(resolve => setImmediate(resolve)) } }
}
test('bootstrap autenticado registra uma vez apesar de eventos e renders repetidos; novo bootstrap registra novamente', async () => {
  const h = recorder(), record = h.createAppAccessRecorder()
  record('BOOTSTRAP')
  record('BOOTSTRAP', 'user')
  record('INITIAL_SESSION', 'user')
  record('SIGNED_IN', 'user')
  record('BOOTSTRAP', 'user')
  assert.equal(h.calls.length, 0, 'nao executa RPC dentro do callback de Auth')
  await h.flush()
  assert.deepEqual(h.calls, [['register_my_last_access']])
  h.createAppAccessRecorder()('BOOTSTRAP', 'user')
  await h.flush()
  assert.equal(h.calls.length, 2)
})
test('token refresh e eventos de atividade nao registram acesso nem antes do bootstrap', async () => {
  const h = recorder(), record = h.createAppAccessRecorder()
  for (const event of ['TOKEN_REFRESHED', 'USER_UPDATED', 'SIGNED_OUT', 'NAVIGATION', 'API', 'VISIBILITYCHANGE']) record(event, 'user')
  await h.flush(); assert.equal(h.calls.length, 0)
  record('SIGNED_IN', 'user'); await h.flush()
  for (let i = 0; i < 3; i++) { record('TOKEN_REFRESHED', 'user'); record('SIGNED_IN', 'user') }
  await h.flush(); assert.equal(h.calls.length, 1)
})
test('erro RPC ou rede apenas loga; nao bloqueia nem repete durante a utilizacao', async () => {
  for (const result of [{ error: { message: 'denied' } }, Error('offline')]) {
    const h = recorder(result), record = h.createAppAccessRecorder()
    assert.equal(record('BOOTSTRAP', 'user'), undefined)
    await h.flush(); assert.equal(h.errors.length, 1)
    record('SIGNED_IN', 'user'); await h.flush(); assert.equal(h.calls.length, 1)
  }
})
test('Admin usa last_access_at, inclusive nulo, e apresenta hora sem mudar a data de cadastro', () => {
  const api = load('src/pages/AdminUsers.tsx', { Intl, Date }, {})
  assert.equal(api.formatAdminDate(null, true), api.formatAdminDate(null))
  assert.equal(api.formatAdminDate(undefined, true), api.formatAdminDate(null))
  assert.match(api.formatAdminDate('2026-09-18T15:20:00Z', true), /\d{2}:\d{2}/)
  for (const path of ['src/pages/AdminUsers.tsx', 'src/pages/AdminUserDetail.tsx']) {
    const source = readFileSync(path, 'utf8')
    assert.match(source, /formatAdminDate\(user.last_access_at, true\)/)
    assert.doesNotMatch(source, /last_sign_in_at/)
  }
})
test('App integra registro nao bloqueante apos identificar usuario e mantem controle fora do effect', () => {
  const app = readFileSync('src/App.tsx', 'utf8')
  assert.match(app, /\[recordAppAccess\] = useState\(createAppAccessRecorder\)/)
  assert.match(app, /applyAuthenticatedUser\(user\)\s+recordAppAccess\('BOOTSTRAP', user.id\)/)
  assert.match(app, /applyAuthenticatedUser\(user\)\s+recordAppAccess\(event, user.id\)/)
  assert.doesNotMatch(app, /await recordAppAccess/)
})
