import { normalizeProviderDocument, PurchaseImportError, type NormalizedNfe } from './core.ts'

export interface NfeProvider { fetchDocument(accessKey: string): Promise<NormalizedNfe> }

export class StructuredHttpNfeProvider implements NfeProvider {
  constructor(private readonly endpoint: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async fetchDocument(accessKey: string): Promise<NormalizedNfe> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ accessKey }),
      })
      if (!response.ok) throw new PurchaseImportError('NFE_PROVIDER_UNAVAILABLE', 'Não foi possível consultar os dados da NF-e.', 502)
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > 2_000_000) throw new PurchaseImportError('INVALID_PROVIDER_RESPONSE', 'Resposta do provider excede o limite permitido.', 502)
      return normalizeProviderDocument(JSON.parse(new TextDecoder().decode(bytes)), accessKey, new URL(this.endpoint).hostname)
    } catch (error) {
      if (error instanceof PurchaseImportError) throw error
      throw new PurchaseImportError('NFE_PROVIDER_UNAVAILABLE', 'Não foi possível consultar os dados da NF-e.', 502)
    } finally { clearTimeout(timeout) }
  }
}

export function createProviderFromEnvironment(): NfeProvider {
  const endpoint = Deno.env.get('NFE_PROVIDER_URL') ?? ''
  const token = Deno.env.get('NFE_PROVIDER_TOKEN') ?? ''
  let url: URL
  try { url = new URL(endpoint) } catch { throw new PurchaseImportError('NFE_PROVIDER_NOT_CONFIGURED', 'Consulta de NF-e não configurada.', 503) }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const privateHost = hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.local') ||
    /^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  if (url.protocol !== 'https:' || url.username || url.password || privateHost || !token) {
    throw new PurchaseImportError('NFE_PROVIDER_NOT_CONFIGURED', 'Consulta de NF-e não configurada.', 503)
  }
  return new StructuredHttpNfeProvider(url.toString(), token)
}
