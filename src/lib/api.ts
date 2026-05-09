import { ConfigurationError, CryptFlare, CryptFlareError } from '@cryptflare/sdk';
import type { HttpMethod } from '@cryptflare/sdk';
import { BRAND } from '../_vendored/brand';

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
  });
  return cached;
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
