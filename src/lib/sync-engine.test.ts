/**
 * Engine tests drive a fake SDK client against real files in a temp dir.
 * The interesting behaviour is entirely in the decisions - which side wins,
 * what is refused - so the tests assert on plans and on file contents rather
 * than on how many HTTP calls happened.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';

import { applyPlan, planBinding, type SyncAction } from './sync-engine.js';
import type { SyncBinding, SyncProject } from './sync-registry.js';
import { emptyState, type SyncState } from './sync-state.js';

type RemoteSecret = { value: string; version: number };

/** Minimal stand-in for the parts of the SDK the engine touches. */
function fakeClient(remote: Map<string, RemoteSecret>) {
  const calls = { reveals: [] as string[], revealMany: 0, rotates: [] as string[], batchUpdates: 0, lists: 0 };
  const client = {
    secrets: {
      list: () => {
        calls.lists++;
        return {
          async *[Symbol.asyncIterator]() {
            for (const [key, { version }] of remote) yield { key, version };
          },
        };
      },
      reveal: async ({ key }: { key: string }) => {
        calls.reveals.push(key);
        const hit = remote.get(key);
        if (!hit) throw new Error(`no such secret ${key}`);
        return { key, value: hit.value, version: hit.version };
      },
      // Mirrors the real batch endpoint: the engine reaches for this first,
      // and `calls.revealMany` is what proves it is not looping single reveals.
      revealMany: async ({ keys }: { keys?: string[] }) => {
        calls.revealMany++;
        const wanted = keys ?? [...remote.keys()];
        const secrets = wanted
          .filter((k) => remote.has(k))
          .map((k) => ({ key: k, value: remote.get(k)!.value, version: remote.get(k)!.version }));
        return {
          secrets,
          missing: wanted.filter((k) => !remote.has(k)),
          encoding: 'utf-8' as const,
        };
      },
      rotate: async ({ key, value }: { key: string; value: string }) => {
        calls.rotates.push(key);
        const prev = remote.get(key);
        remote.set(key, { value, version: (prev?.version ?? 0) + 1 });
        return { key };
      },
      batchUpdate: async ({ secrets }: { secrets: Array<{ key: string; value: string }> }) => {
        calls.batchUpdates++;
        for (const { key, value } of secrets) {
          const prev = remote.get(key);
          remote.set(key, { value, version: (prev?.version ?? 0) + 1 });
        }
        return { results: [] };
      },
    },
  };
  return { client: client as unknown as CryptFlare, calls };
}

let dir: string;
let project: SyncProject;
const binding: SyncBinding = { file: '.env', environment: 'dev' };
let state: SyncState;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-sync-'));
  project = { id: 'proj', path: dir, org: 'org_1', workspace: 'ws', enabled: true, bindings: [binding] };
  state = emptyState();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const envPath = () => join(dir, '.env');
const writeEnv = (body: string) => writeFileSync(envPath(), body);
const readEnv = () => readFileSync(envPath(), 'utf-8');
const typesOf = (actions: SyncAction[]) => actions.map((a) => `${a.type}:${a.key}`).sort();

