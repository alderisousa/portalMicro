const MONEY_PATTERN = /^R\$\s*(?:\d{1,3}(?:\.\d{3})*|\d+),\d{2}$/

export function parseAccesysMoney(value: unknown, field: string): number {
  if (typeof value !== 'string') {
    throw new Error(`SYNC_INVALID_MONEY: ${field} deve ser uma string monetaria.`)
  }

  const normalized = value.replace(/[\u00a0\u202f]/g, ' ').trim()
  if (!MONEY_PATTERN.test(normalized)) {
    throw new Error(`SYNC_INVALID_MONEY: ${field} possui formato invalido.`)
  }

  const parsed = Number(normalized.replace(/^R\$\s*/, '').replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`SYNC_INVALID_MONEY: ${field} possui valor invalido.`)
  }
  return parsed
}
