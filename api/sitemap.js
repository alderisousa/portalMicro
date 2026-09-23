import { createClient } from '@supabase/supabase-js'

const origin = 'https://www.giromicro.com.br'
const escapeXml = (value) => value.replace(/[<>&"']/g, (character) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
})[character])

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store')
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD')
    response.statusCode = 405
    return response.end()
  }

  try {
    // Same public credentials as the SPA; no user session or privileged key.
    const supabase = createClient(
      process.env.VITE_SUPABASE_URL,
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const urls = [`${origin}/`]
    const signal = AbortSignal.timeout(10000)
    let lastSlug

    while (true) {
      // Keep these filters aligned with loadPublicBusiness in src/App.tsx.
      let query = supabase.from('businesses').select('slug')
        .eq('status', 'published')
        .eq('is_suspended', false)
        .eq('is_owner_paused', false)
        .not('slug', 'is', null)
        .order('slug', { ascending: true })
        .limit(1000)
        .abortSignal(signal)
      if (lastSlug !== undefined) query = query.gt('slug', lastSlug)

      const { data, error } = await query
      if (error) throw error
      if (!data.length) break

      for (const { slug } of data) {
        // The public route trims the decoded slug before looking it up.
        if (!slug || slug.trim() !== slug) continue
        urls.push(`${origin}/negocio/${encodeURIComponent(slug)}`)
      }
      if (urls.length > 50000) throw new Error('Sitemap URL limit exceeded')
      // Continue even if the API caps responses below the requested page size.
      lastSlug = data[data.length - 1].slug
    }

    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
      + urls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`).join('\n')
      + '\n</urlset>\n'
    response.setHeader('Content-Type', 'application/xml; charset=utf-8')
    response.statusCode = 200
    return response.end(request.method === 'HEAD' ? undefined : xml)
  } catch {
    // Do not return a misleading home-only sitemap on upstream failure.
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.statusCode = 503
    return response.end(request.method === 'HEAD' ? undefined : 'Sitemap temporariamente indisponivel.')
  }
}
