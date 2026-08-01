import { describe, it, expect } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';

import { ensureScope, seedFromValues } from './provision.js';

const SCOPE = { organisation: 'org_1', workspace: 'ws', environment: 'dev' };

function fake(opts: { workspaces?: string[]; environments?: string[]; secrets?: string[] } = {}) {
  const state = {
    workspaces: [...(opts.workspaces ?? [])],
    environments: [...(opts.environments ?? [])],
    secrets: [...(opts.secrets ?? [])],
  };
  const calls = {
    createdWorkspaces: [] as unknown[],
    createdEnvironments: [] as unknown[],
    batchCreate: [] as string[][],
    batchUpdate: [] as string[][],
  };
  const client = {
    workspaces: {
      list: async () => state.workspaces.map((slug) => ({ slug })),
      create: async (input: { slug: string }) => {
        calls.createdWorkspaces.push(input);
        state.workspaces.push(input.slug);
        return {};
      },
    },
    environments: {
      list: async () => state.environments.map((slug) => ({ slug })),
      create: async (input: { slug: string }) => {
        calls.createdEnvironments.push(input);
        state.environments.push(input.slug);
        return {};
      },
    },
    secrets: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          for (const key of state.secrets) yield { key, version: 1 };
        },
      }),
      batchCreate: async ({ secrets }: { secrets: Array<{ key: string }> }) => {
        calls.batchCreate.push(secrets.map((s) => s.key));
        return { results: [] };
      },
      batchUpdate: async ({ secrets }: { secrets: Array<{ key: string }> }) => {
        calls.batchUpdate.push(secrets.map((s) => s.key));
        return { results: [] };
      },
    },
  };
  return { client: client as unknown as CryptFlare, calls, state };
}

describe('ensureScope', () => {
  it('creates a missing workspace and environment', async () => {
    const { client, calls } = fake();

    const res = await ensureScope(client, SCOPE);

    expect(res).toEqual({ createdWorkspace: true, createdEnvironment: true });
    // Slug and name match the manifest, so the dashboard shows what the
    // manifest says rather than a prettier invented name.
    expect(calls.createdWorkspaces).toEqual([{ organisation: 'org_1', name: 'ws', slug: 'ws' }]);
    expect(calls.createdEnvironments).toEqual([
      { organisation: 'org_1', workspace: 'ws', name: 'dev', slug: 'dev' },
    ]);
  });

  it('is idempotent when both already exist', async () => {
    // Safe to re-run over a half-provisioned project.
    const { client, calls } = fake({ workspaces: ['ws'], environments: ['dev'] });

    expect(await ensureScope(client, SCOPE)).toEqual({
      createdWorkspace: false,
      createdEnvironment: false,
    });
    expect(calls.createdWorkspaces).toEqual([]);
    expect(calls.createdEnvironments).toEqual([]);
  });

  it('adds only the missing environment to an existing workspace', async () => {
    const { client, calls } = fake({ workspaces: ['ws'], environments: ['prod'] });

    const res = await ensureScope(client, SCOPE);

    expect(res).toEqual({ createdWorkspace: false, createdEnvironment: true });
    expect(calls.createdWorkspaces).toEqual([]);
    expect(calls.createdEnvironments).toHaveLength(1);
  });
});

describe('seedFromValues', () => {
  it('splits new keys from existing ones', async () => {
    const { client, calls } = fake({ secrets: ['EXISTING'] });

    const res = await seedFromValues(client, SCOPE, new Map([
      ['EXISTING', 'v2'],
      ['BRAND_NEW', 'v1'],
    ]));

    expect(res).toEqual({ created: 1, updated: 1 });
    expect(calls.batchCreate).toEqual([['BRAND_NEW']]);
    expect(calls.batchUpdate).toEqual([['EXISTING']]);
  });

  it('validates everything before sending anything', async () => {
    // A rejection partway through would leave the environment half-written
    // with no way to tell which keys had landed.
    const { client, calls } = fake();

    await expect(
      seedFromValues(client, SCOPE, new Map([['GOOD', 'v'], ['bad_key', 'v']])),
    ).rejects.toThrow(/nothing pushed/);

    expect(calls.batchCreate).toEqual([]);
    expect(calls.batchUpdate).toEqual([]);
  });

  it('sends nothing for an empty file', async () => {
    const { client, calls } = fake();
    expect(await seedFromValues(client, SCOPE, new Map())).toEqual({ created: 0, updated: 0 });
    expect(calls.batchCreate).toEqual([]);
  });

  it('chunks large sets at the server batch limit', async () => {
    const { client, calls } = fake();
    const values = new Map(Array.from({ length: 250 }, (_, i) => [`K${i}`, 'v'] as const));

    await seedFromValues(client, SCOPE, values);

    expect(calls.batchCreate.map((b) => b.length)).toEqual([100, 100, 50]);
  });
});
