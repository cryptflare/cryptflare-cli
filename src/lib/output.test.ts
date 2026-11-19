import { describe, it, expect, vi } from 'vitest'

import { AuthenticationError } from '@cryptflare/sdk'

// Mock chalk to passthrough for testing
vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
  },
}))

describe('output helpers', () => {
  it('json outputs valid JSON', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { json } = await import('@/lib/output')

    json({ key: 'DATABASE_URL', version: 1 })

    expect(spy).toHaveBeenCalledOnce()
    const output = spy.mock.calls[0]?.[0]
    expect(JSON.parse(String(output))).toEqual({ key: 'DATABASE_URL', version: 1 })
    spy.mockRestore()
  })

  it('table outputs header and rows', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { table } = await import('@/lib/output')

    table([
      { name: 'My App', slug: 'my-app' },
      { name: 'Backend', slug: 'backend' },
    ])

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3) // header + divider + 2 rows
    spy.mockRestore()
  })

  it('table shows "No results" for empty array', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const { table } = await import('@/lib/output')

    table([])

    expect(spy.mock.calls[0]?.[0]).toContain('No results')
    spy.mockRestore()
  })

  it('handleError exits with EXIT_CODES.AUTH on AuthenticationError', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { handleError } = await import('@/lib/output')

    handleError(
      new AuthenticationError({
        message: 'Token expired',
        status: 401,
        code: 'AUTH_INVALID_TOKEN',
      }),
    )

    expect(spy).toHaveBeenCalled()
    expect(exitSpy).toHaveBeenNthCalledWith(1, 3)
    spy.mockRestore()
    exitSpy.mockRestore()
  })

  it('handleError exits with EXIT_CODES.NETWORK on ConnectionError', async () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const { handleError } = await import('@/lib/output')
    const { ConnectionError } = await import('@cryptflare/sdk')

    handleError(new ConnectionError('ECONNREFUSED'))

    expect(exitSpy).toHaveBeenNthCalledWith(1, 4)
    spy.mockRestore()
    exitSpy.mockRestore()
  })

  it('writes warn and info to stderr, not stdout', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { warn, info } = await import('@/lib/output')

    warn('careful')
    info('note')

    expect(out).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalledTimes(2)
    out.mockRestore()
    err.mockRestore()
  })
})
