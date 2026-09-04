import { normalizeAccessKey, normalizeProviderDocument, PurchaseImportError, type NormalizedNfe } from './core.ts'
import type { NfeProvider } from './provider.ts'
import { parseSefazDateTime } from './dateTime.ts'

// Unico host suportado por este provider nesta etapa (Sprint 5B). Outros hostnames
// seguem pelo fluxo generico (StructuredHttpNfeProvider) em index.ts.
export const SEFAZ_SP_HOST = 'www.nfce.fazenda.sp.gov.br'
const SEFAZ_SP_PATH = '/nfceconsultapublica/paginas/consultaqrcode.aspx'
const NFCE_MODEL = '65'
const MAX_RESPONSE_BYTES = 2_000_000

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.endsWith('.local') ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

export function isSefazSpQrUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.hostname.toLowerCase().replace(/\.$/, '') === SEFAZ_SP_HOST
  } catch {
    return false
  }
}

// Extrai e valida a chave a partir do QR Code oficial da SEFAZ-SP. O parametro `p`
// pode ter numero variavel de segmentos separados por "|" (versoes diferentes do
// leiaute do QR Code); somente o primeiro segmento (a chave) importa aqui. A URL
// validada e devolvida integralmente e usada como esta na consulta - nunca reconstruida.
export function parseSefazSpQrUrl(value: string): { url: string; accessKey: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new PurchaseImportError('QR_URL_INVALID', 'URL do QR Code inválida.', 400)
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new PurchaseImportError('QR_URL_NOT_ALLOWED', 'A URL do QR Code deve ser HTTPS e não pode conter credenciais.', 400)
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (isPrivateHostname(hostname) || hostname !== SEFAZ_SP_HOST) {
    throw new PurchaseImportError('QR_URL_NOT_ALLOWED', 'O domínio do QR Code não é permitido.', 400)
  }
  if (url.pathname.toLowerCase() !== SEFAZ_SP_PATH) {
    throw new PurchaseImportError('SEFAZ_PATH_NOT_SUPPORTED', 'O caminho da consulta pública da NFC-e não é suportado.', 400)
  }
  const p = url.searchParams.get('p')
  if (!p) {
    throw new PurchaseImportError('SEFAZ_PARAM_MISSING', 'A URL do QR Code não contém o parâmetro de consulta.', 400)
  }
  const firstSegment = p.split('|')[0] ?? ''
  const candidate = firstSegment.match(/\d{44}/)?.[0]
  if (!candidate) {
    throw new PurchaseImportError('ACCESS_KEY_NOT_FOUND', 'Não foi possível extrair a chave da NF-e desta URL.', 400)
  }
  const accessKey = normalizeAccessKey(candidate)
  if (accessKey.slice(20, 22) !== NFCE_MODEL) {
    throw new PurchaseImportError(
      'SEFAZ_MODEL_UNSUPPORTED',
      'Este provider suporta somente NFC-e modelo 65 da SEFAZ-SP.',
      400,
    )
  }
  return { url: url.toString(), accessKey }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function cleanText(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const text = decodeEntities(raw).replace(/\s+/g, ' ').trim()
  return text || undefined
}

function parseBrazilianAmount(raw: string | undefined): number | undefined {
  const text = cleanText(raw)
  if (!text) return undefined
  const cleaned = text.replace(/[^\d,.-]/g, '')
  if (!cleaned) return undefined
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned
  const value = Number(normalized)
  return Number.isFinite(value) ? value : undefined
}

const normalizeLabel = (label: string) =>
  cleanText(label)?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[:\s]+$/g, '') ?? ''

// Le todos os pares label/valor da secao de totais (id="totalNota" ate id="infos").
// Mapeamento e feito por rotulo reconhecido, nunca por posicao - rotulos nao
// reconhecidos (forma de pagamento, troco, tributos aproximados) sao ignorados.
function parseTotals(html: string): NormalizedNfe['totals'] {
  const totals: NormalizedNfe['totals'] = {}
  const sectionMatch = /id="totalNota"[\s\S]*?(?=id="infos")/.exec(html)
  if (!sectionMatch) return totals
  const section = sectionMatch[0]
  const pairPattern = /<label[^>]*>([\s\S]*?)<\/label>\s*<span[^>]*>([\s\S]*?)<\/span>/g
  let match: RegExpExecArray | null
  while ((match = pairPattern.exec(section))) {
    const label = normalizeLabel(match[1])
    const value = parseBrazilianAmount(match[2])
    if (value === undefined) continue
    if (label === 'valor total r$') totals.productsAmount = value
    else if (label === 'descontos r$') totals.discountAmount = value
    else if (label === 'valor a pagar r$') totals.totalAmount = value
    else if (/frete/.test(label)) totals.freightAmount = value
    else if (/acrescimo|outras despesas|outros valores/.test(label)) totals.otherAmount = value
  }
  return totals
}

interface RawItem {
  lineNumber?: number
  supplierProductCode?: string
  description?: string
  unit?: string
  quantity?: number
  unitPrice?: number
  grossAmount?: number
}

