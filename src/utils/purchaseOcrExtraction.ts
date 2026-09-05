import {
  emptyHeader, ocrField, pendingField,
  type PurchaseOcrDocument, type PurchaseOcrHeader, type PurchaseOcrItem,
} from '../types/purchaseOcr'
import { recalculateItem } from './purchaseOcrMath'

// Extracao conservadora de dados estruturados a partir do resultado posicional do
// Tesseract (blocks -> paragraphs -> lines -> words, com bbox e confianca por
// palavra). Nao depende so do texto bruto: usa a ordem espacial das palavras numa
// linha (esquerda->direita) para tentar separar codigo/EAN, descricao, quantidade,
// unidade, valor unitario e total. Quando a linha nao tem sinal numerico suficiente
// para dividir com seguranca, o texto bruto e preservado como item PENDENTE_REVISAO
// em vez de descartado ou adivinhado.
//
// Deliberadamente SEM parser especifico de fornecedor (JF Distribuidora/BRF): so
// keywords genericas de rotulo (CNPJ, TOTAL, FRETE, etc.) e padroes numericos
// (dinheiro, quantidade, EAN). Documentos com layout muito diferente vao gerar mais
// itens PENDENTE_REVISAO — esperado nesta etapa.
//
// Extensao futura prevista (nao implementada aqui): usar regioes da pagina (bbox)
// para aplicar um PSM diferente por regiao (cabecalho vs tabela) e consolidar
// multiplas paginas — a separacao entre extractHeaderFromLines/extractItemsFromLines
// abaixo existe justamente para permitir trocar a estrategia de cada parte depois.

export interface OcrBbox { x0: number; y0: number; x1: number; y1: number }
export interface OcrWord { text: string; confidence: number; bbox: OcrBbox }
export interface OcrLine { text: string; confidence: number; bbox: OcrBbox; words: OcrWord[] }

interface RawWord { text: string; confidence: number; bbox: OcrBbox }
interface RawLine { text: string; confidence: number; bbox: OcrBbox; words: RawWord[] }
interface RawParagraph { lines: RawLine[] }
interface RawBlock { paragraphs: RawParagraph[] }

// Achata blocks->paragraphs->lines do Tesseract.js em uma lista unica de linhas,
// ordenada de cima para baixo (bbox.y0) — funciona como uma rede de seguranca para
// PSMs (ex.: Texto esparso) cuja ordem de blocos pode nao seguir a leitura natural.
export function flattenLinesFromBlocks(blocks: RawBlock[] | null | undefined): OcrLine[] {
  if (!blocks) return []
  const lines: OcrLine[] = []
  for (const block of blocks) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        lines.push({
          text: line.text, confidence: line.confidence, bbox: line.bbox,
          words: [...(line.words ?? [])].sort((a, b) => a.bbox.x0 - b.bbox.x0),
        })
      }
    }
  }
  return lines.sort((a, b) => a.bbox.y0 - b.bbox.y0)
}

function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
}

// 2 a 5 casas decimais: alem do formato monetario padrao (2 casas), varias notas
// imprimem "valor unitario" com mais precisao (ex.: 107,81670) — generico para
// qualquer fornecedor, nao especifico de um documento de teste.
const MONEY_RE = /^\d{1,3}(?:\.\d{3})*,\d{2,5}$/
// Ate 4 casas decimais: o schema da NF-e usa 4 casas decimais para quantidade
// (vDec:4), impressa como "1,0000" em muitas DANFEs — generico, nao especifico de
// um documento de teste.
const QUANTITY_RE = /^\d{1,4}(?:[.,]\d{1,4})?$/
const EAN_RE = /^\d{8}$|^\d{12,14}$/
const CNPJ_RE = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/
const DATE_RE = /\d{2}[/\-.]\d{2}[/\-.]\d{2,4}/
// Aceita numero de documento impresso com pontos de milhar (ex.: "000.081.176",
// convencao comum em DANFE) alem do formato simples — generico, nao especifico de
// nenhum fornecedor. O ponto e removido depois, em findFirstDigitGroup. Aceita
// tambem "N." como prefixo (alem de "Nº"/"N°") — a extracao de texto de PDF as
// vezes perde o caractere de ordinal e imprime so um ponto.
const DOCUMENT_NUMBER_RE = /N[ºO°.]\s*[:\-]?\s*(\d{1,3}(?:\.\d{3}){0,3}|\d{1,9})|N[UÚ]MERO\s*[:\-]?\s*(\d{1,3}(?:\.\d{3}){0,3}|\d{1,9})/i
const SERIES_RE = /S[EÉ]RIE\s*[:\-]?\s*(\d{1,3})/i
const KNOWN_UNITS = new Set(['UN', 'UND', 'UNID', 'CX', 'KG', 'G', 'PC', 'PCT', 'FD', 'LT', 'L', 'ML', 'DZ', 'PAR', 'CT', 'CTO', 'SC', 'RL', 'BD', 'BDJ', 'PT', 'FR'])

