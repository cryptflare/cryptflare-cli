import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APIError, ConfigurationError } from '@cryptflare/sdk';

import { api, ApiError, getAnonymousClient, getClient, resetClient } from './api.js';

// `getToken` is a spy rather than a fixed function so individual tests can
// simulate the unauthenticated state without a second mock factory.
const mocks = vi.hoisted(() => ({
  getToken: vi.fn<() => string | undefined>(() => 'cf_test_mock_token'),
}));

vi.mock('./config.js', () => ({
  getToken: mocks.getToken,
}));

/** Build a real `Response` so `headers.get(...)` works inside the SDK. */
function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client (SDK-backed shim)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
    // Each test resets the cached client so it picks up the freshly-mocked
    // fetch via `globalThis.fetch`.
    resetClient();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetClient();
  });

  it('sends GET request with auth header', async () => {
    const mockResponse = { data: [{ key: 'TEST' }] };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse(mockResponse));

    const result = await api('/v1/test');

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const [url, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/v1/test');
    expect(options.headers.authorization).toBe('Bearer cf_test_mock_token');
    expect(options.method).toBe('GET');
    expect(result).toEqual(mockResponse);
  });

  it('sends POST request with JSON body', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({ success: true }));

    await api('/v1/test', { method: 'POST', body: { key: 'value' } });

    const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.method).toBe('POST');
    expect(options.headers['content-type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ key: 'value' });
  });

  it('throws an APIError subclass on non-ok response', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse({ error: 'RESOURCE_NOT_FOUND', message: 'Not found' }, { status: 404 }),
    );

    await expect(api('/v1/missing', { retry: undefined } as never))
      .rejects.toBeInstanceOf(ApiError);

    resetClient();

    try {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
        jsonResponse({ error: 'RESOURCE_NOT_FOUND', message: 'Not found' }, { status: 404 }),
      );
      await api('/v1/missing');
    } catch (err) {
      expect(err).toBeInstanceOf(APIError);
      const apiErr = err as APIError;
      expect(apiErr.status).toBe(404);
      expect(apiErr.code).toBe('RESOURCE_NOT_FOUND');
      expect(apiErr.message).toBe('Not found');
    }
  });

  it('uses custom token when provided', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(jsonResponse({}));

    await api('/v1/test', { token: 'cf_live_custom' });

    const [, options] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.headers.authorization).toBe('Bearer cf_live_custom');
  });
});

/**
 * The device-authorization flow is how a user obtains a token, so it has to
 * work with no token stored. `cf auth login` used to call `getClient()`, which
 * throws when the config is empty - making login impossible in exactly the
 * state it exists to resolve: straight after `cf auth logout`, or on a fresh
 * machine. It surfaced as an unhandled ConfigurationError stack trace.
 */
describe('anonymous client (device auth flow)', () => {
  beforeEach(() => {
    resetClient();
    mocks.getToken.mockReturnValue('cf_test_mock_token');
  });

  afterEach(() => {
    resetClient();
  });

  it('constructs with no stored token', () => {
    mocks.getToken.mockReturnValue(undefined);
    const client = getAnonymousClient();
    expect(typeof client.cli.requestDeviceCode).toBe('function');
  });

  it('is what login needs, because getClient still throws without a token', () => {
    mocks.getToken.mockReturnValue(undefined);
    expect(() => getClient()).toThrow(ConfigurationError);
    expect(() => getAnonymousClient()).not.toThrow();
  });

  it('does not poison the shared client cache', () => {
    // A cached anonymous client would make every authenticated call after a
    // successful login silently use credential-less headers.
    const anon = getAnonymousClient();
    const real = getClient();
    expect(real).not.toBe(anon);
  });

  it('returns a fresh instance per call', () => {
    expect(getAnonymousClient()).not.toBe(getAnonymousClient());
  });
});