describe('planBinding', () => {
  it('pulls everything into a file that does not exist yet', async () => {
    const { client } = fakeClient(new Map([['A', { value: '1', version: 1 }]]));
    const plan = await planBinding(client, project, binding, state);
    expect(plan.creating).toBe(true);
    expect(typesOf(plan.actions)).toEqual(['pull:A']);
  });

  it('does nothing when both sides match the recorded baseline', async () => {
    const { client } = fakeClient(new Map([['A', { value: '1', version: 1 }]]));
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    const second = await planBinding(client, project, binding, state);
    expect(second.actions).toEqual([]);
  });

  it('pulls when the remote version advanced', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    remote.set('A', { value: '2', version: 2 });
    expect(typesOf((await planBinding(client, project, binding, state)).actions)).toEqual(['pull:A']);
  });

  it('pushes when the local value changed', async () => {
    const { client } = fakeClient(new Map([['A', { value: '1', version: 1 }]]));
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    writeEnv('A=local-edit\n');
    expect(typesOf((await planBinding(client, project, binding, state)).actions)).toEqual(['push:A']);
  });

  it('flags a conflict when both sides moved', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    remote.set('A', { value: 'remote-edit', version: 2 });
    writeEnv('A=local-edit\n');
    expect(typesOf((await planBinding(client, project, binding, state)).actions)).toEqual(['conflict:A']);
  });

  it('decrypts nothing when planning with reveal disabled', async () => {
    // `cf sync status` is a dry run. Reveal is limited to 30/min per
    // credential, and first-contact adoption across a dozen freshly
    // registered files exhausted it, so status failed instead of reporting.
    const { client, calls } = fakeClient(new Map([
      ['A', { value: '1', version: 1 }],
      ['B', { value: '2', version: 1 }],
    ]));
    writeEnv('A=1\nB=2\n');

    const plan = await planBinding(client, project, binding, state, { reveal: false });

    expect(calls.reveals).toEqual([]);
    expect(typesOf(plan.actions)).toEqual(['needs-compare:A', 'needs-compare:B']);
  });

  it('still compares by default, so `cf sync run` is unchanged', async () => {
    const { client, calls } = fakeClient(new Map([['A', { value: '1', version: 1 }]]));
    writeEnv('A=1\n');

    const plan = await planBinding(client, project, binding, state);

    // One batch request, not one per key.
    expect(calls.revealMany).toBe(1);
    expect(calls.reveals).toEqual([]);
    expect(plan.actions).toEqual([]);
  });

  it('refuses to apply a plan whose keys were never compared', async () => {
    // Applying it would rebaseline unverified keys as if they agreed, hiding
    // a real divergence for good.
    const { client } = fakeClient(new Map([['A', { value: 'remote', version: 1 }]]));
    writeEnv('A=local\n');

    const plan = await planBinding(client, project, binding, state, { reveal: false });

    await expect(applyPlan(client, plan, state)).rejects.toThrow(/never compared/);
  });

  it('never auto-creates a key that is new to the local file', async () => {
    const { client } = fakeClient(new Map([['A', { value: '1', version: 1 }]]));
    writeEnv('A=1\nSCRATCH=nope\n');
    const plan = await planBinding(client, project, binding, state);
    expect(typesOf(plan.actions)).toEqual(['skip-new-local:SCRATCH']);
  });

  it('adopts an existing file silently when the values already match', async () => {
    // Registering a project whose .env was already pushed must not report a
    // conflict on every key just because there is no merge base yet.
    const { client } = fakeClient(new Map([['A', { value: '1', version: 7 }]]));
    writeEnv('A=1\n');
    expect((await planBinding(client, project, binding, state)).actions).toEqual([]);
  });

  it('reports a conflict on first contact when the values genuinely differ', async () => {
    const { client } = fakeClient(new Map([['A', { value: 'remote', version: 1 }]]));
    writeEnv('A=local\n');
    expect(typesOf((await planBinding(client, project, binding, state)).actions)).toEqual(['conflict:A']);
  });

  it('does not re-reveal an adopted key when the plan is applied', async () => {
    const { client, calls } = fakeClient(new Map([['A', { value: 'remote', version: 1 }]]));
    writeEnv('A=local\n');
    const plan = await planBinding(client, project, binding, state);
    expect(calls.revealMany).toBe(1);
    await applyPlan(client, plan, state);
    // Applying reuses what planning already decrypted: still one request,
    // and no second audit entry for the same key.
    expect(calls.revealMany).toBe(1);
  });

  it('does not manage multi-line values', async () => {
    const { client } = fakeClient(new Map());
    writeEnv('PRIVATE_KEY="-----BEGIN\nstill going\n');
    const plan = await planBinding(client, project, binding, state);
    expect(typesOf(plan.actions)).toContain('skip-multiline:PRIVATE_KEY');
  });
});