// Cada <tr> da tabela de itens vira uma linha independente, na ordem em que aparece
// na nota. Produtos repetidos (mesma descricao/codigo em linhas fiscais distintas)
// NAO sao deduplicados: cada <tr> gera um item proprio, identificado pelo seu
// lineNumber - a possivel unificacao e responsabilidade da conciliacao, nao da importacao.
//
// O "Vl. Total" de cada linha na consulta publica e o bruto da linha fiscal (antes do
// desconto GLOBAL do documento, que a pagina nao rateia por item) - por isso mapeamos
// para grossAmount, nunca para netAmount. Nao existe liquido individual confiavel nesta
// fonte, entao netAmount fica ausente (calculated_unit_cost, generated a partir de
// net_amount/quantity, permanece null ate haver uma fonte real de liquido por item).
function parseItems(tableHtml: string): RawItem[] {
  const items: RawItem[] = []
  const rowPattern = /<tr([^>]*)>([\s\S]*?)<\/tr>/g
  let rowMatch: RegExpExecArray | null
  let index = 0
  while ((rowMatch = rowPattern.exec(tableHtml))) {
    index += 1
    const [, attrs, row] = rowMatch
    const idMatch = /id="Item\s*\+\s*(\d+)"/.exec(attrs)
    const lineNumber = idMatch ? Number(idMatch[1]) : index

    const description = cleanText(/class="txtTit">([\s\S]*?)<\/span>/.exec(row)?.[1])
    const supplierProductCode = cleanText(
      /class="RCod">\s*\(C[oó]digo:([\s\S]*?)\)/.exec(row)?.[1],
    )
    const quantity = parseBrazilianAmount(
      /class="Rqtd">[\s\S]*?<strong>[^<]*<\/strong>([\s\S]*?)<\/span>/.exec(row)?.[1],
    )
    const unit = cleanText(
      /class="RUN">[\s\S]*?<strong>[^<]*<\/strong>([\s\S]*?)<\/span>/.exec(row)?.[1],
    )
    const unitPrice = parseBrazilianAmount(
      /class="RvlUnit">[\s\S]*?<strong>[^<]*<\/strong>([\s\S]*?)<\/span>/.exec(row)?.[1],
    )
    const grossAmount = parseBrazilianAmount(/class="valor">([\s\S]*?)<\/span>/.exec(row)?.[1])

    items.push({ lineNumber, supplierProductCode, description, unit, quantity, unitPrice, grossAmount })
  }
  return items
}

// Converte o HTML da consulta publica da NFC-e (SEFAZ-SP) para o mesmo formato bruto
// aceito por normalizeProviderDocument, reaproveitando toda a validacao/normalizacao
// ja existente (checagem de chave, itens obrigatorios, limites) sem duplica-la aqui.
export function parseSefazSpNfceHtml(html: string): unknown {
  const tableMatch = /<table[^>]*id="tabResult"[^>]*>([\s\S]*?)<\/table>/.exec(html)
  if (!tableMatch) {
    throw new PurchaseImportError('SEFAZ_NOTE_NOT_FOUND', 'A NFC-e não foi encontrada na consulta pública da SEFAZ-SP.', 502)
  }
  const items = parseItems(tableMatch[1])
  if (items.length === 0) {
    throw new PurchaseImportError('SEFAZ_NOTE_NOT_FOUND', 'A NFC-e não possui itens na consulta pública da SEFAZ-SP.', 502)
  }

  const accessKey = cleanText(/class="chave">([\s\S]*?)<\/span>/.exec(html)?.[1])?.replace(/\D/g, '')
  const supplierName = cleanText(/class="txtTopo">([\s\S]*?)<\/div>/.exec(html)?.[1])
  const supplierDocument = cleanText(/CNPJ:\s*([\d./-]+)/.exec(html)?.[1])

  const noteInfo = /N[uú]mero:\s*<\/strong>\s*(\d+)\s*<strong>\s*S[eé]rie:\s*<\/strong>\s*(\d+)\s*<strong>\s*Emiss[aã]o:\s*<\/strong>\s*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/.exec(html)
  const invoiceNumber = noteInfo?.[1]
  const series = noteInfo?.[2]
  const issuedAt = noteInfo ? parseSefazDateTime(noteInfo[3]) : undefined

  return {
    accessKey,
    invoiceNumber,
    series,
    issuedAt,
    supplier: { name: supplierName, document: supplierDocument },
    totals: parseTotals(html),
    items,
  }
}

export class SefazSpNfceProvider implements NfeProvider {
  constructor(private readonly url: string, private readonly fetcher: typeof fetch = fetch) {}

  async fetchDocument(accessKey: string): Promise<NormalizedNfe> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    try {
      const response = await this.fetcher(this.url, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GiroMicroMarket/1.0; +purchase-import)' },
      })
      if (!response.ok) {
        throw new PurchaseImportError('SEFAZ_UNAVAILABLE', 'Não foi possível consultar a NFC-e na SEFAZ-SP.', 502)
      }
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > MAX_RESPONSE_BYTES) {
        throw new PurchaseImportError('SEFAZ_RESPONSE_TOO_LARGE', 'Resposta da SEFAZ-SP excede o limite permitido.', 502)
      }
      const html = new TextDecoder('utf-8').decode(bytes)
      const raw = parseSefazSpNfceHtml(html)
      return normalizeProviderDocument(raw, accessKey, 'sefaz-sp')
    } catch (error) {
      if (error instanceof PurchaseImportError) throw error
      throw new PurchaseImportError('SEFAZ_UNAVAILABLE', 'Não foi possível consultar a NFC-e na SEFAZ-SP.', 502)
    } finally {
      clearTimeout(timeout)
    }
  }
}
