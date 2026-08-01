import { ConfigurationError, CryptFlare, CryptFlareError } from '@cryptflare/sdk';
import type { HttpMethod } from '@cryptflare/sdk';
import { BRAND } from '../_vendored/brand';

import * as progress from './progress.js';
import { getToken } from './config.js';

const BASE_URL = process.env.CF_API_URL ?? BRAND.urls.api;

let cached: CryptFlare | null = null;

/**
 * Lazily constructs the SDK client from the stored CLI auth token. Cached so
 * repeated calls inside one process reuse one fetch pool. The CLI is
 * short-lived (one command per invocation), so the simplification is fine.
 *
 * Throws `ConfigurationError` when no token is available so the global
 * `handleError` helper prints a uniform "run cf auth login" hint.
 */
export function getClient(token?: string): CryptFlare {
  if (cached) return cached;
  const apiKey = token ?? getToken();
  if (!apiKey) {
    throw new ConfigurationError('Not authenticated. Run `cf auth login` first.');
  }
  cached = new CryptFlare({
    apiKey,
    baseUrl: BASE_URL,
    userAgentSuffix: 'cli',
    hooks: {
      // Every request gets a spinner, rather than each command remembering to
      // start one. Only a handful did, so most of the CLI simply sat there:
      // `cf secret list`, `cf workspace list` and the rest showed nothing at
      // all until their output appeared.
      onRequest: ({ method, path }) => progress.startIfIdle(progress.describeRequest(method, path)),
      onResponse: () => progress.stop(),
      // Without this the CLI is silent for the whole backoff. The reveal
      // endpoint allows 30/min, so any sizeable pull hits it and the SDK
      // sleeps for up to a minute with no output and no exit - which looks
      // exactly like a hang. Say what is happening and count it down.
      onRetry: ({ delayMs, error }) => {
        const status = (error as { status?: number }).status;
        const reason = status === 429
          ? 'Rate limited by the API, resuming in'
          : `Request failed (${status ?? 'network'}), retrying in`;
        const cancel = progress.countdown(reason, delayMs);
        // The SDK sleeps for delayMs immediately after this hook, so the timer
        // is cleared just past that point rather than left to run on.
        setTimeout(cancel, delayMs + 100).unref?.();
      },
    },
  });
  return cached;
}

/**
 * Client for endpoints that take no credentials - specifically the device
 * authorization flow (`POST /v1/cli/device`, `POST /v1/cli/token`), which is
 * how a user obtains a token in the first place.
 *
 * `getClient()` cannot be used there: it throws `ConfigurationError` when no
 * token is stored, so `cf auth login` was impossible immediately after
 * `cf auth logout` - the one moment it is guaranteed to be needed.
 *
 * Deliberately not cached. Caching it would mean a later `getClient()` call in
 * the same process silently reuses a credential-less client.
 */
export function getAnonymousClient(): CryptFlare {
  return new CryptFlare({
    // The SDK requires a non-empty apiKey. These routes ignore the
    // Authorization header entirely, so the value is never meaningful.
    apiKey: 'unauthenticated',
    baseUrl: BASE_URL,
    userAgentSuffix: 'cli',
  });
}

/** Test seam - swap the cached client between calls. */
export function resetClient(): void {
  cached = null;
}

/**
 * Backwards-compat thin wrapper for commands still using the legacy
 * `api(path)` shape. Routes the call through the SDK's public `runner`
 * so retries, idempotency, hooks, and error mapping all match what typed
 * resource calls get. New code should use `getClient()` plus the typed
 * resource methods; this helper exists only to keep migration small.
 *
 * @throws {ConfigurationError} when no auth token is available.
 * @throws {APIError} subclass on any non-2xx server response.
 */
export async function api<T>(
  path: string,
  options: { method?: HttpMethod; body?: unknown; token?: string } = {},
): Promise<T> {
  const client = getClient(options.token);
  return client.runner.send<T>({
    method: options.method ?? 'GET',
    path,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

export { CryptFlareError };

/**
 * Legacy alias kept so existing `instanceof ApiError` checks compile during
 * migration. Points at the SDK's abstract base, NOT the original CLI
 * `ApiError` class - all the rich subclasses (`AuthenticationError`,
 * `RateLimitError`, etc.) still flow through and `instanceof ApiError`
 * still narrows. Delete this export once every command imports the SDK
 * error classes directly.
 */
export const ApiError = CryptFlareError;
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type ApiError = CryptFlareError;
