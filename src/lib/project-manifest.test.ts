import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MANIFEST_FILENAME,
  ManifestError,
  hasManifest,
  loadManifest,
  parseManifest,
  renderManifest,
  writeManifest,
} from './project-manifest.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-manifest-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const monorepo = {
  version: 1,
  id: 'peak-physique',
  environment: 'dev',
  bindings: [
    { file: 'apps/api/.dev.vars', workspace: 'peak-physique-api' },
    { file: 'apps/web/.env', workspace: 'peak-physique-web' },
    { file: 'apps/blog/.env', workspace: 'peak-physique-blog', environment: 'prod' },
  ],
};

describe('parseManifest', () => {
  it('resolves per-binding workspace with a shared environment default', () => {
    const m = parseManifest(monorepo);
    expect(m.bindings).toEqual([
      { file: 'apps/api/.dev.vars', workspace: 'peak-physique-api', environment: 'dev' },
      { file: 'apps/web/.env', workspace: 'peak-physique-web', environment: 'dev' },
      { file: 'apps/blog/.env', workspace: 'peak-physique-blog', environment: 'prod' },
    ]);
  });

  it('lets a top-level workspace cover every binding', () => {
    const m = parseManifest({
      version: 1,
      workspace: 'solo',
      environment: 'dev',
      bindings: [{ file: '.env' }, { file: '.env.local', environment: 'dev-local' }],
    });
    expect(m.bindings[0]).toEqual({ file: '.env', workspace: 'solo', environment: 'dev' });
    expect(m.bindings[1]).toEqual({ file: '.env.local', workspace: 'solo', environment: 'dev-local' });
  });

  it('carries a pod through', () => {
    const m = parseManifest({
      version: 1,
      workspace: 'w',
      environment: 'dev',
      bindings: [{ file: '.env', pod: 'api' }],
    });
    expect(m.bindings[0]!.pod).toBe('api');
  });

  it('rejects an unknown version rather than guessing', () => {
    expect(() => parseManifest({ ...monorepo, version: 2 })).toThrow(ManifestError);
  });

  it('rejects an absolute path - the manifest is committed and runs on every clone', () => {
    expect(() =>
      parseManifest({ version: 1, workspace: 'w', environment: 'e', bindings: [{ file: '/etc/passwd' }] }),
    ).toThrow(/relative path/);
  });

  it('rejects a path escaping the project root', () => {
    expect(() =>
      parseManifest({ version: 1, workspace: 'w', environment: 'e', bindings: [{ file: '../../.ssh/config' }] }),
    ).toThrow(/relative path/);
  });

  it('names the binding when no workspace can be resolved', () => {
    expect(() =>
      parseManifest({ version: 1, environment: 'dev', bindings: [{ file: '.env' }] }),
    ).toThrow(/bindings\[0\] has no workspace/);
  });

  it('names the binding when no environment can be resolved', () => {
    expect(() =>
      parseManifest({ version: 1, workspace: 'w', bindings: [{ file: '.env' }] }),
    ).toThrow(/bindings\[0\] has no environment/);
  });

  it('rejects the same file bound twice', () => {
    expect(() =>
      parseManifest({
        version: 1,
        workspace: 'w',
        bindings: [
          { file: '.env', environment: 'dev' },
          { file: '.env', environment: 'prod' },
        ],
      }),
    ).toThrow(/bound more than once/);
  });

  it('requires at least one binding', () => {
    expect(() => parseManifest({ version: 1, workspace: 'w', environment: 'e', bindings: [] })).toThrow(/non-empty/);
  });
});

describe('renderManifest', () => {
  it('round-trips through parse unchanged', () => {
    const parsed = parseManifest(monorepo);
    expect(parseManifest(JSON.parse(renderManifest(parsed)))).toEqual(parsed);
  });

  it('omits per-binding fields that match the defaults', () => {
    const rendered = renderManifest(
      parseManifest({
        version: 1,
        workspace: 'solo',
        environment: 'dev',
        bindings: [{ file: '.env' }],
      }),
    );
    const obj = JSON.parse(rendered) as { bindings: Array<Record<string, unknown>> };
    expect(obj.bindings[0]).toEqual({ file: '.env' });
  });

  it('contains no secret values - only names and paths', () => {
    // The whole premise of committing this file.
    const rendered = renderManifest(parseManifest(monorepo));
    expect(rendered).not.toMatch(/value|secret[_-]?key|password|token/i);
  });
});

describe('loadManifest', () => {
  it('reads a written manifest back', () => {
    writeManifest(dir, parseManifest(monorepo));
    expect(hasManifest(dir)).toBe(true);
    expect(loadManifest(dir).bindings).toHaveLength(3);
  });

  it('points at --write when the file is missing', () => {
    expect(() => loadManifest(dir)).toThrow(/cf sync init --write/);
  });

  it('reports invalid JSON with the path, not a bare parse error', () => {
    writeFileSync(join(dir, MANIFEST_FILENAME), '{ not json');
    expect(() => loadManifest(dir)).toThrow(/is not valid JSON/);
  });

  it('prefixes validation errors with the file path', () => {
    writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify({ version: 1, bindings: [] }));
    expect(() => loadManifest(dir)).toThrow(new RegExp(MANIFEST_FILENAME.replace('.', '\\.')));
  });

  it('writes valid JSON ending in a newline', () => {
    const path = writeManifest(dir, parseManifest(monorepo));
    const body = readFileSync(path, 'utf-8');
    expect(body.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(body)).not.toThrow();
  });
});
