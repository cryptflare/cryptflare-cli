/**
 * Fetches local-file keys from the API and holds them in memory.
 *
 * A key is never written to disk. A short-lived command (`cf run`,
 * `cf env decrypt`) asks once per environment and key version; the sync
 * service keeps a key for at most `LOCAL_ENV_FILE.KEY_MEMORY_TTL_MS`.
 */

import type { CryptFlare } from '@cryptflare/sdk'

import { readNumber, readString } from '@/lib/guards'
import { LOCAL_ENV_FILE } from '@/lib/local-env/contract'
import { LOCAL_ENV_ERROR_CODES, LocalEnvError } from '@/lib/local-env/errors'
import { keyIdOf, type LocalKey } from '@/lib/local-env/value-crypto'

/** The environment a file belongs to. */
export type KeyScope = { org: string; workspace: string; environment: string }

const enc = encodeURIComponent

/** Asks the API for one environment's key at one version and checks it. */
export async function fetchLocalKey(
  client: CryptFlare,
  scope: KeyScope,
  version: number,
): Promise<LocalKey> {
  const body = await client.request<unknown>({
    method: 'GET',
    path: `/v1/organisations/${enc(scope.org)}/workspaces/${enc(scope.workspace)}/environments/${enc(scope.environment)}/local-key`,
    query: { version },
  })
  // Checked field by field: the CLI cannot import the shared Zod schema
  // (see ./contract.ts), and a key is not something to trust by shape.
  const environmentId = readString(body, 'data', 'environmentId')
  const keyId = readString(body, 'data', 'keyId')
  const keyRef = readString(body, 'data', 'keyRef')
  const key = readString(body, 'data', 'key')
  const released = readNumber(body, 'data', 'version')
  if (!environmentId || !keyId || !keyRef || !key || released !== version) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.KEY_MISMATCH,
      'The API answered the key request with an unexpected shape.',
    )
  }
  const raw = Buffer.from(key, 'base64url')
  if (
    raw.length !== LOCAL_ENV_FILE.KEY_BYTES ||
    keyIdOf(raw) !== keyId ||
    keyRef !== `${version}.${keyId}`
  ) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.KEY_MISMATCH,
      'The released key does not match its key id.',
    )
  }
  return { environmentId, version, keyId, keyRef, raw }
}

type Cached = { key: Promise<LocalKey>; at: number }

/** Keys by scope and version, fetched at most once each while fresh. */
export class Keyring {
  private readonly cache = new Map<string, Cached>()

  constructor(
    private readonly client: CryptFlare,
    private readonly ttlMs: number = Number.POSITIVE_INFINITY,
  ) {}

  /** The key for one scope and version. */
  get(scope: KeyScope, version: number): Promise<LocalKey> {
    const id = `${scope.org}/${scope.workspace}/${scope.environment}@${version}`
    const hit = this.cache.get(id)
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.key
    const key = fetchLocalKey(this.client, scope, version)
    // A failed fetch is not cached: the next attempt asks again.
    key.catch(() => this.cache.delete(id))
    this.cache.set(id, { key, at: Date.now() })
    return key
  }

  /**
   * Keys for every key ref a file uses, by key ref.
   *
   * @throws LocalEnvError when a ref's key id does not match this scope's key
   *   at that version: the file was encrypted for another environment.
   */
  async forRefs(scope: KeyScope, refs: Iterable<string>): Promise<Map<string, LocalKey>> {
    const keys = new Map<string, LocalKey>()
    for (const ref of refs) {
      const version = Number(ref.split('.')[0])
      const key = await this.get(scope, version)
      if (key.keyRef !== ref) {
        throw new LocalEnvError(
          LOCAL_ENV_ERROR_CODES.WRONG_KEY,
          `values were encrypted under key ${ref}, but ${scope.workspace}/${scope.environment} has ${key.keyRef} at that version. ` +
            'The file was encrypted for another environment.',
        )
      }
      keys.set(ref, key)
    }
    return keys
  }

  /** Forgets every key (used by tests and on logout-like failures). */
  clear(): void {
    this.cache.clear()
  }
}