// Palavras na mesma altura (Y) podem pertencer a caixas/celulas visuais
// diferentes lado a lado (ex.: nome do emitente ao lado da caixa de Nº/Serie, ou
// cada celula do cabecalho da tabela de produtos de um DANFE). Como as palavras
// ja vem ordenadas por X, um espaco horizontal muito maior que o normal entre
// duas palavras costuma marcar essa fronteira. Altura do texto (aproximacao do
// tamanho de fonte) e uma referencia mais estavel que largura de palavra para
// "o que conta como espaco largo", independente do tamanho das palavras em si.
// Multiplicador/piso NAO calibrados com documento real ainda (so com aproximacao
// sintetica) — primeiro ponto a ajustar se o corte ficar errado nos testes reais.
function computeGapThreshold(words: OcrWord[]): number {
  if (!words.length) return 12
  const avgHeight = words.reduce((sum, word) => sum + Math.max(1, word.bbox.y1 - word.bbox.y0), 0) / words.length
  return Math.max(avgHeight * 3, 12)
}

// Segmenta TODAS as palavras de uma linha em clusters (uma celula/caixa visual
// cada), nao so o primeiro — usado para reconstruir as colunas fisicas da tabela
// de produtos (ver detectHeaderColumns) sem depender de reconhecer o rotulo de
// cada uma.
function clusterWordsByGap(words: OcrWord[]): OcrWord[][] {
  if (!words.length) return []
  const threshold = computeGapThreshold(words)
  const clusters: OcrWord[][] = [[words[0]]]
  for (let index = 1; index < words.length; index += 1) {
    const gap = words[index].bbox.x0 - words[index - 1].bbox.x1
    if (gap > threshold) clusters.push([words[index]])
    else clusters[clusters.length - 1].push(words[index])
  }
  return clusters
}

function leadingWordCluster(line: OcrLine): { text: string; words: OcrWord[] } {
  const words = clusterWordsByGap(line.words)[0] ?? []
  return { text: words.map((word) => word.text).join(' ').trim(), words }
}

function parseBrazilianMoney(token: string): number | null {
  if (!MONEY_RE.test(token)) return null
  const normalized = token.replace(/\./g, '').replace(',', '.')
  const value = Number(normalized)
  return Number.isFinite(value) ? value : null
}

function findLabeledMoney(lines: OcrLine[], keywords: string[]): { value: number; confidence: number; lineIndex: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalize(lines[index].text)
    if (!keywords.some((keyword) => normalized.includes(keyword))) continue
    const moneyWords = lines[index].words.filter((word) => MONEY_RE.test(word.text))
    if (!moneyWords.length) continue
    const last = moneyWords[moneyWords.length - 1]
    const value = parseBrazilianMoney(last.text)
    if (value === null) continue
    return { value, confidence: last.confidence, lineIndex: index }
  }
  return null
}

// Extrai o texto que vem DEPOIS de um rotulo livre (ex.: "Fornecedor: ACME LTDA").
function findTextAfterLabel(lines: OcrLine[], keywords: string[]): { text: string; confidence: number; lineIndex: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].text
    const normalized = normalize(raw)
    const keyword = keywords.find((candidate) => normalized.includes(candidate))
    if (!keyword) continue
    const position = normalized.indexOf(keyword)
    const after = raw.slice(position + keyword.length).replace(/^[\s:.\-–]+/, '').trim()
    if (after) return { text: after, lineIndex: index, confidence: lines[index].confidence }
  }
  return null
}

// Extrai um grupo capturado por uma regex de digitos com rotulo (ex.: "Nº 001234"
// ou "Nº 000.081.176" — pontos de milhar sao removidos do valor final).
function findFirstDigitGroup(lines: OcrLine[], regex: RegExp): { value: string; confidence: number; lineIndex: number } | null {
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].text.match(regex)
    const value = match?.[1] ?? match?.[2]
    if (value) return { value: value.replace(/\./g, ''), confidence: lines[index].confidence, lineIndex: index }
  }
  return null
}

