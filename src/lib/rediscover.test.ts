import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';

import { buildManifest, planBindings } from './discover.js';
import { MANIFEST_FILENAME, loadManifest, writeManifest } from './project-manifest.js';
import { newScopeCache } from './provision.js';
import { REDISCOVER_RETRY_MS, findNewBindings, rediscoverProjects } from './rediscover.js';
import { loadRegistry, saveRegistry, type SyncProject, type SyncRegistry } from './sync-registry.js';

let home: string;
let repo: string;
let registryPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cf-rediscover-'));
  repo = join(home, 'shop');
  registryPath = join(home, 'config', 'sync.json');
  mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function touch(...files: string[]): void {
  for (const file of files) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), 'KEY=value\n');
  }
}

/** Sets the repository up the way `cf sync init --create --yes` leaves it. */
function setUp(files: string[]): SyncProject {
  touch(...files);
  const manifest = buildManifest(repo, planBindings(files), { workspace: 'shop' });
  writeManifest(repo, manifest);
  const project: SyncProject = {
    id: 'shop',
    path: repo,
    workspace: 'shop',
    enabled: true,
    bindings: manifest.bindings.map((binding) => ({ file: binding.file, environment: binding.environment! })),
  };
  saveRegistry({ version: 1, projects: [project] }, registryPath);
  return project;
}

const registry = (): SyncRegistry => loadRegistry(registryPath);
const manifestText = () => readFileSync(join(repo, MANIFEST_FILENAME), 'utf-8');

function fakeClient(opts: { environmentLimit?: number; existing?: string[] } = {}) {
  const environments = new Set(opts.existing ?? ['root-dev']);
  const calls = { environmentCreates: 0 };
  const client = {
    billing: { getSubscription: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } },
    workspaces: { list: async () => [{ slug: 'shop' }], create: async () => ({}) },
    environments: {
      list: async () => [...environments].map((slug) => ({ slug })),
      create: async (input: { slug: string }) => {
        calls.environmentCreates++;
        if (opts.environmentLimit !== undefined && environments.size >= opts.environmentLimit) {
          throw Object.assign(new Error('Limit reached for environments.'), { status: 403, code: 'BILLING_PLAN_LIMIT' });
        }
        environments.add(input.slug);
        return {};
      },
    },
  };
  return { client: client as unknown as CryptFlare, calls, environments };
}

describe('findNewBindings', () => {
  it('finds nothing in a repository that has not changed', () => {
    const project = setUp(['.env']);
    expect(findNewBindings(project, registry())).toEqual([]);
  });

  it('finds an env file created after setup, named by the usual rules', () => {
    const project = setUp(['.env']);
    touch('apps/worker/.dev.vars', '.env.production');

    expect(findNewBindings(project, registry())).toEqual([
      { file: '.env.production', workspace: 'shop', environment: 'root-production', capture: 'off', inManifest: false },
      { file: 'apps/worker/.dev.vars', workspace: 'shop', environment: 'worker-dev-worker', capture: 'auto', inManifest: false },
    ]);
  });

  it('never looks in a repository whose manifest was written by hand', () => {
    touch('.env', '.env.production');
    writeFileSync(join(repo, MANIFEST_FILENAME), JSON.stringify({ version: 1, workspace: 'shop', bindings: [{ file: '.env', environment: 'dev' }] }));
    const project: SyncProject = { id: 'shop', path: repo, workspace: 'shop', enabled: true, bindings: [{ file: '.env', environment: 'dev' }] };

    expect(findNewBindings(project, { version: 1, projects: [project] })).toEqual([]);
  });

  it('never looks in a project registered with no manifest at all', () => {
    touch('.env', '.env.production');
    const project: SyncProject = { id: 'shop', path: repo, workspace: 'shop', enabled: true, bindings: [{ file: '.env', environment: 'dev' }] };
    expect(findNewBindings(project, { version: 1, projects: [project] })).toEqual([]);
  });

  it('leaves alone a file the manifest says to ignore', () => {
    const project = setUp(['.env']);
    touch('scratch/.env');
    const raw = JSON.parse(manifestText()) as Record<string, unknown>;
    writeFileSync(join(repo, MANIFEST_FILENAME), JSON.stringify({ ...raw, ignore: ['scratch/.env'] }));

    expect(findNewBindings(project, registry())).toEqual([]);
  });

  it('ignores example files, conflict sidecars and dependency directories', () => {
    const project = setUp(['.env']);
    touch('.env.example', '.env.cf-conflict-2026-07-28T11-04-22-891Z', 'node_modules/pkg/.env');
    expect(findNewBindings(project, registry())).toEqual([]);
  });

  it('registers a file a teammate already added to the manifest, with the names they chose', () => {
    const project = setUp(['.env']);
    touch('apps/web/.env');
    const raw = JSON.parse(manifestText()) as { bindings: unknown[] };
    raw.bindings.push({ file: 'apps/web/.env', environment: 'storefront' });
    writeFileSync(join(repo, MANIFEST_FILENAME), JSON.stringify(raw));

    expect(findNewBindings(project, registry())).toEqual([
      { file: 'apps/web/.env', workspace: 'shop', environment: 'storefront', capture: 'auto', inManifest: true },
    ]);
  });

  it('leaves alone a file another registered project already binds', () => {
    const project = setUp(['.env']);
    touch('apps/web/.env');
    const other: SyncProject = { id: 'web', path: repo, workspace: 'web', enabled: true, bindings: [{ file: 'apps/web/.env', environment: 'dev' }] };

    expect(findNewBindings(project, { version: 1, projects: [project, other] })).toEqual([]);
  });

  it('says nothing while the manifest is broken mid-edit', () => {
    const project = setUp(['.env']);
    touch('.env.production');
    writeFileSync(join(repo, MANIFEST_FILENAME), '{ "version": 1, ');
    expect(findNewBindings(project, registry())).toEqual([]);
  });
});

