/**
 * Process exit codes for `cf`. Scripts can branch on these instead of
 * parsing stderr. Documented in packages/cli/README.md ("Exit codes"); keep
 * the two in step.
 *
 * `cf run` is the exception: it exits with the child's own status, 127 when
 * the command is not found, and 128 + n when the child dies on signal n.
 */
export const EXIT_CODES = {
  /** Everything worked. */
  SUCCESS: 0,
  /** Any failure without a more specific code: API errors, partial batch failures. */
  ERROR: 1,
  /** Bad flags or arguments. Fix the command line and re-run. */
  USAGE: 2,
  /** No credential, or the credential was rejected (401). Run `cf login`. */
  AUTH: 3,
  /** Could not reach the API: DNS, TLS, connection refused, timeout. */
  NETWORK: 4,
  /** `cf sync run` in a service: stop restarting until someone logs in (EX_CONFIG). */
  NEEDS_LOGIN: 78,
  /** `cf run`: the command to run was not found. */
  COMMAND_NOT_FOUND: 127,
  /** `cf run`: base added to the signal number when the child is killed. */
  SIGNAL_BASE: 128,
} as const

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES]
