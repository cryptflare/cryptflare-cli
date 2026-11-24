import { readString } from '@/lib/guards'

/** The name this CLI is published under. */
export const NPM_PACKAGE = '@cryptflare/cli'

/** How long `cf update` and `cf doctor` wait for the npm registry. */
export const NPM_REGISTRY_TIMEOUT_MS = 10_000

/** What the registry answered: the latest version, or why there is none. */
export type LatestVersion = { ok: true; version: string } | { ok: false; reason: string }

/**
 * Asks the npm registry for the latest published version of the CLI. Never
 * throws for a registry problem: a non-2xx reply or a body with no version
 * comes back as `{ ok: false }`. A network failure or the deadline rejects.
 */
export async function fetchLatestVersion(): Promise<LatestVersion> {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(NPM_REGISTRY_TIMEOUT_MS),
  })
  if (!res.ok) return { ok: false, reason: `npm registry responded ${res.status}` }
  const version = readString(await res.json(), 'version')
  if (version === undefined) return { ok: false, reason: 'npm returned no version for the package' }
  return { ok: true, version }
}
