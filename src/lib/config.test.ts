import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock conf before importing config
vi.mock('conf', () => {
  const store = new Map<string, unknown>();
  return {
    default: class MockConf {
      get(key: string) { return store.get(key); }
      set(key: string, value: unknown) { store.set(key, value); }
      delete(key: string) { store.delete(key); }
      get store() { return Object.fromEntries(store); }
      get path() { return '/mock/.config/cryptflare/config.json'; }
      clear() { store.clear(); }
    },
  };
});

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.CF_TOKEN;
    delete process.env.CF_ORG;
    delete process.env.CF_WORKSPACE;
    delete process.env.CF_ENVIRONMENT;
  });

  it('getToken returns undefined when no token set', async () => {
    const { getToken } = await import('./config.js');
    expect(getToken()).toBeUndefined();
  });

  it('setToken and getToken round-trip', async () => {
    const { getToken, setToken } = await import('./config.js');
    setToken('cf_live_test123');
    expect(getToken()).toBe('cf_live_test123');
  });

  it('CF_TOKEN env takes priority over config', async () => {
    process.env.CF_TOKEN = 'cf_live_from_env';
    const { getToken, setToken } = await import('./config.js');
    setToken('cf_live_from_config');
    expect(getToken()).toBe('cf_live_from_env');
  });

  it('clearToken removes stored token', async () => {
    const { getToken, setToken, clearToken } = await import('./config.js');
    setToken('cf_live_test');
    clearToken();
    expect(getToken()).toBeUndefined();
  });

  it('getOrg returns CF_ORG env over config', async () => {
    process.env.CF_ORG = 'org_from_env';
    const { getOrg, setOrg } = await import('./config.js');
    setOrg('org_from_config');
    expect(getOrg()).toBe('org_from_env');
  });

  it('getDefault returns CF_WORKSPACE env over config', async () => {
    process.env.CF_WORKSPACE = 'ws_from_env';
    const { getDefault } = await import('./config.js');
    expect(getDefault('workspace')).toBe('ws_from_env');
  });
});
