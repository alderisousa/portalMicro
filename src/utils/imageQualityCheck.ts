// Verificacoes heuristicas e 100% locais (Canvas API), sem OpenCV nem libs pesadas.
// Os limiares abaixo sao um ponto de partida e precisam ser calibrados com fotos
// reais de notas antes de qualquer bloqueio automatico (por isso o PoC so avisa,
// nunca impede o usuario de continuar). IMPORTANTE: nao foram calibrados com fotos
// reais ainda — screenshots/recortes tendem a ter nitidez e contraste muito acima
// de uma foto de celular e NAO devem ser usados como referencia para validar estes
// numeros. Ajustar apenas depois de reunir fotos reais tiradas pela camera.
const MIN_SHORT_SIDE_PX = 800
const MIN_AVG_LUMINANCE = 60
const MAX_AVG_LUMINANCE = 210
const MIN_SHARPNESS_VARIANCE = 40
const SAMPLE_MAX_DIMENSION = 480

export interface ImageQualityMetrics {
  width: number
  height: number
  avgLuminance: number
  sharpness: number
}

export type ImageQualityWarningCode = 'low_resolution' | 'too_dark' | 'too_bright' | 'possible_blur'

export interface ImageQualityWarning {
  code: ImageQualityWarningCode
  message: string
}

export interface ImageQualityResult {
  metrics: ImageQualityMetrics
  warnings: ImageQualityWarning[]
}

// Exportado para ser reaproveitado pelo pre-processamento de imagem (imagePreprocess.ts),
// que usa a mesma decodificacao antes de preparar a versao enviada ao OCR.
export async function loadDecodableImage(file: File): Promise<{ image: CanvasImageSource; width: number; height: number; cleanup: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file)
      return { image: bitmap, width: bitmap.width, height: bitmap.height, cleanup: () => bitmap.close() }
    } catch {
      // Alguns formatos podem falhar aqui dependendo do navegador; cai no fallback abaixo.
    }
  }
  const url = URL.createObjectURL(file)
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image()
    element.onload = () => resolve(element)
    element.onerror = () => reject(new Error('Não foi possível carregar a imagem selecionada.'))
    element.src = url
  })
  return { image, width: image.naturalWidth, height: image.naturalHeight, cleanup: () => URL.revokeObjectURL(url) }
}

function toGrayscale(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height)
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    gray[index] = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2]
  }
  return gray
}

// Variancia do Laplaciano: proxy classico e barato de nitidez (quanto menor, mais
// desfocada tende a ser a imagem). Nao substitui avaliacao visual humana.
function laplacianVariance(gray: Float32Array, width: number, height: number): number {
  const values: number[] = []
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x
      const value = 4 * gray[index] - gray[index - 1] - gray[index + 1] - gray[index - width] - gray[index + width]
      values.push(value)
    }
  }
  if (!values.length) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
}

export async function checkImageQuality(file: File): Promise<ImageQualityResult> {
  const { image, width, height, cleanup } = await loadDecodableImage(file)
  try {
    const scale = Math.min(1, SAMPLE_MAX_DIMENSION / Math.max(width, height))
    const sampleWidth = Math.max(1, Math.round(width * scale))
    const sampleHeight = Math.max(1, Math.round(height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = sampleWidth
    canvas.height = sampleHeight
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D não suportado neste navegador.')
    context.drawImage(image, 0, 0, sampleWidth, sampleHeight)

    const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight)
    const gray = toGrayscale(data, sampleWidth, sampleHeight)
    const avgLuminance = gray.reduce((sum, value) => sum + value, 0) / gray.length
    const sharpness = laplacianVariance(gray, sampleWidth, sampleHeight)

    const warnings: ImageQualityWarning[] = []
    if (Math.min(width, height) < MIN_SHORT_SIDE_PX) {
      warnings.push({ code: 'low_resolution', message: 'Resolução baixa: a imagem pode ser pequena demais para ler o texto com nitidez.' })
    }
    if (avgLuminance < MIN_AVG_LUMINANCE) {
      warnings.push({ code: 'too_dark', message: 'A imagem pode estar muito escura. Recomendamos refazer a foto com mais luz.' })
    }
    if (avgLuminance > MAX_AVG_LUMINANCE) {
      warnings.push({ code: 'too_bright', message: 'A imagem pode estar estourada de luz ou com reflexo. Recomendamos refazer a foto.' })
    }
    if (sharpness < MIN_SHARPNESS_VARIANCE) {
      warnings.push({ code: 'possible_blur', message: 'A imagem pode estar desfocada. Recomendamos refazer a foto.' })
    }

    return { metrics: { width, height, avgLuminance, sharpness }, warnings }
  } finally {
    cleanup()
  }
}
