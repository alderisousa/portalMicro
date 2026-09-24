import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createBusinessSeo, createCanonicalBusinessUrl, normalizeSeoText } from '../../src/utils/publicBusinessSeo.js'

const escapeHtml = (value) => value.replace(/[<>&"']/g, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
})[character])

function publicImageUrl(supabase, path) {
  // Only persisted public bucket paths, as used by the SPA. Never blob/data/signed URLs.
  if (!path || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(path) || path.includes('..')) return ''
  const url = supabase.storage.from('business-media').getPublicUrl(path).data.publicUrl
  return /^https?:\/\//i.test(url) ? url : ''
}

function renderHtml(template, business, slug, image) {
  const { title, description } = business ? createBusinessSeo(business) : {
    title: 'Página não encontrada | GiroMicro',
    description: 'Este negócio não está disponível ou o endereço pode ter sido alterado.',
  }
  const canonical = createCanonicalBusinessUrl(slug)
  const meta = (attribute, key, value) => `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`
  const tags = [
    `<title>${escapeHtml(title)}</title>`,
    meta('name', 'description', description),
    meta('name', 'robots', business ? 'index, follow' : 'noindex, nofollow'),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', canonical),
    meta('property', 'og:type', 'website'),
    meta('name', 'twitter:title', title),
    meta('name', 'twitter:description', description),
    meta('name', 'twitter:card', image ? 'summary_large_image' : 'summary'),
  ]
  if (business) tags.push(`<link rel="canonical" href="${escapeHtml(canonical)}" />`)
  if (image) tags.push(meta('property', 'og:image', image), meta('name', 'twitter:image', image))

  // Replace only SEO in the built head; retain all Vite assets and the SPA body.
  return template.replace(/<head>([\s\S]*?)<\/head>/i, (_, head) => {
    const cleanHead = head.replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, '')
      .replace(/<meta\b[^>]*\b(?:name|property)=["'](?:description|robots|og:(?:title|description|url|type|image)|twitter:(?:title|description|image|card))["'][^>]*>/gi, '')
      .replace(/<link\b[^>]*\brel=["']canonical["'][^>]*>/gi, '')
    return `<head>${cleanHead}\n${tags.join('\n')}\n</head>`
  })
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    response.statusCode = 405
    return response.end()
  }

  let template
  let slug = ''
  let business = null
  let image = ''
  let status = 404
  try {
    template = await readFile(join(process.cwd(), 'dist', 'index.html'), 'utf8')
    const pathname = new URL(request.url, 'https://www.giromicro.com.br').pathname
    const match = pathname.match(/^\/(?:api\/)?negocio\/([^/]+)\/?$/)
    if (match) {
      try { slug = decodeURIComponent(match[1]).trim() } catch { /* Invalid slug stays unavailable. */ }
    }
    if (slug) {
      // Same public credentials and visibility filters as api/sitemap.js and loadPublicBusiness.
      const supabase = createClient(
        process.env.VITE_SUPABASE_URL,
        process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        { auth: { persistSession: false, autoRefreshToken: false } },
      )
      const signal = AbortSignal.timeout(10000)
      const { data, error } = await supabase.from('businesses')
        .select('id, name, category, story, logo_path')
        .eq('slug', slug)
        .eq('status', 'published')
        .eq('is_suspended', false)
        .eq('is_owner_paused', false)
        .abortSignal(signal)
        .maybeSingle()
      if (error) throw error
      if (data && normalizeSeoText(data.name)) {
        business = data
        status = 200
        image = publicImageUrl(supabase, data.logo_path)
        if (!image) {
          const { data: items } = await supabase.from('business_items')
            .select('image_path')
            .eq('business_id', data.id)
            .order('position', { ascending: true })
            .limit(1)
            .abortSignal(signal)
          image = publicImageUrl(supabase, items?.[0]?.image_path)
        }
      }
    }
  } catch {
    // An upstream/build failure is retryable, never an indexable Home or a cached 404.
    business = null
    image = ''
    status = 503
    response.setHeader('Retry-After', '60')
  }

  if (status !== 200) response.setHeader('X-Robots-Tag', 'noindex, nofollow')
  response.statusCode = status
  const html = template ? renderHtml(template, business, slug, image)
    : '<!doctype html><html lang="pt-BR"><head><meta name="robots" content="noindex, nofollow"><title>Página temporariamente indisponível | GiroMicro</title></head><body>Página temporariamente indisponível.</body></html>'
  return response.end(request.method === 'HEAD' ? undefined : html)
}