describe('applyPlan', () => {
  it('creates the file with remote values, mode 0600', async () => {
    const { client } = fakeClient(new Map([['A', { value: '1', version: 1 }]]));
    await applyPlan(client, await planBinding(client, project, binding, state), state);
    expect(readEnv()).toContain('A=1');
  });

  it('merges pulled values into an existing file without losing comments', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client } = fakeClient(remote);
    writeEnv('# keep me\nA=1\nLOCAL_ONLY=stays\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    remote.set('A', { value: '2', version: 2 });
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    const body = readEnv();
    expect(body).toContain('# keep me');
    expect(body).toContain('A=2');
    expect(body).toContain('LOCAL_ONLY=stays');
  });

  it('pushes a changed local value up as a new version', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client, calls } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    writeEnv('A=local-edit\n');
    const result = await applyPlan(client, await planBinding(client, project, binding, state), state);

    expect(result.pushed).toEqual(['A']);
    expect(remote.get('A')).toEqual({ value: 'local-edit', version: 2 });
    expect(calls.rotates).toEqual(['A']);
  });

  it('batches multiple pushes into one call', async () => {
    const remote = new Map([
      ['A', { value: '1', version: 1 }],
      ['B', { value: '2', version: 1 }],
    ]);
    const { client, calls } = fakeClient(remote);
    writeEnv('A=1\nB=2\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    writeEnv('A=x\nB=y\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    expect(calls.batchUpdates).toBe(1);
    expect(calls.rotates).toEqual([]);
  });

  it('honours pull-only mode', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    writeEnv('A=local-edit\n');
    const result = await applyPlan(client, await planBinding(client, project, binding, state), state, { push: false });

    expect(result.pushed).toEqual([]);
    expect(remote.get('A')?.value).toBe('1');
  });

  it('resolves a conflict remote-wins and preserves the local value on disk', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    remote.set('A', { value: 'remote-edit', version: 2 });
    writeEnv('A=local-edit\n');
    const result = await applyPlan(client, await planBinding(client, project, binding, state), state);

    expect(result.conflicts).toEqual(['A']);
    expect(readEnv()).toContain('A=remote-edit');
    const sidecar = readdirSync(dir).find((f) => f.includes('.cf-conflict-'));
    expect(sidecar).toBeDefined();
    expect(readFileSync(join(dir, sidecar!), 'utf-8')).toContain('A=local-edit');
  });

  it('costs one list call per idle pass, and re-lists only after a push', async () => {
    // The service polls for weeks. A steady-state pass that re-listed twice
    // would double the API spend for no information.
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client, calls } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    calls.lists = 0;
    await applyPlan(client, await planBinding(client, project, binding, state), state);
    expect(calls.lists).toBe(1);

    calls.lists = 0;
    writeEnv('A=pushed\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);
    expect(calls.lists).toBe(2);

    // And the post-push baseline must be the version the push produced, or the
    // next pass would read its own write as an incoming remote change.
    expect((await planBinding(client, project, binding, state)).actions).toEqual([]);
  });

  it('only reveals the keys that actually changed', async () => {
    const remote = new Map([
      ['A', { value: '1', version: 1 }],
      ['B', { value: '2', version: 1 }],
    ]);
    const { client, calls } = fakeClient(remote);
    writeEnv('A=1\nB=2\n');
    // Establish the merge base first; without this both keys are first
    // contact on the next pass and the assertion below is meaningless.
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    const revealed: string[][] = [];
    const origRevealMany = (client.secrets as unknown as { revealMany: (i: { keys?: string[] }) => unknown }).revealMany;
    (client.secrets as unknown as { revealMany: (i: { keys?: string[] }) => unknown }).revealMany = (input) => {
      revealed.push(input.keys ?? ['(all)']);
      return origRevealMany(input);
    };

    remote.set('B', { value: '3', version: 2 });
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    // Only the changed key is decrypted - batching must not turn into
    // "fetch everything every pass".
    expect(revealed).toEqual([['B']]);
  });

  it('does not re-add a key the developer deleted locally', async () => {
    const remote = new Map([
      ['A', { value: '1', version: 1 }],
      ['B', { value: '2', version: 1 }],
    ]);
    const { client } = fakeClient(remote);
    writeEnv('A=1\nB=2\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);
    expect(readEnv()).not.toContain('B=');

    // And it stays gone on the pass after that - the tombstone must survive
    // re-baselining, otherwise the deletion ping-pongs forever.
    const third = await planBinding(client, project, binding, state);
    expect(typesOf(third.actions)).toEqual(['skip-local-deleted:B']);
    await applyPlan(client, third, state);
    expect(readEnv()).not.toContain('B=');
  });

  it('does not delete a local line when the secret disappears remotely', async () => {
    const remote = new Map([['A', { value: '1', version: 1 }]]);
    const { client } = fakeClient(remote);
    writeEnv('A=1\n');
    await applyPlan(client, await planBinding(client, project, binding, state), state);

    remote.delete('A');
    const plan = await planBinding(client, project, binding, state);
    expect(typesOf(plan.actions)).toEqual(['skip-remote-deleted:A']);
    await applyPlan(client, plan, state);
    expect(readEnv()).toContain('A=1');
  });

  it('reaches a fixed point - a second pass over an unchanged pair is a no-op', async () => {
    const { client } = fakeClient(new Map([['A', { value: 'has spaces', version: 1 }]]));
    await applyPlan(client, await planBinding(client, project, binding, state), state);
    const before = readEnv();

    const second = await planBinding(client, project, binding, state);
    expect(second.actions).toEqual([]);
    await applyPlan(client, second, state);
    expect(readEnv()).toBe(before);
  });
});