export function extractHeaderFromLines(lines: OcrLine[]): { header: PurchaseOcrHeader; consumedLineIndexes: Set<number> } {
  const header = emptyHeader()
  const consumed = new Set<number>()

  // CNPJ: padrao muito distintivo (14 digitos em formato fixo), procurado em
  // qualquer linha, nao so em linhas rotuladas.
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].text.match(CNPJ_RE)
    if (match) {
      header.supplierCnpj = ocrField(match[0], lines[index].confidence)
      consumed.add(index)
      break
    }
  }

  // Chave de acesso: 44 digitos consecutivos. A chave costuma ser impressa espacada
  // em grupos de 4 (ou com traco) DENTRO de uma unica linha — por isso a busca e
  // feita removendo separadores linha a linha (nao substituindo por espaco, que
  // manteria os grupos quebrados e nunca bateria 44 digitos seguidos).
  for (let index = 0; index < lines.length; index += 1) {
    const digitsOnly = lines[index].text.replace(/[^\d]/g, '')
    const accessKeyMatch = digitsOnly.match(/\d{44}/)
    if (accessKeyMatch) {
      header.accessKey = ocrField(accessKeyMatch[0], lines[index].confidence)
      consumed.add(index)
      break
    }
  }

  const documentNumberMatch = findFirstDigitGroup(lines, DOCUMENT_NUMBER_RE)
  if (documentNumberMatch) {
    header.documentNumber = ocrField(documentNumberMatch.value, documentNumberMatch.confidence)
    consumed.add(documentNumberMatch.lineIndex)
  }

  const seriesMatch = findFirstDigitGroup(lines, SERIES_RE)
  if (seriesMatch) {
    header.series = ocrField(seriesMatch.value, seriesMatch.confidence)
    consumed.add(seriesMatch.lineIndex)
  }

  const emissionLine = lines.find((line) => normalize(line.text).includes('EMISS') && DATE_RE.test(line.text))
  const dateMatch = (emissionLine?.text.match(DATE_RE) ?? lines.map((line) => line.text.match(DATE_RE)).find(Boolean))
  if (dateMatch) {
    const ownerLine = emissionLine ?? lines.find((line) => line.text.includes(dateMatch[0]))
    header.issueDate = ocrField(dateMatch[0], ownerLine?.confidence ?? null)
    if (ownerLine) consumed.add(lines.indexOf(ownerLine))
  }

  const supplierMatch = findTextAfterLabel(lines, ['FORNECEDOR', 'RAZAO SOCIAL', 'EMITENTE'])
  if (supplierMatch) {
    header.supplierName = ocrField(supplierMatch.text, supplierMatch.confidence)
    consumed.add(supplierMatch.lineIndex)
  } else if (lines.length) {
    // Fallback conservador: muitos cupons trazem o nome do fornecedor na primeira
    // linha, sem rotulo — so usamos se tiver texto (nao so numeros). So o cluster
    // de palavras a esquerda (ate o primeiro espaco largo) entra, para nao
    // misturar com uma caixa vizinha na mesma altura (ver leadingWordCluster).
    const cluster = leadingWordCluster(lines[0])
    if (/[a-zA-Z]{3,}/.test(cluster.text)) {
      header.supplierName = ocrField(cluster.text, avgConfidence(cluster.words))
      consumed.add(0)
    }
  }

  const productsTotal = findLabeledMoney(lines, ['TOTAL DOS PRODUTOS', 'VALOR DOS PRODUTOS', 'TOTAL PRODUTOS'])
  if (productsTotal) { header.productsTotal = ocrField(productsTotal.value, productsTotal.confidence); consumed.add(productsTotal.lineIndex) }

  const discount = findLabeledMoney(lines, ['DESCONTO'])
  if (discount) { header.discount = ocrField(discount.value, discount.confidence); consumed.add(discount.lineIndex) }

  const freight = findLabeledMoney(lines, ['FRETE'])
  if (freight) { header.freight = ocrField(freight.value, freight.confidence); consumed.add(freight.lineIndex) }

  const otherExpenses = findLabeledMoney(lines, ['OUTRAS DESPESAS', 'DESPESAS ACESSORIAS'])
  if (otherExpenses) { header.otherExpenses = ocrField(otherExpenses.value, otherExpenses.confidence); consumed.add(otherExpenses.lineIndex) }

  const invoiceTotal = findLabeledMoney(lines, ['TOTAL DA NOTA', 'VALOR TOTAL DA NOTA', 'VALOR A PAGAR', 'TOTAL GERAL'])
  if (invoiceTotal) { header.invoiceTotal = ocrField(invoiceTotal.value, invoiceTotal.confidence); consumed.add(invoiceTotal.lineIndex) }

  return { header, consumedLineIndexes: consumed }
}

// Tenta dividir UMA linha em campos de item, olhando as palavras em ordem
// esquerda->direita. So "assume" a divisao quando encontra, no minimo, quantidade
// E total da linha; caso contrario devolve null e a linha vira item PENDENTE_REVISAO
// preservando o texto bruto (ver extractItemsFromLines).
function trySplitItemLine(line: OcrLine): PurchaseOcrItem | null {
  const words = line.words
  const moneyIndexes = words.reduce<number[]>((acc, word, index) => (MONEY_RE.test(word.text) ? [...acc, index] : acc), [])
  if (!moneyIndexes.length) return null

  const lineTotalIndex = moneyIndexes[moneyIndexes.length - 1]
  const unitPriceIndex = moneyIndexes.length >= 2 ? moneyIndexes[moneyIndexes.length - 2] : null
  const moneyRegionStart = unitPriceIndex ?? lineTotalIndex

  let quantityIndex: number | null = null
  for (let index = moneyRegionStart - 1; index >= 0; index -= 1) {
    if (QUANTITY_RE.test(words[index].text) && !MONEY_RE.test(words[index].text)) { quantityIndex = index; break }
  }
  if (quantityIndex === null) return null // sem quantidade identificada, nao ha divisao segura

  let unitIndex: number | null = null
  for (let index = quantityIndex + 1; index < moneyRegionStart; index += 1) {
    if (KNOWN_UNITS.has(words[index].text.toUpperCase().replace(/[.,]/g, ''))) { unitIndex = index; break }
  }

  let barcodeIndex: number | null = null
  let supplierCodeIndex: number | null = null
  if (words.length && EAN_RE.test(words[0].text)) barcodeIndex = 0
  else if (quantityIndex !== 0 && words.length > 1 && /^[A-Za-z0-9]{1,8}$/.test(words[0].text) && !MONEY_RE.test(words[0].text)) {
    supplierCodeIndex = 0
  }

  const consumedIndexes = new Set<number>([lineTotalIndex, quantityIndex])
  if (unitPriceIndex !== null) consumedIndexes.add(unitPriceIndex)
  if (unitIndex !== null) consumedIndexes.add(unitIndex)
  if (barcodeIndex !== null) consumedIndexes.add(barcodeIndex)
  if (supplierCodeIndex !== null) consumedIndexes.add(supplierCodeIndex)

  const descriptionWords = words.filter((_, index) => !consumedIndexes.has(index))
  const descriptionText = descriptionWords.map((word) => word.text).join(' ').trim()
  const descriptionConfidence = descriptionWords.length
    ? descriptionWords.reduce((sum, word) => sum + word.confidence, 0) / descriptionWords.length
    : null

  const quantityValue = Number(words[quantityIndex].text.replace(',', '.'))
  const item: PurchaseOcrItem = {
    id: crypto.randomUUID(),
    supplierCode: supplierCodeIndex !== null ? ocrField(words[supplierCodeIndex].text, words[supplierCodeIndex].confidence) : pendingField(),
    barcode: barcodeIndex !== null ? ocrField(words[barcodeIndex].text, words[barcodeIndex].confidence) : pendingField(),
    description: descriptionText ? ocrField(descriptionText, descriptionConfidence) : pendingField(),
    quantity: ocrField(quantityValue, words[quantityIndex].confidence),
    unit: unitIndex !== null ? ocrField(words[unitIndex].text.toUpperCase(), words[unitIndex].confidence) : pendingField(),
    unitPrice: unitPriceIndex !== null ? ocrField(parseBrazilianMoney(words[unitPriceIndex].text) ?? 0, words[unitPriceIndex].confidence) : pendingField(),
    lineTotal: ocrField(parseBrazilianMoney(words[lineTotalIndex].text) ?? 0, words[lineTotalIndex].confidence),
    lineStatus: 'incomplete',
    computedTotalCents: null,
    rawSourceText: line.text,
  }
  return recalculateItem(item)
}

