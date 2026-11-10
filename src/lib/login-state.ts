/**
 * Decides whether `cf login` may start a new sign-in.
 *
 * A saved key used to block login outright, so an expired key meant running
 * `cf logout` first - an extra step whose only purpose was to delete something
 * that no longer worked. The saved key is now checked against the API: a key
 * the API refuses is replaced without asking, a key that still works is kept
 * unless `--force` is given, and when the API cannot be reached nothing is
 * replaced, because "unreachable" is not evidence that the key is bad.
 */

/** The command a person runs to sign in. One place, so every message agrees. */
export const LOGIN_COMMAND = 'cf login';

export type CredentialState = 'valid' | 'invalid' | 'unreachable';

export type LoginDecision =
  /** No key saved, the saved key is refused by the API, or `--force`. */
  | { action: 'proceed'; reason: 'no-credential' | 'invalid' | 'forced' }
  /** The saved key still works. */
  | { action: 'refuse'; reason: 'valid' }
  /** The API did not answer, so the saved key could not be judged. */
  | { action: 'refuse'; reason: 'unreachable' };

/**
 * Classifies the outcome of a `whoami` call made with the saved key.
 *
 * Only a 401 means the key itself is refused. A 403 is a working key that may
 * not do something, and anything without a usable answer (a network error, a
 * timeout, a 5xx) says nothing about the key.
 */
export function classifyCredentialCheck(error: unknown): CredentialState {
  if (error === undefined || error === null) return 'valid';
  const status = (error as { status?: unknown }).status;
  if (status === 401) return 'invalid';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'valid';
  return 'unreachable';
}

/**
 * @param options.hasCredential Whether a key is saved (or given by `CF_TOKEN`).
 * @param options.force The `--force` flag.
 * @param options.check Asks the API about the saved key. Only called when the answer matters.
 */
export async function decideLogin(options: {
  hasCredential: boolean;
  force: boolean;
  check: () => Promise<CredentialState>;
}): Promise<LoginDecision> {
  if (!options.hasCredential) return { action: 'proceed', reason: 'no-credential' };
  if (options.force) return { action: 'proceed', reason: 'forced' };

  const state = await options.check();
  if (state === 'invalid') return { action: 'proceed', reason: 'invalid' };
  return { action: 'refuse', reason: state };
}

/** What the sync service logs when it stops because its key is refused. */
export function needsLoginMessage(passes: number): string {
  return `[sync] every file was refused as unauthenticated ${passes} passes running. Stopping. `
    + `Run \`${LOGIN_COMMAND}\` (or replace CF_TOKEN), then start the service again.`;
}
