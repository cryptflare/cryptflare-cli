import { describe, it, expect } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';

import { revealSecrets } from './reveal.js';

const SCOPE = { organisation: 'org_1', workspace: 'ws', environment: 'dev' };

function fake(remote: Map<string, string>, opts: { batchStatus?: number } = {}) {
  const calls = { revealMany: [] as (string[] | undefined)[], reveal: [] as string[], lists: 0 };
  const client = {
    secrets: {
      revealMany: async ({ keys }: { keys?: string[] }) => {
        calls.revealMany.push(keys);
        if (opts.batchStatus) {
          throw Object.assign(new Error(`HTTP ${opts.batchStatus}`), { status: opts.batchStatus });
        }
        const wanted = keys ?? [...remote.keys()];
        return {
          secrets: wanted.filter((k) => remote.has(k)).map((k) => ({ key: k, value: remote.get(k)!, version: 1 })),
          missing: wanted.filter((k) => !remote.has(k)),
          encoding: 'utf-8' as const,
        };
      },
      reveal: async ({ key }: { key: string }) => {
        calls.reveal.push(key);
        return { key, value: remote.get(key)!, version: 1 };
      },
      list: () => {
        calls.lists++;
        return {
          async *[Symbol.asyncIterator]() {
            for (const key of remote.keys()) yield { key, version: 1 };
          },
        };
      },
    },
  };
  return { client: client as unknown as CryptFlare, calls };
}

describe('revealSecrets', () => {
  it('fetches a whole environment in one request', async () => {
    const { client, calls } = fake(new Map([['A', '1'], ['B', '2'], ['C', '3']]));

    const values = await revealSecrets(client, SCOPE);

    expect(values).toEqual(new Map([['A', '1'], ['B', '2'], ['C', '3']]));
    // The point of the exercise: one call, not one per key plus a list.
    expect(calls.revealMany).toEqual([undefined]);
    expect(calls.reveal).toEqual([]);
    expect(calls.lists).toBe(0);
  });

  it('splits a large key set into batches at the server cap', async () => {
    const remote = new Map(Array.from({ length: 250 }, (_, i) => [`K${i}`, String(i)] as const));
    const { client, calls } = fake(remote);

    const values = await revealSecrets(client, SCOPE, [...remote.keys()]);

    expect(values.size).toBe(250);
    expect(calls.revealMany.map((b) => b!.length)).toEqual([100, 100, 50]);
  });

  it('sends nothing when asked for no keys', async () => {
    const { client, calls } = fake(new Map([['A', '1']]));
    expect(await revealSecrets(client, SCOPE, [])).toEqual(new Map());
    expect(calls.revealMany).toEqual([]);
  });

  it('omits keys the server reports as missing rather than inventing them', async () => {
    const { client } = fake(new Map([['A', '1']]));
    const values = await revealSecrets(client, SCOPE, ['A', 'GONE']);
    expect(values.has('GONE')).toBe(false);
    expect(values.get('A')).toBe('1');
  });

  it('falls back to single reveals against an API without the batch route', async () => {
    // A newer CLI must keep working against a server deployed before this
    // endpoint existed; 404 is that signal.
    const { client, calls } = fake(new Map([['A', '1'], ['B', '2']]), { batchStatus: 404 });

    const values = await revealSecrets(client, SCOPE);

    expect(values).toEqual(new Map([['A', '1'], ['B', '2']]));
    expect(calls.reveal).toEqual(['A', 'B']);
    expect(calls.lists).toBe(1);
  });

  it('propagates a real error instead of quietly falling back', async () => {
    // Falling back on a 429 would turn one rate-limited request into N.
    const { client, calls } = fake(new Map([['A', '1']]), { batchStatus: 429 });

    await expect(revealSecrets(client, SCOPE, ['A'])).rejects.toThrow(/429/);
    expect(calls.reveal).toEqual([]);
  });
});