export function extractItemsFromLines(lines: OcrLine[], consumedLineIndexes: Set<number>): PurchaseOcrItem[] {
  const items: PurchaseOcrItem[] = []
  lines.forEach((line, index) => {
    if (consumedLineIndexes.has(index)) return
    const hasNumericSignal = line.words.some((word) => MONEY_RE.test(word.text) || EAN_RE.test(word.text))
    if (!hasNumericSignal) return // linha sem nenhum sinal financeiro/EAN: provavelmente nao e um item

    const split = trySplitItemLine(line)
    if (split) { items.push(split); return }

    // Sinal numerico existe mas nao deu para dividir com seguranca: preserva a
    // linha inteira como item pendente, sem adivinhar nenhum campo.
    items.push(recalculateItem({
      id: crypto.randomUUID(),
      supplierCode: pendingField(), barcode: pendingField(),
      description: ocrField(line.text.trim(), line.confidence),
      quantity: pendingField(), unit: pendingField(), unitPrice: pendingField(), lineTotal: pendingField(),
      lineStatus: 'incomplete', computedTotalCents: null, rawSourceText: line.text,
    }))
  })
  return items
}

// Ponto de entrada comum: qualquer origem (Tesseract via blocks, ou PDF via
// linesFromPdfTextItems abaixo) que consiga produzir OcrLine[] usa exatamente o
// mesmo cabecalho/reconstrucao de itens — nenhuma regra de CNPJ/chave/numero/data/
// totais e duplicada entre as origens.
export function extractPurchaseOcrDocumentFromLines(lines: OcrLine[]): PurchaseOcrDocument {
  const { header, consumedLineIndexes } = extractHeaderFromLines(lines)
  const items = extractItemsFromLines(lines, consumedLineIndexes)
  return { header, items }
}

export function extractPurchaseOcrDocument(blocks: RawBlock[] | null | undefined): PurchaseOcrDocument {
  return extractPurchaseOcrDocumentFromLines(flattenLinesFromBlocks(blocks))
}

// Adaptador PDF -> OcrLine[] (Sprint 5D.2.1). O texto extraido de um PDF ja vem
// correto caractere a caractere (sem incerteza de reconhecimento), mas NAO vem
// agrupado em linhas nem em palavras isoladas como o Tesseract — cada item de
// texto do PDF.js pode conter uma frase inteira num unico "transform"/bbox. Por
// isso: (1) cada item e recortado em sub-palavras por espaco, distribuindo a
// largura proporcionalmente ao numero de caracteres; (2) as sub-palavras sao
// agrupadas em linhas por proximidade vertical. O resultado alimenta o MESMO
// extractPurchaseOcrDocumentFromLines usado para OCR de imagem.
export interface PdfTextItemLike { str: string; transform: number[]; width: number; height: number }

function splitPdfItemIntoWords(item: PdfTextItemLike): OcrWord[] {
  const raw = item.str
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (!tokens.length) return []
  const x0 = item.transform[4]
  // PDF cresce para cima; invertendo o sinal mantemos a mesma convencao de
  // "y maior = mais para baixo" ja usada pelas linhas vindas do Tesseract.
  const y0 = -item.transform[5]
  const y1 = y0 + item.height
  if (tokens.length === 1) return [{ text: tokens[0], confidence: 100, bbox: { x0, y0, x1: x0 + item.width, y1 } }]

  const totalChars = raw.length || 1
  let searchFrom = 0
  const words: OcrWord[] = []
  for (const token of tokens) {
    const tokenStart = raw.indexOf(token, searchFrom)
    const startChars = tokenStart >= 0 ? tokenStart : searchFrom
    const endChars = startChars + token.length
    searchFrom = endChars
    words.push({
      text: token, confidence: 100,
      bbox: { x0: x0 + (startChars / totalChars) * item.width, y0, x1: x0 + (endChars / totalChars) * item.width, y1 },
    })
  }
  return words
}

