// Hash estável (hex) usado como referência idempotente de staging: mesmo
// conteúdo original -> mesma referência -> mesma compra, sem depender de
// nenhum dado que o operador possa corrigir depois durante a revisão.
export async function sha256Hex(input: string | ArrayBuffer): Promise<string> {
  const buffer = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
