import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { LOCAL_ENV_ERROR_CODES, LocalEnvError } from '@/lib/local-env/errors'
import {
  decryptValue,
  encryptValue,
  isEncryptedValue,
  keyIdOf,
  parseEncryptedValue,
  type LocalKey,
} from '@/lib/local-env/value-crypto'

function key(environmentId = 'env_1', version = 1): LocalKey {
  const raw = randomBytes(32)
  const keyId = keyIdOf(raw)
  return { environmentId, version, keyId, keyRef: `${version}.${keyId}`, raw }
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (err) {
    return err instanceof LocalEnvError ? err.code : 'not-a-local-env-error'
  }
  return undefined
}

describe('cf:v1 values', () => {
  const k = key()

  it('round-trips any string, including newlines, quotes and unicode', () => {
    for (const value of [
      '',
      'simple',
      'with "quotes" and \'single\'',
      'line1\nline2\r\n',
      'emoji ☃ $HOME `id`',
    ]) {
      expect(decryptValue(encryptValue(value, 'NAME', k), 'NAME', k)).toBe(value)
    }
  })

  it('has the documented shape and only URL-safe characters', () => {
    const value = encryptValue('secret', 'NAME', k)
    expect(value).toMatch(/^cf:v1:1\.[A-Za-z0-9_-]{8}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]+$/)
    expect(isEncryptedValue(value)).toBe(true)
    expect(parseEncryptedValue(value)?.keyRef).toBe(k.keyRef)
  })

  it('uses a fresh nonce for every value', () => {
    expect(encryptValue('same', 'NAME', k)).not.toBe(encryptValue('same', 'NAME', k))
  })

  it('does not decrypt under another variable name', () => {
    const value = encryptValue('secret', 'STRIPE_KEY', k)
    expect(codeOf(() => decryptValue(value, 'OTHER_KEY', k))).toBe(
      LOCAL_ENV_ERROR_CODES.AUTH_FAILED,
    )
  })

  it('does not decrypt for another environment, even with the same key bytes', () => {
    const value = encryptValue('secret', 'NAME', k)
    expect(codeOf(() => decryptValue(value, 'NAME', { ...k, environmentId: 'env_2' }))).toBe(
      LOCAL_ENV_ERROR_CODES.AUTH_FAILED,
    )
  })

  it('refuses a value encrypted under a different key ref', () => {
    const value = encryptValue('secret', 'NAME', k)
    expect(codeOf(() => decryptValue(value, 'NAME', key()))).toBe(LOCAL_ENV_ERROR_CODES.WRONG_KEY)
  })

  it('detects tampering', () => {
    const value = encryptValue('secret', 'NAME', k)
    // Not the last character: its low bits can be padding and change nothing.
    const at = value.length - 6
    const swapped = value.charAt(at) === 'A' ? 'B' : 'A'
    const tampered = `${value.slice(0, at)}${swapped}${value.slice(at + 1)}`
    expect(codeOf(() => decryptValue(tampered, 'NAME', k))).toBe(LOCAL_ENV_ERROR_CODES.AUTH_FAILED)
  })

  it('rejects malformed values without throwing anything else', () => {
    for (const bad of [
      'cf:v1:',
      'cf:v1:1.short:abc:def',
      'cf:v1:x.AAAAAAAA:AAAA:AAAA',
      'cf:v1:1.AAAAAAAA:a:b:c',
    ]) {
      expect(parseEncryptedValue(bad)).toBeNull()
      expect(codeOf(() => decryptValue(bad, 'NAME', k))).toBe(LOCAL_ENV_ERROR_CODES.MALFORMED)
    }
  })

  it('treats anything without the prefix as plaintext', () => {
    expect(isEncryptedValue('cf:v2:whatever')).toBe(false)
    expect(isEncryptedValue('postgres://u:p@h/db')).toBe(false)
  })
})