export function linesFromPdfTextItems(items: PdfTextItemLike[]): OcrLine[] {
  const words = items.filter((item) => item.str.trim().length > 0).flatMap(splitPdfItemIntoWords)
  if (!words.length) return []

  const sortedByY = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0)
  const LINE_TOLERANCE = 3
  const grouped: OcrWord[][] = []
  for (const word of sortedByY) {
    const currentLine = grouped[grouped.length - 1]
    const last = currentLine?.[currentLine.length - 1]
    if (currentLine && last && Math.abs(word.bbox.y0 - last.bbox.y0) <= LINE_TOLERANCE) currentLine.push(word)
    else grouped.push([word])
  }

  return grouped.map((lineWords) => {
    const sorted = [...lineWords].sort((a, b) => a.bbox.x0 - b.bbox.x0)
    return {
      text: sorted.map((word) => word.text).join(' '),
      confidence: 100,
      bbox: {
        x0: Math.min(...sorted.map((word) => word.bbox.x0)), y0: Math.min(...sorted.map((word) => word.bbox.y0)),
        x1: Math.max(...sorted.map((word) => word.bbox.x1)), y1: Math.max(...sorted.map((word) => word.bbox.y1)),
      },
      words: sorted,
    }
  })
}

// ============================================================================
// Parser ESPACIAL de PDF por regioes/colunas (Sprint 5D.2.2).
//
// O teste real com a NF AKIMERCADO.pdf mostrou que so ordenar por Y/X e rodar o
// parser generico de linhas NAO basta para uma DANFE: blocos de cabecalho,
// impostos, transporte e rodape viravam itens falsos, e dentro da tabela de
// produtos os valores saiam deslocados (o parser generico assume "quantidade +
// ate 2 valores monetarios no fim da linha", mas uma linha de DANFE tem muito
// mais colunas numericas — NCM, CST, CFOP, BC ICMS, %ICMS, etc. — entre a
// descricao e o total).
//
// Estrategia (generica, sem hardcode de fornecedor):
// 1) Localizar ancoras de secao conhecidas de qualquer DANFE (rotulos fixos do
//    layout oficial, nao do fornecedor) para delimitar onde comeca e termina a
//    regiao de PRODUTOS/SERVICOS — so essa regiao pode virar item.
// 2) Dentro da regiao, localizar a linha de cabecalho da tabela (rotulos como
//    CODIGO/DESCRICAO/QTDE/VLR UNIT/VLR TOTAL) e usar a posicao X de cada rotulo
//    para construir faixas de coluna dinamicas.
// 3) Atribuir cada palavra de cada linha da regiao a coluna cuja faixa X contem
//    o centro da palavra; celula sem coluna mapeada e ignorada (NCM/CST/CFOP/
//    impostos) em vez de vazar para a coluna vizinha.
// 4) Cabecalho da NF (fornecedor/CNPJ): a busca de CNPJ/nome e restrita a regiao
//    ACIMA de "NATUREZA DA OPERACAO"/"DESTINATARIO" (bloco do emitente), evitando
//    pegar CNPJ do destinatario/protocolo ou nome de rotulo de campo.
//
// Fallback em cascata (nunca falha "silenciosamente" para o documento inteiro
// sem necessidade, mas tambem nunca deixa de extrair algo utilizavel):
//   sem ancora de PRODUTOS/SERVICOS  -> parser generico no documento inteiro
//   ancora achada, sem cabecalho de colunas -> parser generico, SO na regiao
//   cabecalho de colunas reconhecido -> reconstrucao por coluna (a melhor via)

const NATUREZA_ANCHOR_PATTERNS = ['NATUREZA DA OPERACAO']
const DESTINATARIO_ANCHOR_PATTERNS = ['DESTINATARIO', 'REMETENTE']
// Reservado para refinamento futuro (ex.: excluir CNPJ do transportador da busca
// de fornecedor); nao delimita nenhuma regiao usada nesta versao.
const TRANSPORTADOR_ANCHOR_PATTERNS = ['TRANSPORTADOR', 'VOLUMES TRANSPORTADOS']
const PRODUCTS_ANCHOR_PATTERNS = ['DADOS DO PRODUTO', 'PRODUTOS E SERVICOS', 'PRODUTO/SERVICO', 'PRODUTOS/SERVICOS', 'PRODUTOS / SERVICOS']
const ISSQN_ANCHOR_PATTERNS = ['CALCULO DO ISSQN']
const DADOS_ADICIONAIS_ANCHOR_PATTERNS = ['DADOS ADICIONAIS']
// Rede de seguranca: mesmo dentro da regiao de PRODUTOS/SERVICOS, uma linha que
// bata com um destes rotulos de totais/descontos nunca vira item — cobre o caso
// de a ancora de FIM da regiao (CALCULO DO ISSQN/DADOS ADICIONAIS) nao aparecer
// ou nao ser encontrada num layout de DANFE especifico.
const TOTALS_LINE_GUARD_RE = /TOTAL DOS PRODUTOS|VALOR DOS PRODUTOS|TOTAL DA NOTA|VALOR TOTAL DA NOTA|TOTAL GERAL|VALOR DO FRETE|VALOR DO DESCONTO|OUTRAS DESPESAS|VALOR APROXIMADO DOS TRIBUTOS/

