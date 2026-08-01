/**
 * Client-side permission gate for destructive commands.
 *
 * Calls `auth.whoami` once per CLI invocation (per ~5 minutes when cached)
 * to learn the bearer token's scopes, then short-circuits a command with
 * a clear "Need X, have Y" error before any destructive API request runs.
 * The server is still the source of truth - this is purely defensive UX
 * so the user gets an honest error before, not after, they paste a
 * production secret into a doomed rotation.
 *
 * Cache semantics:
 *   - Stored in the `conf` config alongside the token. Tied to the first
 *     12 characters of the bearer token; a new login wipes the entry
 *     (see `clearToken`), and a stale entry against a re-issued token
 *     is treated as a miss.
 *   - 5-minute TTL. Long enough to avoid hammering /whoami on every
 *     command; short enough to pick up scope edits without forcing the
 *     user to re-login.
 */

import { getToken, getCachedPermissions, setCachedPermissions } from './config.js';
import { getClient } from './api.js';

const PERMISSIONS_TTL_MS = 5 * 60 * 1000;

type WhoamiResponse = {
  permissions: string[];
};

/**
 * `null` means "could not determine" - the refresh failed and there is no
 * usable cache. Callers must treat that as "proceed and let the server
 * decide", never as "denied".
 */
export async function getEffectivePermissions(): Promise<string[] | null> {
  const token = getToken();
  if (!token) {
    throw new Error('Not authenticated. Run `cf login` first.');
  }
  const tokenPrefix = token.slice(0, 12);

  const cached = getCachedPermissions();
  const cacheUsable = cached && cached.tokenPrefix === tokenPrefix;
  if (cacheUsable) {
    const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
    if (ageMs >= 0 && ageMs < PERMISSIONS_TTL_MS) {
      return cached.permissions;
    }
  }

  try {
    // SDK WhoAmI type is stale (no `permissions` field). Cast through
    // unknown so we don't lie about the SDK contract here.
    const res = (await getClient().auth.whoami()) as unknown as WhoamiResponse;
    const permissions = Array.isArray(res?.permissions) ? res.permissions : [];
    setCachedPermissions({
      tokenPrefix,
      permissions,
      fetchedAt: new Date().toISOString(),
    });
    return permissions;
  } catch (err) {
    // A bad credential is a real answer: fail closed so the user is told to
    // log in rather than watching every later call 401.
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) throw err;

    // Anything else - 5xx, DNS, timeout - is the advisory check being
    // unavailable, not a denial. Refreshing scopes is a convenience; letting
    // it take down the command turns a nicety into a hard dependency. A
    // 503 on /whoami aborted an entire `cf sync init` bootstrap this way.
    if (cacheUsable) return cached.permissions;
    return null;
  }
}

export class InsufficientPermissionError extends Error {
  readonly required: string;
  readonly granted: string[];

  constructor(required: string, granted: string[]) {
    super(
      `Insufficient permission. Need: ${required}. Have: ${granted.length > 0 ? granted.join(', ') : '(none)'}.`,
    );
    this.required = required;
    this.granted = granted;
    this.name = 'InsufficientPermissionError';
  }
}

/**
 * Throws `InsufficientPermissionError` when the bearer token's scopes
 * do not include `required`. Server-side enforcement still owns the
 * authoritative check; this just fails the user fast.
 */
export async function requirePermission(required: string): Promise<void> {
  const granted = await getEffectivePermissions();
  // Unknown scopes: proceed. The server enforces the same rule and will
  // reject with an authoritative error if this really is not permitted.
  if (granted === null) return;
  if (!granted.includes(required)) {
    throw new InsufficientPermissionError(required, granted);
  }
}
