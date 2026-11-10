import { randomBytes } from 'node:crypto';

/** Random bytes behind a generated secret when no size is given. */
export const DEFAULT_GENERATED_BYTES = 32;
/** Below this a generated value is too guessable to call a secret. */
export const MIN_GENERATED_BYTES = 16;
export const MAX_GENERATED_BYTES = 1024;

/**
 * Generates a secret value from the operating system's CSPRNG.
 *
 * Encoded as base64url: safe unquoted in a `.env` file, a shell, a URL and a
 * header, which hex also is but at a third more length for the same entropy.
 *
 * @throws RangeError when `bytes` is outside the supported range.
 */
export function generateSecretValue(bytes: number = DEFAULT_GENERATED_BYTES): string {
  if (!Number.isInteger(bytes) || bytes < MIN_GENERATED_BYTES || bytes > MAX_GENERATED_BYTES) {
    throw new RangeError(
      `Generated secrets must be between ${MIN_GENERATED_BYTES} and ${MAX_GENERATED_BYTES} bytes (got ${bytes}).`,
    );
  }
  return randomBytes(bytes).toString('base64url');
}

/**
 * A short, non-reversible fingerprint of a value: enough to tell two values
 * apart in a log or a tool result without disclosing either.
 */
export async function fingerprint(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Buffer.from(digest).subarray(0, 6).toString('hex');
}
