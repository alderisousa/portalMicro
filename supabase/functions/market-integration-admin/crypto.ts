export const ENCRYPTION_SECRET_NAME = 'GIROMICRO_INTEGRATION_ENCRYPTION_KEY'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

type PasswordEnvelope = {
  v: 1
  alg: 'A256GCM'
  iv: string
  ciphertext: string
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (value: string) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const importKey = async (keyBase64: string) => {
  let keyBytes: Uint8Array
  try {
    keyBytes = fromBase64(keyBase64.trim())
  } catch {
    throw new Error(`${ENCRYPTION_SECRET_NAME} must be valid Base64`)
  }
  if (keyBytes.byteLength !== 32) {
    throw new Error(`${ENCRYPTION_SECRET_NAME} must decode to exactly 32 bytes`)
  }
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export const encryptPassword = async (password: string, keyBase64: string) => {
  if (!password) throw new Error('Password must not be empty')
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    key,
    encoder.encode(password),
  ))
  const envelope: PasswordEnvelope = {
    v: 1,
    alg: 'A256GCM',
    iv: toBase64(iv),
    ciphertext: toBase64(encrypted),
  }
  return encoder.encode(JSON.stringify(envelope))
}

export const decryptPassword = async (serialized: Uint8Array, keyBase64: string) => {
  let envelope: PasswordEnvelope
  try {
    envelope = JSON.parse(decoder.decode(serialized)) as PasswordEnvelope
    if (
      envelope.v !== 1 || envelope.alg !== 'A256GCM' ||
      typeof envelope.iv !== 'string' || typeof envelope.ciphertext !== 'string'
    ) throw new Error('Invalid envelope')
  } catch {
    throw new Error('Invalid encrypted password envelope')
  }

  const iv = fromBase64(envelope.iv)
  const ciphertext = fromBase64(envelope.ciphertext)
  if (iv.byteLength !== 12 || ciphertext.byteLength < 17) {
    throw new Error('Invalid encrypted password envelope')
  }

  try {
    const key = await importKey(keyBase64)
    const cleartext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      key,
      ciphertext,
    )
    return decoder.decode(cleartext)
  } catch {
    throw new Error('Unable to decrypt integration password')
  }
}

export const bytesToPostgresBytea = (bytes: Uint8Array) =>
  `\\x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`

export const postgresByteaToBytes = (value: string) => {
  if (!/^\\x(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error('Invalid bytea value')
  }
  const hex = value.slice(2)
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  )
}
