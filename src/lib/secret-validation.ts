/**
 * Client-side validation of secret keys and values, mirroring the server's
 * schema so a bad entry is caught before anything is written.
 *
 * `cf push` used to send one request per key with no rollback and no summary.
 * A rejection partway through left the remote half-written and reported only
 * the error - so a `.env` with an empty value at line 6 created nothing, while
 * the same file with the empty value at the end would have created everything
 * before it, and neither outcome told you which. That is how
 * `STAFF_ADMIN_EMAILS` ended up orphaned in the wrong environment.
 *
 * Validating first turns "wrote some of it, then failed" into "wrote nothing,
 * and here is every problem at once".
 *
 * These rules are duplicated from `@cryptflare/shared/schemas/secrets`, which
 * the CLI cannot import - the published mirror vendors only BRAND. A test
 * asserts the constants still match the server's, so drift is caught rather
 * than shipped.
 */

/** Server rule: `UPPER_SNAKE_CASE`. */
export const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const MAX_KEY_LENGTH = 256;
export const MAX_VALUE_LENGTH = 65536;
/** Server caps a single batch request at 100 entries. */
export const MAX_BATCH_SIZE = 100;

export type SecretProblem = { key: string; reason: string };

/**
 * Returns every problem in the set, not just the first. A file with three bad
 * keys should take one round trip to fix, not three.
 */
export function validateSecrets(secrets: Map<string, string>): SecretProblem[] {
  const problems: SecretProblem[] = [];

  for (const [key, value] of secrets) {
    if (key.length > MAX_KEY_LENGTH) {
      problems.push({ key, reason: `key is ${key.length} characters (max ${MAX_KEY_LENGTH})` });
    } else if (!KEY_PATTERN.test(key)) {
      problems.push({
        key,
        reason: `key must be UPPER_SNAKE_CASE (suggested: ${suggestKey(key)})`,
      });
    }

    if (value.length === 0) {
      // The concrete case that broke a push: `VITE_API_URL=` with nothing after
      // the equals sign.
      problems.push({ key, reason: 'value is empty - remove the line or give it a value' });
    } else if (value.length > MAX_VALUE_LENGTH) {
      problems.push({ key, reason: `value is ${value.length} bytes (max ${MAX_VALUE_LENGTH})` });
    }
  }

  return problems;
}

/** Best-effort correction shown alongside a rejected key. */
export function suggestKey(key: string): string {
  const fixed = key
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toUpperCase()
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return KEY_PATTERN.test(fixed) ? fixed : 'VALID_KEY_NAME';
}

/** Splits into server-sized batches. */
export function chunk<T>(items: T[], size = MAX_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
