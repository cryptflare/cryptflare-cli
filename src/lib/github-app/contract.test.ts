/**
 * The CLI's copy of the `github_app` contract against the source of truth in
 * `@cryptflare/shared`. The shared files are loaded by path at run time: the
 * public mirror has no `@cryptflare/shared`, so there this test is skipped.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as contract from '@/lib/github-app/contract'

const SHARED_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../../shared/src')
const GITHUB = join(SHARED_SRC, 'constants/dynamic-github.ts')
const DYNAMIC = join(SHARED_SRC, 'constants/dynamic-secrets.ts')
const inMonorepo = [GITHUB, DYNAMIC].every((path) => existsSync(path))

/** Loads a shared module by path; the mirror never gets here. */
async function load(path: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(/* @vite-ignore */ path)
  return module as Record<string, unknown>
}

describe.skipIf(!inMonorepo)('github_app contract', () => {
  it('repeats the shared GitHub constants exactly', async () => {
    const shared = await load(GITHUB)
    for (const name of [
      'GITHUB_APP_DYNAMIC',
      'GITHUB_PERMISSION_LEVELS',
      'GITHUB_PERMISSION_NAME_PATTERN',
    ] as const) {
      expect(contract[name], name).toEqual(shared[name])
    }
  })

  it('repeats the shared dynamic secret defaults and the provider key', async () => {
    const shared = await load(DYNAMIC)
    for (const name of [
      'DYNAMIC_MIN_TTL_SECONDS',
      'DYNAMIC_DEFAULT_TTL_SECONDS',
      'DYNAMIC_DEFAULT_MAX_CONCURRENT_LEASES',
      'DYNAMIC_DEFAULT_MAX_LEASES_PER_IDENTITY',
    ] as const) {
      expect(contract[name], name).toEqual(shared[name])
    }
    expect(shared['DYNAMIC_PROVIDERS']).toContain(contract.GITHUB_APP_PROVIDER)
  })
})
