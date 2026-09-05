// Parametros centralizados de resolucao de trabalho para OCR local (fotos e
// paginas de PDF escaneado). Existiam numeros espalhados em imagePreprocess.ts e
// pdfDocumentProcessing.ts; unificados aqui (Sprint 5D.2.2) para calibrar num
// unico lugar e evitar resize duplicado/descoordenado entre os pipelines.
export const OCR_IMAGE_LIMITS = {
  // Teto de decodificacao inicial (createImageBitmap) para ARQUIVOS GRANDES. Fotos
  // modernas de celular chegam com resolucao nativa muito alta (50-200MP em alguns
  // aparelhos); decodificar isso por inteiro antes de qualquer reducao e a causa
  // real de erro de memoria observada em teste com celular real (Redmi Note 15,
  // 8GB RAM). Passar resizeWidth ao createImageBitmap permite ao decodificador do
  // navegador reduzir durante a propria decodificacao (JPEG suporta decode
  // escalado nativamente), evitando materializar o bitmap gigante inteiro.
  safeDecodeCapPx: 3000,
  // Abaixo deste tamanho de arquivo, a resolucao nativa raramente e problematica
  // (cobre screenshots e fotos ja comprimidas — "screenshots pequenos funcionam
  // normalmente" foi exatamente o sintoma observado). Pular o teto de decodificacao
  // nesse caso evita ampliar (upscale) uma imagem que ja esta adequada.
  largeFileBytesThreshold: 2 * 1024 * 1024,
  // Resolucao final de trabalho enviada ao OCR (depois do decode inicial acima):
  // lado menor alvo (amplia se for menor) e teto do lado maior (nunca ultrapassa).
  targetShortSide: 1600,
  maxLongSide: 2400,
} as const

// Calcula o fator de escala para levar width/height ao envelope de resolucao de
// trabalho acima, preservando proporcao. Compartilhado por fotos (imagePreprocess)
// e paginas de PDF escaneado (pdfDocumentProcessing) — mesma regra, um so lugar.
export function computeWorkingImageScale(width: number, height: number): number {
  const shortSide = Math.min(width, height)
  const longSide = Math.max(width, height)
  let scale = 1
  if (shortSide < OCR_IMAGE_LIMITS.targetShortSide) scale = OCR_IMAGE_LIMITS.targetShortSide / shortSide
  if (longSide * scale > OCR_IMAGE_LIMITS.maxLongSide) scale = OCR_IMAGE_LIMITS.maxLongSide / longSide
  return scale
}
