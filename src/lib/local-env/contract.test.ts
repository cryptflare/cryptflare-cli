/**
 * The CLI's copy of the local env file contract against the shared source of
 * truth, loaded by path so the public mirror (which has no shared package)
 * skips it. See `device-contract.test.ts` for the same pattern.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as contract from '@/lib/local-env/contract'

const SHARED = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../shared/src/constants/local-env-files.ts',
)

describe.skipIf(!existsSync(SHARED))('local env file contract', () => {
  it('repeats the shared constants exactly', async () => {
    const shared = (await import(/* @vite-ignore */ SHARED)) as Record<string, unknown>
    expect(contract.LOCAL_ENV_FILE).toEqual(shared['LOCAL_ENV_FILE'])
    expect(contract.BROWSER_PUBLIC_PREFIXES).toEqual(shared['BROWSER_PUBLIC_PREFIXES'])
  })
})
