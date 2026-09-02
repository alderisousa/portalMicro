const TIME_ZONE = 'America/Sao_Paulo'
const DATE_PATTERN = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/

function zonedParts(timestamp: number) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp))
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]))
}

export function parseAccesysDateTime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`SYNC_INVALID_DATETIME: ${field} deve ser uma string.`)
  }
  const match = DATE_PATTERN.exec(value.trim())
  if (!match) throw new Error(`SYNC_INVALID_DATETIME: ${field} possui formato invalido.`)

  const [, day, month, year, hour, minute, second] = match
  const components = [year, month, day, hour, minute, second].map(Number)
  const [y, m, d, h, min, sec] = components
  const naiveUtc = Date.UTC(y, m - 1, d, h, min, sec)
  if (new Date(naiveUtc).toISOString().slice(0, 19) !==
      `${year}-${month}-${day}T${hour}:${minute}:${second}`) {
    throw new Error(`SYNC_INVALID_DATETIME: ${field} possui data inexistente.`)
  }

  let instant = naiveUtc
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(instant)
    const representedAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    )
    instant = naiveUtc - (representedAsUtc - instant)
  }

  const roundTrip = zonedParts(instant)
  if ([roundTrip.year, roundTrip.month, roundTrip.day, roundTrip.hour, roundTrip.minute, roundTrip.second].join('-') !==
      [year, month, day, hour, minute, second].join('-')) {
    throw new Error(`SYNC_INVALID_DATETIME: ${field} e ambiguo ou inexistente em ${TIME_ZONE}.`)
  }

  const localAsUtc = Date.UTC(y, m - 1, d, h, min, sec)
  const offsetMinutes = Math.round((localAsUtc - instant) / 60_000)
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const offset = `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`
}
