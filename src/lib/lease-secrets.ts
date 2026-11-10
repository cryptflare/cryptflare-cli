import { KEY_PATTERN, MAX_KEY_LENGTH } from './secret-validation.js';

/**
 * Names the secrets a dynamic lease's credentials are stored under.
 *
 * A lease returns fields such as `EMAIL` and `PASSWORD`. Stored as they are
 * they would collide between leases, so each is saved as `<PREFIX>_<FIELD>`:
 * a lease for a Stripe test account saved with prefix `STRIPE_TEST` becomes
 * `STRIPE_TEST_EMAIL` and `STRIPE_TEST_PASSWORD`.
 *
 * @throws Error when the prefix, or a resulting key, is not a valid secret key.
 */
export function leaseSecretKeys(prefix: string, credentials: Record<string, string>): Map<string, string> {
  const cleaned = prefix.trim().replace(/_+$/, '');
  if (!KEY_PATTERN.test(cleaned)) {
    throw new Error(`--prefix must be UPPER_SNAKE_CASE, for example SIGNUP_TEST (got "${prefix}")`);
  }

  const secrets = new Map<string, string>();
  for (const [field, value] of Object.entries(credentials)) {
    const key = `${cleaned}_${field.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`;
    if (!KEY_PATTERN.test(key) || key.length > MAX_KEY_LENGTH) {
      throw new Error(`Credential field "${field}" does not make a valid secret key with this prefix.`);
    }
    secrets.set(key, value);
  }
  return secrets;
}
