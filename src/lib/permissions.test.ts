import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock store for the conf library; exposed via vi.hoisted so the
// beforeEach below can wipe it between tests without bleeding state.
const mockStore = vi.hoisted(() => new Map<string, unknown>());
vi.mock('conf', () => ({
  default: class MockConf {
    get(key: string) { return mockStore.get(key); }
    set(key: string, value: unknown) { mockStore.set(key, value); }
    delete(key: string) { mockStore.delete(key); }
    get store() { return Object.fromEntries(mockStore); }
    get path() { return '/mock/.config/cryptflare/config.json'; }
    clear() { mockStore.clear(); }
  },
}));

// Mock the SDK client so we can drive whoami responses per test.
const whoamiMock = vi.fn();
vi.mock('../lib/api.js', () => ({
  getClient: () => ({ auth: { whoami: whoamiMock } }),
}));
vi.mock('./api.js', () => ({
  getClient: () => ({ auth: { whoami: whoamiMock } }),
}));

describe('permissions', () => {
  beforeEach(async () => {
    vi.resetModules();
    whoamiMock.mockReset();
    mockStore.clear();
    process.env.CF_TOKEN = 'cf_live_abcdef123456_token';
  });

  it('caches permissions and short-circuits subsequent calls', async () => {
    whoamiMock.mockResolvedValueOnce({ permissions: ['secrets:read', 'secrets:write'] });
    const { getEffectivePermissions } = await import('./permissions.js');

    const first = await getEffectivePermissions();
    const second = await getEffectivePermissions();

    expect(first).toEqual(['secrets:read', 'secrets:write']);
    expect(second).toEqual(['secrets:read', 'secrets:write']);
    expect(whoamiMock).toHaveBeenCalledTimes(1);
  });

  it('throws InsufficientPermissionError with required + granted names', async () => {
    whoamiMock.mockResolvedValueOnce({ permissions: ['secrets:read'] });
    const { requirePermission, InsufficientPermissionError } = await import('./permissions.js');

    await expect(requirePermission('secrets:write')).rejects.toBeInstanceOf(InsufficientPermissionError);

    try {
      await requirePermission('secrets:write');
    } catch (err) {
      const e = err as InstanceType<typeof InsufficientPermissionError>;
      expect(e.required).toBe('secrets:write');
      expect(e.granted).toEqual(['secrets:read']);
      expect(e.message).toContain('Need: secrets:write');
      expect(e.message).toContain('Have: secrets:read');
    }
  });

  it('resolves silently when the permission is present', async () => {
    whoamiMock.mockResolvedValueOnce({ permissions: ['tokens:revoke'] });
    const { requirePermission } = await import('./permissions.js');
    await expect(requirePermission('tokens:revoke')).resolves.toBeUndefined();
  });

  it('refetches when no token is cached for the current bearer', async () => {
    whoamiMock.mockResolvedValueOnce({ permissions: ['scope:a'] });
    const mod = await import('./permissions.js');
    await mod.getEffectivePermissions();

    // Swap the bearer token; the prefix changes so the cache is a miss.
    process.env.CF_TOKEN = 'cf_test_999999999999_other';
    whoamiMock.mockResolvedValueOnce({ permissions: ['scope:b'] });
    const second = await mod.getEffectivePermissions();

    expect(second).toEqual(['scope:b']);
    expect(whoamiMock).toHaveBeenCalledTimes(2);
  });

  it('returns [] when the server omits the permissions field', async () => {
    whoamiMock.mockResolvedValueOnce({});
    const { getEffectivePermissions } = await import('./permissions.js');
    const perms = await getEffectivePermissions();
    expect(perms).toEqual([]);
  });

  it('throws a clear error when there is no token', async () => {
    delete process.env.CF_TOKEN;
    const { getEffectivePermissions } = await import('./permissions.js');
    await expect(getEffectivePermissions()).rejects.toThrow(/Not authenticated/);
  });
});
