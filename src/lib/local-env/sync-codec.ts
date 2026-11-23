/**
 * Encrypted mode for the `cf sync` engine.
 *
 * The engine plans and merges on plaintext values. For a binding whose file
 * holds `cf:v1` values (or whose manifest entry says `"encrypted": true`),
 * values are decrypted in memory as they are read and encrypted again before
 * they are written, so ciphertext is never pushed to CryptFlare as a value
 * and plaintext is never written to the file. Keys stay in memory for at most
 * `LOCAL_ENV_FILE.KEY_MEMORY_TTL_MS` in the long-running service.
 */

import type { CryptFlare } from '@cryptflare/sdk'

import { getOrg } from '@/lib/config'
import { LOCAL_ENV_FILE } from '@/lib/local-env/contract'
import { LOCAL_ENV_ERROR_CODES, LocalEnvError } from '@/lib/local-env/errors'
import { Keyring, type KeyScope } from '@/lib/local-env/keyring'
import {
  decryptValue,
  encryptValue,
  isEncryptedValue,
  keyRefOf,
} from '@/lib/local-env/value-crypto'
import { hasManifest, loadManifest } from '@/lib/project-manifest'

type SyncScope = { organisation?: string; workspace: string; environment: string }

const keyrings = new WeakMap<CryptFlare, Keyring>()

function keyringFor(client: CryptFlare): Keyring {
  let keyring = keyrings.get(client)
  if (!keyring) {
    keyring = new Keyring(client, LOCAL_ENV_FILE.KEY_MEMORY_TTL_MS)
    keyrings.set(client, keyring)
  }
  return keyring
}

function keyScope(scope: SyncScope): KeyScope {
  const org = scope.organisation ?? getOrg()
  if (!org) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.NO_SCOPE,
      'An encrypted binding needs an organisation: run `cf org select`.',
    )
  }
  return { org, workspace: scope.workspace, environment: scope.environment }
}

/** Whether any value of a parsed file is ciphertext. */
export function hasCiphertext(values: ReadonlyMap<string, string>): boolean {
  return [...values.values()].some(isEncryptedValue)
}

/** Whether the project's manifest marks this file `"encrypted": true`. */
export function manifestSaysEncrypted(projectPath: string, file: string): boolean {
  if (!hasManifest(projectPath)) return false
  try {
    return loadManifest(projectPath).bindings.some((b) => b.file === file && b.encrypted === true)
  } catch {
    return false // A manifest broken mid-edit does not stop the binding.
  }
}

/** Decrypts every `cf:v1` value; plaintext values pass through. */
export async function decryptValues(
  client: CryptFlare,
  scope: SyncScope,
  values: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  if (!hasCiphertext(values)) return new Map(values)
  const refs = new Set(
    [...values.values()].map(keyRefOf).filter((ref): ref is string => ref !== null),
  )
  const keys = await keyringFor(client).forRefs(keyScope(scope), refs)
  const out = new Map<string, string>()
  for (const [name, value] of values) {
    const key = keys.get(keyRefOf(value) ?? '')
    out.set(name, key ? decryptValue(value, name, key) : value)
  }
  return out
}

/**
 * Encrypts values for writing into an encrypted file, under the highest key
 * version the file already uses (1 for a new file).
 */
export async function encryptValues(
  client: CryptFlare,
  scope: SyncScope,
  values: ReadonlyMap<string, string>,
  existing: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  if (values.size === 0) return new Map()
  const versions = [...existing.values()].map((v) => Number((keyRefOf(v) ?? '0').split('.')[0]))
  const key = await keyringFor(client).get(keyScope(scope), Math.max(1, ...versions))
  return new Map([...values].map(([name, value]) => [name, encryptValue(value, name, key)]))
}
