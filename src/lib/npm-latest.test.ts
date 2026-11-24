import { afterEach, describe, expect, it, vi } from 'vitest'

import { fetchLatestVersion } from '@/lib/npm-latest'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchLatestVersion', () => {
  it('reads the version and gives the registry a deadline', async () => {
    const fetchMock = vi.fn(async () => Response.json({ version: '9.9.9' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchLatestVersion()).resolves.toEqual({ ok: true, version: '9.9.9' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://registry.npmjs.org/%40cryptflare%2Fcli/latest')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('reports a refused or empty reply without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    )
    await expect(fetchLatestVersion()).resolves.toEqual({
      ok: false,
      reason: 'npm registry responded 503',
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    )
    await expect(fetchLatestVersion()).resolves.toMatchObject({ ok: false })
  })
})
