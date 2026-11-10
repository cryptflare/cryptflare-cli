/**
 * Local MCP tools against a fake API and real files in a temp directory.
 *
 * The property under test throughout: whatever a tool does, the secret
 * values involved never appear in what it returns.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';

import { MANIFEST_FILENAME } from '../project-manifest.js';
import { emptyRegistry } from '../sync-registry.js';
import { emptyState, type SyncState } from '../sync-state.js';

import type { McpTool } from './protocol.js';
import { buildTools } from './tools.js';

type RemoteSecret = { value: string; version: number };
type Remote = Map<string, Map<string, RemoteSecret>>;

/** A fake API holding secrets per environment, shaped like the SDK the tools call. */
function fakeClient(remote: Remote) {
  const environment = (name: string) => {
    let secrets = remote.get(name);
    if (!secrets) {
      secrets = new Map();
      remote.set(name, secrets);
    }
    return secrets;
  };

  const client = {
    secrets: {
      list: ({ environment: env }: { environment: string }) => ({
        async *[Symbol.asyncIterator]() {
          for (const [key, { version }] of environment(env)) yield { key, version };
        },
      }),
      revealMany: async ({ environment: env, keys }: { environment: string; keys?: string[] }) => {
        const secrets = environment(env);
        const wanted = keys ?? [...secrets.keys()];
        return {
          secrets: wanted.filter((k) => secrets.has(k)).map((k) => ({ key: k, ...secrets.get(k)! })),
          missing: wanted.filter((k) => !secrets.has(k)),
          encoding: 'utf-8' as const,
          nextCursor: null,
        };
      },
      create: async ({ environment: env, key, value }: { environment: string; key: string; value: string }) => {
        const secrets = environment(env);
        if (secrets.has(key)) throw Object.assign(new Error('Key already exists'), { status: 409 });
        secrets.set(key, { value, version: 1 });
        return { key, version: 1 };
      },
      rotate: async ({ environment: env, key, value }: { environment: string; key: string; value: string }) => {
        const secrets = environment(env);
        const version = (secrets.get(key)?.version ?? 0) + 1;
        secrets.set(key, { value, version });
        return { key, version };
      },
      batchCreate: async ({ environment: env, secrets: items }: { environment: string; secrets: Array<{ key: string; value: string }> }) => {
        const secrets = environment(env);
        const results = items.map(({ key, value }) => {
          if (secrets.has(key)) return { key, status: 'skipped', reason: 'already_exists' };
          secrets.set(key, { value, version: 1 });
          return { key, status: 'created', version: 1 };
        });
        return { status: 'completed', results };
      },
      batchUpdate: async ({ environment: env, secrets: items }: { environment: string; secrets: Array<{ key: string; value: string }> }) => {
        const secrets = environment(env);
        const results = items.map(({ key, value }) => {
          const version = (secrets.get(key)?.version ?? 0) + 1;
          secrets.set(key, { value, version });
          return { key, status: 'updated', version };
        });
        return { status: 'completed', results };
      },
    },
  };
  return client as unknown as CryptFlare;
}

let dir: string;
let remote: Remote;
let state: SyncState;
let tools: Map<string, McpTool>;

function writeManifest(extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify({
    version: 1,
    id: 'proj',
    org: 'org_1',
    workspace: 'api',
    bindings: [{ file: '.env', environment: 'dev' }],
    ...extra,
  }));
}

function setUp(cwd: string = dir): void {
  tools = new Map(buildTools({
    client: fakeClient(remote),
    cwd,
    loadRegistry: emptyRegistry,
    loadState: () => state,
    saveState: (next) => { state = next; },
  }).map((tool) => [tool.name, tool]));
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return (await tool.run(args)) as Record<string, unknown>;
}

