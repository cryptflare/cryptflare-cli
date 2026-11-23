/**
 * Test double for the local-file key endpoint: derives keys exactly as the
 * API does (HKDF-SHA256 from a root, salt = environment id, versioned info)
 * and records every request. Used by the CLI's tests only.
 */

import { createHmac, hkdfSync, randomUUID } from 'node:crypto'

import type { CryptFlare } from '@cryptflare/sdk'

import { LOCAL_ENV_FILE } from '@/lib/local-env/contract'

export type KeyRequest = { path: string; version: number }

export type FakeKeyApi = {
  client: CryptFlare
  requests: KeyRequest[]
  /** Make every following request fail like an unreachable API. */
  goOffline(): void
}

function keyIdOf(raw: Buffer): string {
  return createHmac('sha256', raw)
    .update(LOCAL_ENV_FILE.KEY_ID_LABEL)
    .digest()
    .subarray(0, LOCAL_ENV_FILE.KEY_ID_BYTES)
    .toString('base64url')
}

/** Environment id the fake assigns to an environment slug. */
export function fakeEnvironmentId(environment: string): string {
  return `env_${environment}`
}

export function fakeKeyApi(root: string = randomUUID()): FakeKeyApi {
  const requests: KeyRequest[] = []
  let offline = false
  const request = async (descriptor: { path: string; query?: Record<string, unknown> }) => {
    const version = Number(descriptor.query?.['version'] ?? 1)
    requests.push({ path: descriptor.path, version })
    if (offline) throw new Error('fetch failed: getaddrinfo ENOTFOUND api.cryptflare.com')
    const environment = /\/environments\/([^/]+)\/local-key$/.exec(descriptor.path)?.[1] ?? ''
    const environmentId = fakeEnvironmentId(decodeURIComponent(environment))
    const raw = Buffer.from(
      hkdfSync(
        'sha256',
        root,
        environmentId,
        `${LOCAL_ENV_FILE.HKDF_INFO_PREFIX}${version}`,
        LOCAL_ENV_FILE.KEY_BYTES,
      ),
    )
    const keyId = keyIdOf(raw)
    return {
      data: {
        environmentId,
        workspaceId: 'ws_test',
        version,
        keyId,
        keyRef: `${version}.${keyId}`,
        key: raw.toString('base64url'),
        algorithm: LOCAL_ENV_FILE.ALGORITHM,
      },
    }
  }
  return {
    // Only `request` is used by the keyring; the rest of the client is never touched.
    client: { request } as unknown as CryptFlare,
    requests,
    goOffline: () => {
      offline = true
    },
  }
}
