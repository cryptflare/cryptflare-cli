import { describe, expect, it } from 'vitest'

import { pollForApproval, POLL_CODES, type PollDeps } from '@/lib/device-poll'

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** A fake clock: sleeping moves time on, and each sleep is recorded. */
function harness(answers: Array<string | 'token'>, overrides: Partial<PollDeps<string>> = {}) {
  let clock = 0
  const sleeps: number[] = []
  const queue = [...answers]
  const deps: PollDeps<string> = {
    poll: async () => {
      const next = queue.shift() ?? POLL_CODES.PENDING
      if (next === 'token') return 'cf_live_x'
      throw new CodedError(next)
    },
    codeOf: (err) => (err instanceof CodedError ? err.code : null),
    intervalSeconds: 5,
    expiresInSeconds: 600,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    ...overrides,
  }
  return { deps, sleeps }
}

describe('pollForApproval', () => {
  it('keeps polling at the interval while pending, then returns the token', async () => {
    const { deps, sleeps } = harness([POLL_CODES.PENDING, POLL_CODES.PENDING, 'token'])
    expect(await pollForApproval(deps)).toEqual({ kind: 'token', value: 'cf_live_x' })
    expect(sleeps).toEqual([5000, 5000, 5000])
  })

  it('adds five seconds to the interval on every slow_down, and keeps it', async () => {
    const { deps, sleeps } = harness([
      POLL_CODES.SLOW_DOWN,
      POLL_CODES.SLOW_DOWN,
      POLL_CODES.PENDING,
      'token',
    ])
    await pollForApproval(deps)
    expect(sleeps).toEqual([5000, 10000, 15000, 15000])
  })

  it('stops at once when the person denied it', async () => {
    const { deps, sleeps } = harness([POLL_CODES.PENDING, POLL_CODES.DENIED, 'token'])
    expect(await pollForApproval(deps)).toEqual({ kind: 'denied' })
    expect(sleeps).toHaveLength(2)
  })

  it('stops when the code expired or was spent', async () => {
    const { deps } = harness([POLL_CODES.EXPIRED])
    expect(await pollForApproval(deps)).toEqual({ kind: 'expired' })
  })

  it('gives up at the deadline', async () => {
    const { deps } = harness([], { expiresInSeconds: 12 })
    expect(await pollForApproval(deps)).toEqual({ kind: 'timeout' })
  })

  it('never polls faster than three seconds', async () => {
    const { deps, sleeps } = harness(['token'], { intervalSeconds: 0 })
    await pollForApproval(deps)
    expect(sleeps).toEqual([3000])
  })

  it('rethrows an error it does not understand', async () => {
    const { deps } = harness(['INTERNAL_ERROR'])
    await expect(pollForApproval(deps)).rejects.toThrow('INTERNAL_ERROR')
  })
})