// Rotulos de campo comuns em qualquer DANFE — usados so para reconhecer quando o
// "nome do fornecedor" capturado pelo fallback generico na verdade pegou um
// rotulo de campo (ex.: "CNPJ/CPF DATA DA EMISSAO", erro observado no teste real)
// em vez do nome da empresa.
const HEADER_CAPTION_RE = /^(CNPJ|CPF|INSCRICAO|ENDERECO|MUNICIPIO|BAIRRO|CEP|FONE|FAX|UF\b|DATA|EMISSAO|SAIDA|ENTRADA|NATUREZA|OPERACAO|DANFE|DOCUMENTO|AUXILIAR|NOTA|FISCAL|ELETRONICA|SERIE|FOLHA|CHAVE|ACESSO|PROTOCOLO|AUTORIZACAO|USO|CONSUMIDOR|CALCULO|IMPOSTO)/

function findAnchorLineIndex(lines: OcrLine[], patterns: string[], fromIndex = 0): number {
  for (let index = fromIndex; index < lines.length; index += 1) {
    const normalized = normalize(lines[index].text)
    if (patterns.some((pattern) => normalized.includes(pattern))) return index
  }
  return -1
}

type PdfColumnKey = 'code' | 'description' | 'unit' | 'quantity' | 'unitPrice' | 'lineTotal'

// CORRECAO 5D.2.2.1 (2ª rodada, apos teste real com a NF AKIMERCADO.pdf): a
// primeira tentativa desta sprint agrupava a linha de cabecalho por LACUNA
// horizontal (gap) antes de classificar. Colunas fiscais de uma DANFE real (NCM/
// CST/CFOP/BC ICMS/Vlr ICMS/Vlr IPI/%ICMS/%IPI) sao ESTREITAS e ficam proximas
// umas das outras — um limiar de lacuna genérico o bastante para separar textos
// livres (nome de fornecedor, etc.) acaba FUNDINDO varias colunas fiscais
// vizinhas em um so cluster, undercounting fronteiras e deixando CFOP/percentual
// vazarem para quantidade/valor unitario (o mesmo sintoma do bug original, so que
// por uma causa diferente da hipotese inicial).
//
// Correcao definitiva: NAO depender de nenhuma distancia/lacuna para a linha de
// cabecalho. Percorre palavra a palavra (ja ordenadas por X); em cada posicao
// tenta casar 1 ou 2 palavras contra os rotulos conhecidos (uteis OU fiscais/
// ignorados); se casar, essas 1-2 palavras viram UMA fronteira; se NAO casar,
// a palavra sozinha ainda vira sua PROPRIA fronteira (papel desconhecido). Ou
// seja: toda palavra do cabecalho sempre gera alguma fronteira — nunca mais fica
// invisivel e nunca funde com a vizinha so por estarem proximas.
type PdfColumnRole = PdfColumnKey | 'ignored'

// Rotulos ignorados DE PROPOSITO (colunas fiscais que nao usamos, mas que
// PRECISAM ser reconhecidas como fronteira para nao contaminar as colunas que
// usamos). Variantes comuns de DANFE incluidas (ex.: "O/CST", "NCM/SH").
const IGNORED_COLUMN_PATTERNS: RegExp[] = [
  /NCM/, /\bO\/?CST\b/, /\bCST\b/, /CFOP/, /\bBC\s*ICMS\b/,
  /\bV\.?L?R?\.?\s*ICMS\b/, /\bV\.?L?R?\.?\s*IPI\b/, /%\s*ICM/, /%\s*IPI/,
]

const ROLE_COLUMN_PATTERNS: Array<{ role: PdfColumnKey; patterns: RegExp[] }> = [
  { role: 'code', patterns: [/^C[OÓ]D/] },
  { role: 'description', patterns: [/^DESCRI/, /^PRODUTO/] },
  { role: 'unit', patterns: [/^UN\.?$/, /^UNID/] },
  { role: 'quantity', patterns: [/^QTDE?\.?$/, /^QUANT/] },
  { role: 'unitPrice', patterns: [/^V\.?L?R?\.?\s*UNIT/, /^VALOR\s*UNIT/] },
  { role: 'lineTotal', patterns: [/^V\.?L?R?\.?\s*TOTAL/, /^VALOR\s*TOTAL/] },
]

// Tenta casar 1 palavra ou o par (palavra, proxima palavra) na posicao `index`
// contra os rotulos conhecidos (uteis ou fiscais/ignorados).
function matchHeaderLabelAt(words: OcrWord[], index: number): { role: PdfColumnRole; span: number } | null {
  const single = normalize(words[index].text)
  for (const def of ROLE_COLUMN_PATTERNS) {
    if (def.patterns.some((pattern) => pattern.test(single))) return { role: def.role, span: 1 }
  }
  if (IGNORED_COLUMN_PATTERNS.some((pattern) => pattern.test(single))) return { role: 'ignored', span: 1 }

  if (index + 1 < words.length) {
    const pair = normalize(`${words[index].text} ${words[index + 1].text}`)
    for (const def of ROLE_COLUMN_PATTERNS) {
      if (def.patterns.some((pattern) => pattern.test(pair))) return { role: def.role, span: 2 }
    }
    if (IGNORED_COLUMN_PATTERNS.some((pattern) => pattern.test(pair))) return { role: 'ignored', span: 2 }
  }
  return null
}

interface HeaderColumn { role: PdfColumnRole | null; x0: number; x1: number }

