import { describe, expect, it, vi } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';

import { fingerprint, generateSecretValue, MAX_GENERATED_BYTES, MIN_GENERATED_BYTES } from './generate.js';
import { upsertAcrossEnvironments, upsertSecret } from './secret-write.js';

const SCOPE = { organisation: 'org_1', workspace: 'api', environment: 'dev' };

function conflict(): Error {
  return Object.assign(new Error('Key already exists in this environment'), { status: 409 });
}

function fakeClient(overrides: { create?: ReturnType<typeof vi.fn>; rotate?: ReturnType<typeof vi.fn> } = {}) {
  const create = overrides.create ?? vi.fn(async ({ key }: { key: string }) => ({ key, version: 1 }));
  const rotate = overrides.rotate ?? vi.fn(async ({ key }: { key: string }) => ({ key, version: 2 }));
  return { client: { secrets: { create, rotate } } as unknown as CryptFlare, create, rotate };
}

describe('upsertSecret', () => {
  it('creates a key that does not exist yet', async () => {
    const { client, rotate } = fakeClient();
    const write = await upsertSecret(client, SCOPE, 'API_KEY', 'v');

    expect(write).toEqual({ environment: 'dev', key: 'API_KEY', version: 1, action: 'created' });
    expect(rotate).not.toHaveBeenCalled();
  });

  it('rotates when the key already exists', async () => {
    const { client, rotate } = fakeClient({ create: vi.fn(async () => { throw conflict(); }) });
    const write = await upsertSecret(client, SCOPE, 'API_KEY', 'v2');

    expect(write).toEqual({ environment: 'dev', key: 'API_KEY', version: 2, action: 'rotated' });
    expect(rotate).toHaveBeenCalledWith({ ...SCOPE, key: 'API_KEY', value: 'v2' });
  });

  it('passes pod and description on create only', async () => {
    const { client, create } = fakeClient();
    await upsertSecret(client, { ...SCOPE, podId: 'pod_1' }, 'API_KEY', 'v', { description: 'Stripe key' });

    expect(create).toHaveBeenCalledWith({ ...SCOPE, podId: 'pod_1', key: 'API_KEY', value: 'v', description: 'Stripe key' });
  });

  it('does not rotate on an error that is not a conflict', async () => {
    const denied = Object.assign(new Error('Insufficient permissions'), { status: 403 });
    const { client, rotate } = fakeClient({ create: vi.fn(async () => { throw denied; }) });

    await expect(upsertSecret(client, SCOPE, 'API_KEY', 'v')).rejects.toThrow('Insufficient permissions');
    expect(rotate).not.toHaveBeenCalled();
  });
});

describe('upsertAcrossEnvironments', () => {
  it('writes the same value to every environment', async () => {
    const { client, create } = fakeClient();
    const result = await upsertAcrossEnvironments(
      client,
      { organisation: 'org_1', workspace: 'api' },
      ['dev', 'production'],
      'API_KEY',
      'v',
    );

    expect(result.written.map((w) => w.environment)).toEqual(['dev', 'production']);
    expect(create.mock.calls.map(([input]) => (input as { value: string }).value)).toEqual(['v', 'v']);
  });

  it('carries on past an environment that refuses the write and reports it', async () => {
    const create = vi.fn(async ({ environment, key }: { environment: string; key: string }) => {
      if (environment === 'production') throw Object.assign(new Error('Secret is locked'), { status: 423 });
      return { key, version: 1 };
    });
    const { client } = fakeClient({ create });

    const result = await upsertAcrossEnvironments(
      client,
      { organisation: 'org_1', workspace: 'api' },
      ['production', 'dev'],
      'API_KEY',
      'v',
    );

    expect(result.written.map((w) => w.environment)).toEqual(['dev']);
    expect(result.failed).toEqual([{ environment: 'production', message: 'Secret is locked' }]);
  });
});

describe('generateSecretValue', () => {
  it('returns a different value every time', () => {
    expect(generateSecretValue()).not.toBe(generateSecretValue());
  });

  it('uses only characters that are safe unquoted in an env file', () => {
    expect(generateSecretValue(64)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('encodes the requested number of bytes', () => {
    expect(Buffer.from(generateSecretValue(48), 'base64url')).toHaveLength(48);
  });

  it('rejects sizes outside the supported range', () => {
    expect(() => generateSecretValue(MIN_GENERATED_BYTES - 1)).toThrow(RangeError);
    expect(() => generateSecretValue(MAX_GENERATED_BYTES + 1)).toThrow(RangeError);
    expect(() => generateSecretValue(Number.NaN)).toThrow(RangeError);
  });
});

describe('fingerprint', () => {
  it('is stable for one value and differs between values', async () => {
    expect(await fingerprint('a')).toBe(await fingerprint('a'));
    expect(await fingerprint('a')).not.toBe(await fingerprint('b'));
  });

  it('does not contain the value', async () => {
    expect(await fingerprint('hunter2')).not.toContain('hunter2');
  });
});
