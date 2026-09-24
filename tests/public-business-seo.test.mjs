import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import handler from '../api/negocio/[slug].js'
import { createBusinessSeo } from '../src/utils/publicBusinessSeo.js'

const slug = 'jenifer-costa-psicanalista'
const business = { id: 'public-id', name: 'Jenifer Costa', category: 'Psicanalista', story: null, logo_path: 'owner/business/logo/photo.jpg' }

async function invoke(url, method = 'GET') {
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value }, end(body) { this.body = body } }
  await handler({ url, method }, response)
  return response
}

test('public HTML, filtering, escaping, unavailable pages and HTTP behavior', async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.VITE_SUPABASE_URL
  const originalKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY
  process.env.VITE_SUPABASE_URL = 'https://public.example.test'
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test'
  let row = business
  let fail = false
  let calls = []
  globalThis.fetch = async (input) => {
    const url = new URL(input)
    calls.push(url)
    if (fail) return new Response('{"message":"unavailable"}', { status: 503 })
    if (url.pathname.endsWith('/business_items')) return Response.json([{ image_path: 'owner/business/items/photo.jpg' }])
    assert.equal(url.searchParams.get('status'), 'eq.published')
    assert.equal(url.searchParams.get('is_suspended'), 'eq.false')
    assert.equal(url.searchParams.get('is_owner_paused'), 'eq.false')
    assert.equal(url.searchParams.get('slug'), `eq.${slug}`)
    assert.equal(url.searchParams.get('select'), 'id,name,category,story,logo_path')
    return Response.json(row ? [row] : [])
  }
  try {
    const template = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8')
    const page = await invoke(`/negocio/${slug}?slug=other&site=other`)
    assert.equal(page.statusCode, 200)
    assert.match(page.body, /<title>Jenifer Costa - Psicanalista \| GiroMicro<\/title>/)
    assert.match(page.body, /Conheça Jenifer Costa, Psicanalista, seus serviços e formas de contato no GiroMicro\./)
    assert.match(page.body, /<link rel="canonical" href="https:\/\/www.giromicro.com.br\/negocio\/jenifer-costa-psicanalista"/)
    assert.match(page.body, /name="robots" content="index, follow"/)
    assert.match(page.body, /name="twitter:card" content="summary_large_image"/)
    assert.match(page.body, /property="og:image"/)
    assert.equal((page.body.match(/<title>/g) ?? []).length, 1)
    assert.equal((page.body.match(/name="description"/g) ?? []).length, 1)
    assert.equal(page.body.split('<body>')[1], template.split('<body>')[1])
    assert.ok(!page.body.includes('Crie sua presença digital'))
    assert.ok(!page.body.includes('public-id'))
    assert.equal(page.headers['Cache-Control'], 'no-store')
    assert.equal(calls.length, 1)

    row = { ...business, logo_path: null, story: '  Atendimento   com escuta.  ' }
    const gallery = await invoke(`/api/negocio/${slug}/`)
    assert.match(gallery.body, /content="Atendimento com escuta\."/)
    assert.match(gallery.body, /items\/photo.jpg/)

    row = { ...business, name: '</title><script>alert(1)</script>', story: '" onload="alert(1)' }
    const escaped = await invoke(`/negocio/${slug}`)
    assert.ok(!escaped.body.includes('<script>alert(1)</script>'))
    assert.match(escaped.body, /&lt;script&gt;/)
    assert.match(escaped.body, /&quot; onload=&quot;/)

    row = null // RLS/visibility filters omit missing, paused, suspended and unpublished rows.
    const unavailable = await invoke(`/negocio/${slug}`)
    assert.equal(unavailable.statusCode, 404)
    assert.match(unavailable.body, /noindex, nofollow/)
    assert.doesNotMatch(unavailable.body, /<link\b[^>]*rel="canonical"/)
    assert.ok(!unavailable.body.includes('og:image'))
    assert.equal(unavailable.body.split('<body>')[1], template.split('<body>')[1])

    fail = true
    const failure = await invoke(`/negocio/${slug}`)
    assert.equal(failure.statusCode, 503)
    assert.equal(failure.headers['X-Robots-Tag'], 'noindex, nofollow')
    assert.match(failure.body, /noindex, nofollow/)
    fail = false
    row = business
    const head = await invoke(`/negocio/${slug}`, 'HEAD')
    assert.equal(head.statusCode, 200)
    assert.equal(head.body, undefined)
    calls = []
    assert.equal((await invoke(`/negocio/${slug}`, 'POST')).statusCode, 405)
    assert.equal((await invoke('/negocio/%ZZ')).statusCode, 404)
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.VITE_SUPABASE_URL
    else process.env.VITE_SUPABASE_URL = originalUrl
    if (originalKey === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY
    else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = originalKey
  }
})

test('shared title and description rules', () => {
  assert.equal(createBusinessSeo({ name: ' Jenifer  Costa - ', category: ' | Psicanalista ' }).title, 'Jenifer Costa - Psicanalista | GiroMicro')
  assert.equal(createBusinessSeo({ name: ' Jenifer Costa ', category: ' ' }).title, 'Jenifer Costa | GiroMicro')
  assert.equal(createBusinessSeo({ name: 'Jenifer Costa' }).description, 'Conheça Jenifer Costa e suas formas de contato no GiroMicro.')
  assert.equal(createBusinessSeo({ name: 'Nome', story: ' Minha\n história. ' }).description, 'Minha história.')
  assert.equal(Array.from(createBusinessSeo({ name: 'Nome', story: 'a'.repeat(200) }).description).length, 160)
})
