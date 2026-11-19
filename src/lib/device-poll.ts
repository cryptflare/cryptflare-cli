/**
 * Waits for a device sign-in to be approved in the browser (RFC 8628 3.4 and
 * 3.5): polls no faster than the interval the API gave, adds five seconds
 * every time it is told to slow down, and stops at the first answer that
 * settles it: a token, denied, expired, or the deadline.
 */

/** RFC 8628 3.5: what `slow_down` adds to the interval. */
export const SLOW_DOWN_STEP_SECONDS = 5

/** The CLI never polls faster than this, whatever it is told. */
export const MIN_POLL_INTERVAL_SECONDS = 3

/**
 * The API's answers to one poll, as error codes the SDK raises. Written out
 * because the public mirror the CLI is built in has no `@cryptflare/shared`
 * errors (see mirror-imports.test.ts); the SDK's error-code parity test keeps
 * the names honest.
 */
export const POLL_CODES = {
  PENDING: 'AUTH_PENDING',
  SLOW_DOWN: 'AUTH_SLOW_DOWN',
  DENIED: 'AUTH_DEVICE_DENIED',
  EXPIRED: 'RESOURCE_NOT_FOUND',
} as const

export type PollOutcome<T> =
  | { kind: 'token'; value: T }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'timeout' }

export type PollDeps<T> = {
  /** One poll. Resolves with the token, or throws an error with a `code`. */
  poll: () => Promise<T>
  /** Reads an error's code, or null when it is not an API error. */
  codeOf: (err: unknown) => string | null
  intervalSeconds: number
  expiresInSeconds: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function pollForApproval<T>(deps: PollDeps<T>): Promise<PollOutcome<T>> {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const deadline = now() + deps.expiresInSeconds * 1000
  let interval = Math.max(deps.intervalSeconds, MIN_POLL_INTERVAL_SECONDS)

  while (now() < deadline) {
    await sleep(interval * 1000)
    try {
      return { kind: 'token', value: await deps.poll() }
    } catch (err) {
      const code = deps.codeOf(err)
      if (code === POLL_CODES.PENDING) continue
      if (code === POLL_CODES.SLOW_DOWN) {
        interval += SLOW_DOWN_STEP_SECONDS
        continue
      }
      if (code === POLL_CODES.DENIED) return { kind: 'denied' }
      if (code === POLL_CODES.EXPIRED) return { kind: 'expired' }
      throw err
    }
  }
  return { kind: 'timeout' }
}
