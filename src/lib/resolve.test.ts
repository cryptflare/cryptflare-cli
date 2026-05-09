import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  getOrg: vi.fn(),
  getDefault: vi.fn(),
}));

describe('resolve', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolveContext uses flag values over defaults', async () => {
    const { resolveContext } = await import('./resolve.js');

    const ctx = resolveContext({
      org: 'org_flag',
      workspace: 'ws_flag',
      env: 'env_flag',
    });

    expect(ctx).toEqual({ org: 'org_flag', workspace: 'ws_flag', env: 'env_flag' });
  });

  it('resolveContext falls back to config defaults', async () => {
    const config = await import('./config.js');
    (config.getOrg as ReturnType<typeof vi.fn>).mockReturnValue('org_config');
    (config.getDefault as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
      if (key === 'workspace') return 'ws_config';
      if (key === 'environment') return 'env_config';
      return undefined;
    });

    const { resolveContext } = await import('./resolve.js');
    const ctx = resolveContext({});

    expect(ctx).toEqual({ org: 'org_config', workspace: 'ws_config', env: 'env_config' });
  });

  it('resolveContext exits when org is missing', async () => {
    const config = await import('./config.js');
    (config.getOrg as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { resolveContext } = await import('./resolve.js');
    resolveContext({});

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('resolveOrg uses flag over config', async () => {
    const { resolveOrg } = await import('./resolve.js');
    expect(resolveOrg({ org: 'org_direct' })).toBe('org_direct');
  });
});