// So considera a linha um cabecalho de tabela quando reconhece pelo menos 3 dos
// papeis que realmente usamos (code/description/unit/quantity/unitPrice/
// lineTotal). As fronteiras cobrem TODAS as palavras da linha (mapeadas,
// ignoradas ou desconhecidas) — nenhuma fica de fora.
function detectHeaderColumns(line: OcrLine): HeaderColumn[] | null {
  const words = line.words
  const raw: Array<{ role: PdfColumnRole | null; x0: number }> = []
  let index = 0
  while (index < words.length) {
    const match = matchHeaderLabelAt(words, index)
    if (match) { raw.push({ role: match.role, x0: words[index].bbox.x0 }); index += match.span }
    else { raw.push({ role: null, x0: words[index].bbox.x0 }); index += 1 }
  }
  if (raw.length < 3) return null

  const usableRoleCount = raw.filter((column) => column.role && column.role !== 'ignored').length
  if (usableRoleCount < 3) return null

  // `raw` ja esta em ordem crescente de X (mesma ordem de line.words).
  return raw.map((column, i) => ({
    role: column.role,
    x0: i === 0 ? -Infinity : (raw[i - 1].x0 + column.x0) / 2,
    x1: i === raw.length - 1 ? Infinity : (column.x0 + raw[i + 1].x0) / 2,
  }))
}

// Cada TextItem da linha de dados cai PRIMEIRO numa coluna fisica (pelas
// fronteiras acima); SO DEPOIS o conteudo de colunas com papel util e mapeado
// para os campos de PurchaseOcrItem. Coluna ignorada/desconhecida e descartada
// conscientemente — nunca vira fallback para code/quantity/unitPrice/lineTotal.
function assignWordsToColumns(line: OcrLine, columns: HeaderColumn[]): Partial<Record<PdfColumnKey, OcrWord[]>> {
  const result: Partial<Record<PdfColumnKey, OcrWord[]>> = {}
  for (const word of line.words) {
    const center = (word.bbox.x0 + word.bbox.x1) / 2
    const column = columns.find((candidate) => center >= candidate.x0 && center < candidate.x1)
    if (!column?.role || column.role === 'ignored') continue
    const role = column.role
    result[role] = [...(result[role] ?? []), word]
  }
  return result
}

function avgConfidence(words: OcrWord[]): number | null {
  return words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : null
}

// Constroi um item a partir das palavras ja atribuidas as colunas de UMA linha da
// regiao de produtos. Celula sem palavras fica PENDENTE_REVISAO — nunca desloca
// um valor para o campo errado so para preencher algo.
function buildItemFromColumnWords(columns: Partial<Record<PdfColumnKey, OcrWord[]>>, rawText: string): PurchaseOcrItem {
  const codeWords = columns.code ?? []
  const codeText = codeWords.map((word) => word.text).join(' ').trim()
  const codeDigitsOnly = codeText.replace(/\s+/g, '')
  const isEan = codeDigitsOnly.length > 0 && EAN_RE.test(codeDigitsOnly)

  const descriptionText = (columns.description ?? []).map((word) => word.text).join(' ').trim()
  const quantityText = (columns.quantity ?? []).map((word) => word.text).join('').trim()
  const quantityValue = quantityText && QUANTITY_RE.test(quantityText) ? Number(quantityText.replace(',', '.')) : null
  const unitText = (columns.unit ?? []).map((word) => word.text).join(' ').trim().toUpperCase()
  const unitPriceValue = parseBrazilianMoney((columns.unitPrice ?? []).map((word) => word.text).join('').trim())
  const lineTotalValue = parseBrazilianMoney((columns.lineTotal ?? []).map((word) => word.text).join('').trim())

  const item: PurchaseOcrItem = {
    id: crypto.randomUUID(),
    supplierCode: codeText && !isEan ? ocrField(codeText, avgConfidence(codeWords)) : pendingField(),
    barcode: isEan ? ocrField(codeDigitsOnly, avgConfidence(codeWords)) : pendingField(),
    description: descriptionText ? ocrField(descriptionText, avgConfidence(columns.description ?? [])) : pendingField(),
    quantity: quantityValue !== null ? ocrField(quantityValue, avgConfidence(columns.quantity ?? [])) : pendingField(),
    unit: unitText ? ocrField(unitText, avgConfidence(columns.unit ?? [])) : pendingField(),
    unitPrice: unitPriceValue !== null ? ocrField(unitPriceValue, avgConfidence(columns.unitPrice ?? [])) : pendingField(),
    lineTotal: lineTotalValue !== null ? ocrField(lineTotalValue, avgConfidence(columns.lineTotal ?? [])) : pendingField(),
    lineStatus: 'incomplete',
    computedTotalCents: null,
    rawSourceText: rawText,
  }
  return recalculateItem(item)
}

interface ProductsRegion { itemsStart: number; end: number; columns: HeaderColumn[] | null }

// Delimita [inicio, fim) da regiao de PRODUTOS/SERVICOS. O fim e a primeira
// ancora de CALCULO DO ISSQN/DADOS ADICIONAIS encontrada depois do inicio, ou o
// fim do documento (pagina) se nenhuma existir.
function findProductsRegion(lines: OcrLine[]): ProductsRegion | null {
  const start = findAnchorLineIndex(lines, PRODUCTS_ANCHOR_PATTERNS)
  if (start === -1) return null

  let end = lines.length
  for (const patterns of [ISSQN_ANCHOR_PATTERNS, DADOS_ADICIONAIS_ANCHOR_PATTERNS]) {
    const found = findAnchorLineIndex(lines, patterns, start + 1)
    if (found !== -1 && found < end) end = found
  }

  let itemsStart = start + 1
  let columns: HeaderColumn[] | null = null
  for (let index = start + 1; index < Math.min(start + 6, end); index += 1) {
    const detected = detectHeaderColumns(lines[index])
    if (detected) { columns = detected; itemsStart = index + 1; break }
  }
  return { itemsStart, end, columns }
}

