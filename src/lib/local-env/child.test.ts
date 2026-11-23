/**
 * `cf run` with decrypted local values: a SIGTERM to cf must reach the child,
 * so the child does not keep running with the secrets after cf is gone.
 */
import { describe, expect, it } from 'vitest'

import { runChildWithCleanup } from '@/lib/local-env/child'

describe('runChildWithCleanup', () => {
  it('forwards SIGTERM to the child and reports 128 + 15', async () => {
    let cleaned = 0
    const running = runChildWithCleanup(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.env,
      () => {
        cleaned += 1
      },
    )
    // Emitting the signal runs cf's handlers without killing the test runner.
    await new Promise((resolve) => setTimeout(resolve, 200))
    process.emit('SIGTERM', 'SIGTERM')
    expect(await running).toBe(143)
    expect(cleaned).toBe(1)
  })
})