const envPath = () => join(dir, '.env');
const readEnv = () => readFileSync(envPath(), 'utf-8');
const stored = (environment: string, key: string) => remote.get(environment)?.get(key);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-mcp-'));
  remote = new Map();
  state = emptyState();
  writeManifest();
  setUp();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('tool set', () => {
  it('offers no tool that reveals a value', () => {
    expect([...tools.keys()].sort()).toEqual([
      'project_status',
      'secret_capture',
      'secret_generate',
      'secret_list',
      'secrets_sync',
    ]);
  });

  it('declares an object input schema on every tool', () => {
    for (const tool of tools.values()) expect(tool.inputSchema['type']).toBe('object');
  });
});

describe('secret_generate', () => {
  it('stores a generated value and writes it into the bound file', async () => {
    const result = await call('secret_generate', { key: 'SESSION_SECRET' });

    const value = stored('dev', 'SESSION_SECRET')?.value ?? '';
    expect(value.length).toBeGreaterThan(20);
    expect(readEnv()).toContain(`SESSION_SECRET=${value}`);
    expect(result).toMatchObject({ key: 'SESSION_SECRET', localFile: '.env', failed: [] });
  });

  it('never returns the generated value', async () => {
    const result = await call('secret_generate', { key: 'SESSION_SECRET' });

    const value = stored('dev', 'SESSION_SECRET')?.value ?? '';
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it('stores one value across several environments', async () => {
    const result = await call('secret_generate', { key: 'API_KEY', environments: ['dev', 'production'] });

    expect(stored('dev', 'API_KEY')?.value).toBe(stored('production', 'API_KEY')?.value);
    expect(result['stored']).toHaveLength(2);
  });

  it('leaves the local file alone when its environment was not written', async () => {
    const result = await call('secret_generate', { key: 'API_KEY', environments: ['production'] });

    expect(result['localFile']).toBeNull();
    expect(stored('dev', 'API_KEY')).toBeUndefined();
  });

  it('rotates an existing key instead of failing', async () => {
    remote.set('dev', new Map([['API_KEY', { value: 'old', version: 3 }]]));

    const result = await call('secret_generate', { key: 'API_KEY' });

    expect(stored('dev', 'API_KEY')?.version).toBe(4);
    expect(result['stored']).toEqual([{ environment: 'dev', key: 'API_KEY', version: 4, action: 'rotated' }]);
  });

  it('rejects a key that is not UPPER_SNAKE_CASE before generating anything', async () => {
    await expect(call('secret_generate', { key: 'session secret' })).rejects.toThrow(/UPPER_SNAKE_CASE/);
    expect(remote.size).toBe(0);
  });

  it('rejects a size too small to be a secret', async () => {
    await expect(call('secret_generate', { key: 'WEAK', bytes: 4 })).rejects.toThrow(RangeError);
  });
});

describe('secret_capture', () => {
  it('stores a key that is in the file but not in CryptFlare, without returning its value', async () => {
    writeFileSync(envPath(), 'STRIPE_SECRET_KEY=sk_live_pasted_by_the_user\n');

    const result = await call('secret_capture');

    expect(stored('dev', 'STRIPE_SECRET_KEY')?.value).toBe('sk_live_pasted_by_the_user');
    expect(result['created']).toEqual(['STRIPE_SECRET_KEY']);
    expect(JSON.stringify(result)).not.toContain('sk_live_pasted_by_the_user');
  });

  it('captures only the keys it was asked for', async () => {
    writeFileSync(envPath(), 'WANTED_KEY=a\nSCRATCH_KEY=b\n');

    const result = await call('secret_capture', { keys: ['WANTED_KEY'] });

    expect(result['created']).toEqual(['WANTED_KEY']);
    expect(stored('dev', 'SCRATCH_KEY')).toBeUndefined();
  });

  it('works even when the binding is configured with capture off', async () => {
    writeManifest({ capture: 'off' });
    writeFileSync(envPath(), 'NEW_KEY=value\n');

    const result = await call('secret_capture');

    expect(result['created']).toEqual(['NEW_KEY']);
  });

  it('says so when an asked-for key is not new', async () => {
    remote.set('dev', new Map([['EXISTING_KEY', { value: 'same', version: 1 }]]));
    writeFileSync(envPath(), 'EXISTING_KEY=same\n');

    const result = await call('secret_capture', { keys: ['EXISTING_KEY'] });

    expect(result['created']).toEqual([]);
    expect(result['notNew']).toEqual(['EXISTING_KEY']);
  });

  it('reports a key the server would reject, with the reason', async () => {
    writeFileSync(envPath(), 'EMPTY_KEY=\n');

    const result = await call('secret_capture');

    expect(result['skipped']).toEqual([
      expect.objectContaining({ key: 'EMPTY_KEY', why: 'skip-invalid-local' }),
    ]);
  });

  it('fails clearly when the file does not exist', async () => {
    await expect(call('secret_capture')).rejects.toThrow(/does not exist/);
  });
});

describe('secrets_sync', () => {
  it('fills in a missing env file from CryptFlare without returning values', async () => {
    remote.set('dev', new Map([['DATABASE_URL', { value: 'postgres://secret-host/db', version: 2 }]]));

    const result = await call('secrets_sync');

    expect(readEnv()).toContain('DATABASE_URL=postgres://secret-host/db');
    expect(JSON.stringify(result)).not.toContain('secret-host');
    expect(result['bindings']).toEqual([expect.objectContaining({ file: '.env', pulledIntoFile: ['DATABASE_URL'] })]);
  });

  it('follows the capture mode of the binding for new local keys', async () => {
    writeFileSync(envPath(), 'NEW_KEY=value\n');

    await call('secrets_sync');
    expect(stored('dev', 'NEW_KEY')).toBeUndefined();

    writeManifest({ capture: 'auto' });
    await call('secrets_sync');
    expect(stored('dev', 'NEW_KEY')?.value).toBe('value');
  });
});

describe('project_status', () => {
  it('reports bindings and pending key names without decrypting or returning values', async () => {
    remote.set('dev', new Map([['REMOTE_ONLY', { value: 'remote-value', version: 1 }]]));
    writeFileSync(envPath(), 'LOCAL_ONLY=local-value\n');

    const result = await call('project_status');

    expect(result).toMatchObject({
      project: 'proj',
      bindings: [{
        file: '.env',
        scope: 'api/dev',
        capture: 'off',
        fileExists: true,
        pending: { pull: ['REMOTE_ONLY'], 'skip-new-local': ['LOCAL_ONLY'] },
      }],
    });
    expect(JSON.stringify(result)).not.toMatch(/remote-value|local-value/);
  });
});

describe('secret_list', () => {
  it('lists key names and versions only', async () => {
    remote.set('dev', new Map([
      ['B_KEY', { value: 'b-value', version: 2 }],
      ['A_KEY', { value: 'a-value', version: 1 }],
    ]));

    const result = await call('secret_list');

    expect(result['secrets']).toEqual([{ key: 'A_KEY', version: 1 }, { key: 'B_KEY', version: 2 }]);
    expect(JSON.stringify(result)).not.toMatch(/a-value|b-value/);
  });
});

describe('project resolution', () => {
  it('uses the bound file nearest the working directory', async () => {
    writeManifest({
      bindings: [
        { file: '.env', environment: 'dev' },
        { file: 'apps/api/.dev.vars', environment: 'api-dev' },
      ],
    });
    mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
    setUp(join(dir, 'apps', 'api'));

    const result = await call('secret_list');

    expect(result).toMatchObject({ file: 'apps/api/.dev.vars', scope: 'api/api-dev' });
  });

  it('means the development file when .env sits beside .env.production', async () => {
    writeManifest({
      bindings: [
        { file: '.env.production', environment: 'production' },
        { file: '.env', environment: 'dev' },
      ],
    });
    setUp();

    await call('secret_generate', { key: 'SESSION_SECRET' });

    expect(stored('dev', 'SESSION_SECRET')).toBeDefined();
    expect(stored('production', 'SESSION_SECRET')).toBeUndefined();
  });

  it('explains what to do outside a CryptFlare project', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cf-mcp-outside-'));
    try {
      setUp(outside);
      await expect(call('secret_list')).rejects.toThrow(/not inside a CryptFlare project/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
