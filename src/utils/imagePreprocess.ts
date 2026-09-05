import { loadDecodableImage } from './imageQualityCheck'

// Preparo de imagem so para alimentar o Tesseract — NUNCA altera a imagem original
// nem a miniatura mostrada ao usuario (essa continua vindo do arquivo original).
// Mantido deliberadamente leve: sem threshold/binarizacao e sem sharpen, que sao
// as transformacoes com maior risco de criar artefatos numa foto real antes de
// termos exemplos reais para calibrar. So amplia quando a imagem e pequena para o
// OCR, converte para tons de cinza e aplica um alongamento leve de contraste.
const OCR_TARGET_SHORT_SIDE = 1600
const OCR_MAX_LONG_SIDE = 2400
const CONTRAST_CLIP_RATIO = 0.02 // ignora os ~2% de pixels mais escuros/claros ao esticar o contraste

export interface PreparedOcrImage {
  canvas: HTMLCanvasElement
  width: number
  height: number
  scale: number
}

function computeOcrScale(width: number, height: number): number {
  const shortSide = Math.min(width, height)
  const longSide = Math.max(width, height)
  let scale = 1
  if (shortSide < OCR_TARGET_SHORT_SIDE) scale = OCR_TARGET_SHORT_SIDE / shortSide
  if (longSide * scale > OCR_MAX_LONG_SIDE) scale = OCR_MAX_LONG_SIDE / longSide
  return scale
}

// Alongamento de contraste por percentil (nao pelo min/max bruto): evita que um
// canto muito escuro ou um reflexo isolado dominem o ajuste — mais seguro que uma
// equalizacao completa para nao criar artefatos em fotos com iluminacao irregular.
function stretchContrast(data: Uint8ClampedArray, width: number, height: number) {
  const histogram = new Array(256).fill(0)
  const totalPixels = width * height
  for (let index = 0; index < totalPixels; index += 1) histogram[data[index * 4]] += 1

  const clipCount = Math.floor(totalPixels * CONTRAST_CLIP_RATIO)
  let low = 0
  let seen = 0
  for (; low < 255; low += 1) {
    seen += histogram[low]
    if (seen > clipCount) break
  }
  let high = 255
  seen = 0
  for (; high > 0; high -= 1) {
    seen += histogram[high]
    if (seen > clipCount) break
  }
  if (high <= low) return // imagem quase uniforme; nada para esticar com seguranca

  const range = high - low
  for (let index = 0; index < totalPixels; index += 1) {
    const offset = index * 4
    const value = Math.min(255, Math.max(0, Math.round(((data[offset] - low) / range) * 255)))
    data[offset] = value
    data[offset + 1] = value
    data[offset + 2] = value
  }
}

export async function prepareImageForOcr(file: File): Promise<PreparedOcrImage> {
  const { image, width, height, cleanup } = await loadDecodableImage(file)
  try {
    const scale = computeOcrScale(width, height)
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D não suportado neste navegador.')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, 0, 0, targetWidth, targetHeight)

    const imageData = context.getImageData(0, 0, targetWidth, targetHeight)
    const { data } = imageData
    for (let index = 0; index < targetWidth * targetHeight; index += 1) {
      const offset = index * 4
      const gray = Math.round(0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2])
      data[offset] = gray
      data[offset + 1] = gray
      data[offset + 2] = gray
    }
    stretchContrast(data, targetWidth, targetHeight)
    context.putImageData(imageData, 0, 0)

    return { canvas, width: targetWidth, height: targetHeight, scale }
  } finally {
    cleanup()
  }
}
