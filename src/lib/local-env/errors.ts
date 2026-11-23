/** Stable codes for {@link LocalEnvError}, so callers branch on the code, not the message. */
export const LOCAL_ENV_ERROR_CODES = {
  /** A `cf:v1` value is malformed. */
  MALFORMED: 'local_env.malformed',
  /** A value was encrypted under another environment's or version's key. */
  WRONG_KEY: 'local_env.wrong_key',
  /** A value failed authentication: tampered, or moved to another variable. */
  AUTH_FAILED: 'local_env.auth_failed',
  /** The file's environment could not be worked out. */
  NO_SCOPE: 'local_env.no_scope',
  /** The released key did not match the key id the server reported. */
  KEY_MISMATCH: 'local_env.key_mismatch',
  /** The file cannot be handled (unknown format, unreadable). */
  UNSUPPORTED: 'local_env.unsupported',
} as const

export type LocalEnvErrorCode = (typeof LOCAL_ENV_ERROR_CODES)[keyof typeof LOCAL_ENV_ERROR_CODES]

/**
 * An encrypted local env file could not be read, encrypted or decrypted.
 * The message names the variable or file, never a value.
 */
export class LocalEnvError extends Error {
  readonly code: LocalEnvErrorCode

  constructor(code: LocalEnvErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalEnvError'
    this.code = code
  }
}
