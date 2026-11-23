/**
 * The `cf:v1` value format for encrypted local env files.
 *
 *   cf:v1:<version>.<keyId>:<nonce>:<ciphertext>
 *
 * AES-256-GCM, a fresh 96-bit nonce per value, and additional authenticated
 * data that binds the key ref, the environment id and the variable name, so a
 * value copied to another variable or another environment fails instead of
 * decrypting. See `docs/guides/encrypted-env-files.md`.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

import { LOCAL_ENV_FILE } from '@/lib/local-env/contract'
import { LOCAL_ENV_ERROR_CODES, LocalEnvError } from '@/lib/local-env/errors'

/** A released local-file key, held in memory only. */
export type LocalKey = {
  environmentId: string
  version: number
  keyId: string
  /** `<version>.<keyId>`. */
  keyRef: string
  raw: Buffer
}

/** The parts of an encrypted value, before decryption. */
export type EncryptedParts = {
  keyRef: string
  version: number
  keyId: string
  nonce: Buffer
  sealed: Buffer
}

const TAG_BYTES = 16
const B64URL = /^[A-Za-z0-9_-]+$/
const KEY_REF = /^([1-9][0-9]{0,3})\.([A-Za-z0-9_-]{8})$/

/** Whether a value is in the `cf:v1` format (by prefix; the rest is checked on parse). */
export function isEncryptedValue(value: string): boolean {
  return value.startsWith(LOCAL_ENV_FILE.VALUE_PREFIX)
}

/** Splits an encrypted value into its parts, or `null` when it is malformed. */
export function parseEncryptedValue(value: string): EncryptedParts | null {
  if (!isEncryptedValue(value)) return null
  const [keyRef = '', nonce = '', sealed = '', ...rest] = value
    .slice(LOCAL_ENV_FILE.VALUE_PREFIX.length)
    .split(':')
  const ref = KEY_REF.exec(keyRef)
  if (!ref || rest.length > 0 || !B64URL.test(nonce) || !B64URL.test(sealed)) return null
  const nonceBytes = Buffer.from(nonce, 'base64url')
  const sealedBytes = Buffer.from(sealed, 'base64url')
  if (nonceBytes.length !== LOCAL_ENV_FILE.NONCE_BYTES || sealedBytes.length < TAG_BYTES) {
    return null
  }
  return {
    keyRef,
    version: Number(ref[1]),
    keyId: ref[2] ?? '',
    nonce: nonceBytes,
    sealed: sealedBytes,
  }
}

/** The key ref a value was encrypted under, or `null` for plaintext. */
export function keyRefOf(value: string): string | null {
  return parseEncryptedValue(value)?.keyRef ?? null
}

/** Additional authenticated data for one value. */
export function aadFor(keyRef: string, environmentId: string, name: string): Buffer {
  return Buffer.from(`${LOCAL_ENV_FILE.FORMAT}|${keyRef}|${environmentId}|${name}`, 'utf-8')
}

/** The short key id the server also computes; used to check a released key. */
export function keyIdOf(raw: Buffer): string {
  return createHmac('sha256', raw)
    .update(LOCAL_ENV_FILE.KEY_ID_LABEL)
    .digest()
    .subarray(0, LOCAL_ENV_FILE.KEY_ID_BYTES)
    .toString('base64url')
}

/** Encrypts one value for `name` under `key`. */
export function encryptValue(plaintext: string, name: string, key: LocalKey): string {
  const nonce = randomBytes(LOCAL_ENV_FILE.NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key.raw, nonce)
  cipher.setAAD(aadFor(key.keyRef, key.environmentId, name))
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return `${LOCAL_ENV_FILE.VALUE_PREFIX}${key.keyRef}:${nonce.toString('base64url')}:${body.toString('base64url')}`
}

/**
 * Decrypts one value for `name`.
 *
 * @throws LocalEnvError when the value is malformed, was encrypted under
 *   another key, or fails authentication (tampered, moved from another
 *   variable or another environment).
 */
export function decryptValue(value: string, name: string, key: LocalKey): string {
  const parts = parseEncryptedValue(value)
  if (!parts) {
    throw new LocalEnvError(LOCAL_ENV_ERROR_CODES.MALFORMED, `${name}: not a valid cf:v1 value`)
  }
  if (parts.keyRef !== key.keyRef) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.WRONG_KEY,
      `${name}: encrypted under key ${parts.keyRef}, but this environment's key is ${key.keyRef}. ` +
        'The file was probably encrypted for another environment.',
    )
  }
  const tagAt = parts.sealed.length - TAG_BYTES
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.raw, parts.nonce)
    decipher.setAAD(aadFor(parts.keyRef, key.environmentId, name))
    decipher.setAuthTag(parts.sealed.subarray(tagAt))
    return Buffer.concat([
      decipher.update(parts.sealed.subarray(0, tagAt)),
      decipher.final(),
    ]).toString('utf-8')
  } catch (err) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.AUTH_FAILED,
      `${name}: the value failed authentication. It was changed, or moved from another variable or environment.`,
      { cause: err },
    )
  }
}
