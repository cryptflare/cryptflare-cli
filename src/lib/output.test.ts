import { describe, it, expect, vi } from 'vitest';

import { AuthenticationError } from '@cryptflare/sdk';

// Mock chalk to passthrough for testing
vi.mock('chalk', () => ({
  default: {
    green: (s: string) => s,
    yellow: (s: string) => s,
    blue: (s: string) => s,
    red: (s: string) => s,
    dim: (s: string) => s,
    bold: (s: string) => s,
    cyan: (s: string) => s,
  },
}));

describe('output helpers', () => {
  it('json outputs valid JSON', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { json } = await import('./output.js');

    json({ key: 'DATABASE_URL', version: 1 });

    expect(spy).toHaveBeenCalledOnce();
    const output = spy.mock.calls[0][0];
    expect(JSON.parse(output)).toEqual({ key: 'DATABASE_URL', version: 1 });
    spy.mockRestore();
  });

  it('table outputs header and rows', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { table } = await import('./output.js');

    table([
      { name: 'My App', slug: 'my-app' },
      { name: 'Backend', slug: 'backend' },
    ]);

    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3); // header + divider + 2 rows
    spy.mockRestore();
  });

  it('table shows "No results" for empty array', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { table } = await import('./output.js');

    table([]);

    expect(spy.mock.calls[0][0]).toContain('No results');
    spy.mockRestore();
  });

  it('handleError exits on AuthenticationError', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { handleError } = await import('./output.js');

    handleError(new AuthenticationError({
      message: 'Token expired',
      status: 401,
      code: 'AUTH_INVALID_TOKEN',
    }));

    expect(spy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});