// Cabecalho da NF com camada espacial: CNPJ/nome do fornecedor sao buscados so
// no bloco do emitente (acima de "NATUREZA DA OPERACAO"/"DESTINATARIO"), evitando
// pegar CNPJ do destinatario/protocolo. Numero/serie/data/chave/totais continuam
// vindo do extrator generico (padroes ja distintivos o bastante por si so).
function extractPdfHeaderFromLines(lines: OcrLine[]): PurchaseOcrHeader {
  const naturezaIndex = findAnchorLineIndex(lines, NATUREZA_ANCHOR_PATTERNS)
  const destinatarioIndex = findAnchorLineIndex(lines, DESTINATARIO_ANCHOR_PATTERNS)
  const emitterEnd = naturezaIndex !== -1 ? naturezaIndex : destinatarioIndex !== -1 ? destinatarioIndex : Math.min(lines.length, 15)
  const emitterLines = lines.slice(0, Math.max(emitterEnd, 1))

  const { header: emitterHeader } = extractHeaderFromLines(emitterLines)
  const { header: fullHeader } = extractHeaderFromLines(lines)

  let supplierName = emitterHeader.supplierName
  if (supplierName.value && HEADER_CAPTION_RE.test(normalize(supplierName.value))) {
    // O fallback generico pegou um rotulo de campo (ex.: "CNPJ/CPF DATA DA
    // EMISSAO") em vez do nome da empresa — procura a proxima linha cujo cluster
    // de palavras a esquerda (ver leadingWordCluster) tenha texto substancial e
    // nao seja, ele proprio, outro rotulo conhecido.
    supplierName = pendingField()
    for (const line of emitterLines) {
      const cluster = leadingWordCluster(line)
      if (/[a-zA-Z]{4,}/.test(cluster.text) && !HEADER_CAPTION_RE.test(normalize(cluster.text))) {
        supplierName = ocrField(cluster.text, avgConfidence(cluster.words))
        break
      }
    }
  }

  return { ...fullHeader, supplierCnpj: emitterHeader.supplierCnpj, supplierName }
}

export function extractPurchaseOcrDocumentFromPdfTextItems(pdfItems: PdfTextItemLike[]): PurchaseOcrDocument {
  const lines = linesFromPdfTextItems(pdfItems)
  if (!lines.length) return { header: emptyHeader(), items: [] }

  const header = extractPdfHeaderFromLines(lines)
  const region = findProductsRegion(lines)

  // Sem ancora de PRODUTOS/SERVICOS: nao ha como delimitar a tabela com
  // seguranca — fallback total ao comportamento generico anterior (pode gerar
  // mais ruido, mas evita nao extrair item nenhum de um documento atipico).
  if (!region) return { header, items: extractItemsFromLines(lines, new Set()) }

  const regionLines = lines.slice(region.itemsStart, region.end)

  // Ancora achada mas cabecalho de colunas nao reconhecido: ainda assim restringe
  // a busca generica a regiao de produtos — nunca ao documento inteiro. Isso ja
  // resolve a falha mais grave observada (cabecalho/impostos/transporte/rodape
  // virando item).
  if (!region.columns) return { header, items: extractItemsFromLines(regionLines, new Set()) }

  const items: PurchaseOcrItem[] = []
  for (const line of regionLines) {
    // Rede de seguranca extra: mesmo dentro da regiao, uma linha de total/
    // desconto/frete nao deve virar item (caso a ancora de fim da regiao nao
    // tenha sido encontrada com precisao neste documento).
    if (TOTALS_LINE_GUARD_RE.test(normalize(line.text))) continue

    const columns = assignWordsToColumns(line, region.columns)
    const descriptionText = (columns.description ?? []).map((word) => word.text).join(' ').trim()
    const hasLetterDescription = /[a-zA-Z]{2,}/.test(descriptionText)
    const hasCode = Boolean(columns.code?.length)
    const hasNumericData = Boolean(columns.quantity?.length || columns.unitPrice?.length || columns.lineTotal?.length)

    // Linha real de produto precisa de identidade (codigo OU descricao com
    // texto) E de algum dado numerico (quantidade/valor) — sinal isolado demais
    // (so um numero solto, ou so texto) nao vira item por si so.
    if (!hasCode && !hasLetterDescription && !hasNumericData) continue // nada aproveitavel

    const previousItem = items[items.length - 1]
    if (!hasCode && !hasNumericData && hasLetterDescription && previousItem) {
      // Sem codigo/numeros, so texto: provavel continuacao da descricao do item
      // anterior (descricao quebrada em duas linhas) — complementa em vez de
      // criar um item novo.
      const mergedDescription = [previousItem.description.value, descriptionText].filter(Boolean).join(' ').trim()
      previousItem.description = ocrField(mergedDescription, previousItem.description.confidence)
      continue
    }

    items.push(buildItemFromColumnWords(columns, line.text))
  }
  return { header, items }
}
