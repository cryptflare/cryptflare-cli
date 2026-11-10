import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findRepositories, pendingRepositories } from './auto-onboard.js';
import { MANIFEST_FILENAME } from './project-manifest.js';
import { parseRegistry, type SyncRegistry } from './sync-registry.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-auto-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Creates a git repository (a directory with `.git`) holding the given files. */
function repo(path: string, files: string[] = []): string {
  const dir = join(root, path);
  mkdirSync(join(dir, '.git'), { recursive: true });
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), file === MANIFEST_FILENAME ? '{}' : 'KEY=value\n');
  }
  return dir;
}

function registry(overrides: Partial<SyncRegistry> = {}): SyncRegistry {
  return { version: 1, projects: [], roots: [root], ...overrides };
}

describe('findRepositories', () => {
  it('finds repositories directly under the root and one level of grouping down', () => {
    const a = repo('alpha');
    const b = repo('org/beta');
    expect(findRepositories(root)).toEqual([a, b].sort());
  });

  it('does not look for repositories inside a repository', () => {
    const outer = repo('outer');
    repo('outer/references/vendored');
    expect(findRepositories(root)).toEqual([outer]);
  });

  it('skips dependency and hidden directories', () => {
    repo('node_modules/some-package');
    repo('.cache/thing');
    expect(findRepositories(root)).toEqual([]);
  });

  it('stops at the depth limit', () => {
    repo('a/b/c/d/too-deep');
    expect(findRepositories(root)).toEqual([]);
  });

  it('treats the root itself as a repository when it is one', () => {
    mkdirSync(join(root, '.git'));
    expect(findRepositories(root)).toEqual([root]);
  });
});

describe('pendingRepositories', () => {
  it('does nothing when no roots were named', () => {
    repo('alpha', ['.env']);
    expect(pendingRepositories(registry({ roots: [] }))).toEqual([]);
    expect(pendingRepositories({ version: 1, projects: [] })).toEqual([]);
  });

  it('creates for a repository with env files and no manifest', () => {
    const path = repo('alpha', ['.env', 'apps/api/.dev.vars']);
    expect(pendingRepositories(registry())).toEqual([{ path, action: 'create' }]);
  });

  it('adopts a repository that already carries a manifest, such as a fresh clone', () => {
    const path = repo('alpha', [MANIFEST_FILENAME]);
    expect(pendingRepositories(registry())).toEqual([{ path, action: 'adopt' }]);
  });

  it('leaves alone a repository with nothing to manage', () => {
    repo('alpha', ['README.md', '.env.example']);
    expect(pendingRepositories(registry())).toEqual([]);
  });

  it('skips a repository that is already registered', () => {
    const path = repo('alpha', ['.env']);
    const registered = registry({
      projects: [{ id: 'alpha', path, workspace: 'alpha', enabled: true, bindings: [{ file: '.env', environment: 'root-dev' }] }],
    });
    expect(pendingRepositories(registered)).toEqual([]);
  });

  it('never looks outside the named roots', () => {
    const outside = mkdtempSync(join(tmpdir(), 'cf-auto-outside-'));
    try {
      mkdirSync(join(outside, 'elsewhere', '.git'), { recursive: true });
      writeFileSync(join(outside, 'elsewhere', '.env'), 'KEY=value\n');
      repo('alpha', ['.env']);

      expect(pendingRepositories(registry()).map((p) => p.path)).toEqual([join(root, 'alpha')]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('lists a repository once when two roots both contain it', () => {
    const path = repo('org/alpha', ['.env']);
    expect(pendingRepositories(registry({ roots: [root, join(root, 'org')] }))).toEqual([{ path, action: 'create' }]);
  });
});

describe('registry roots', () => {
  it('keeps absolute roots and drops duplicates', () => {
    const parsed = parseRegistry({ version: 1, projects: [], roots: [root, root] });
    expect(parsed.roots).toEqual([root]);
  });

  it('rejects a relative root, which would mean a different place per working directory', () => {
    expect(() => parseRegistry({ version: 1, projects: [], roots: ['code'] })).toThrow(/absolute/);
  });

  it('has no roots unless some were named', () => {
    expect(parseRegistry({ version: 1, projects: [] }).roots).toBeUndefined();
  });
});