describe('rediscoverProjects', () => {
  it('creates the environment, appends the binding and registers it', async () => {
    const project = setUp(['.env']);
    touch('apps/worker/.dev.vars');
    const { client, environments } = fakeClient();

    const [report] = await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache() });

    expect(report?.added.map((binding) => binding.file)).toEqual(['apps/worker/.dev.vars']);
    expect(environments.has('worker-dev-worker')).toBe(true);
    expect(loadManifest(repo).bindings.map((b) => [b.file, b.environment, b.capture])).toEqual([
      ['.env', 'root-dev', 'auto'],
      ['apps/worker/.dev.vars', 'worker-dev-worker', 'auto'],
    ]);
    expect(registry().projects[0]?.bindings).toEqual([
      { file: '.env', environment: 'root-dev' },
      { file: 'apps/worker/.dev.vars', environment: 'worker-dev-worker' },
    ]);
  });

  it('binds a new production file with capture off, so its keys are not uploaded', async () => {
    const project = setUp(['.env']);
    touch('.env.production');
    const { client } = fakeClient();

    await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache() });

    const added = loadManifest(repo).bindings.find((binding) => binding.file === '.env.production');
    expect(added).toMatchObject({ environment: 'root-production', capture: 'off' });
  });

  it('keeps a binding a person edited exactly as they left it', async () => {
    const project = setUp(['.env']);
    const raw = JSON.parse(manifestText()) as { bindings: Array<Record<string, unknown>> };
    raw.bindings[0] = { file: '.env', environment: 'my-name', capture: 'prompt' };
    writeFileSync(join(repo, MANIFEST_FILENAME), JSON.stringify(raw, null, 2));
    touch('.env.local');
    const { client } = fakeClient({ existing: ['my-name'] });

    await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache() });

    const after = JSON.parse(manifestText()) as { bindings: unknown[] };
    expect(after.bindings[0]).toEqual({ file: '.env', environment: 'my-name', capture: 'prompt' });
    expect(after.bindings).toHaveLength(2);
    // The registry entry for the existing file is not rewritten either.
    expect(registry().projects[0]?.bindings[0]).toEqual({ file: '.env', environment: 'root-dev' });
  });

  it('does nothing on a second pass', async () => {
    const project = setUp(['.env']);
    touch('.env.production');
    const { client } = fakeClient();
    await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache() });
    const before = manifestText();

    const again = await rediscoverProjects(client, registry().projects, { registryPath, scopeCache: newScopeCache() });

    expect(again).toEqual([]);
    expect(manifestText()).toBe(before);
  });

  it('writes nothing for a file the plan has no room for, and does not ask again within the hour', async () => {
    const project = setUp(['.env']);
    touch('.env.production');
    const before = manifestText();
    const { client, calls } = fakeClient({ environmentLimit: 1 });
    const retryAt = new Map<string, number>();
    const now = 1_000_000;

    const [report] = await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache(), retryAt, now });
    expect(report?.added).toEqual([]);
    expect(report?.refused.map((item) => [item.file, item.resource])).toEqual([['.env.production', 'environments']]);
    expect(manifestText()).toBe(before);
    expect(registry().projects[0]?.bindings).toHaveLength(1);

    // Every later pass inside the hour: no report, no request.
    for (let pass = 1; pass <= 5; pass++) {
      expect(await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache(), retryAt, now: now + pass * 60_000 })).toEqual([]);
    }
    expect(calls.environmentCreates).toBe(1);

    // After the hour it is tried once more, in case the plan changed.
    await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache(), retryAt, now: now + REDISCOVER_RETRY_MS });
    expect(calls.environmentCreates).toBe(2);
  });

  it('binds what fits and reports the rest', async () => {
    const project = setUp(['.env']);
    touch('.env.production', 'apps/worker/.dev.vars');
    const { client } = fakeClient({ environmentLimit: 2 });

    const [report] = await rediscoverProjects(client, [project], { registryPath, scopeCache: newScopeCache() });

    expect(report?.added.map((binding) => binding.file)).toEqual(['.env.production']);
    expect(report?.refused.map((binding) => binding.file)).toEqual(['apps/worker/.dev.vars']);
    expect(registry().projects[0]?.bindings.map((binding) => binding.file)).toEqual(['.env', '.env.production']);
  });
});
