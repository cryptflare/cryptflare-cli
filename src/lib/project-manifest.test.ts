import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  MANIFEST_FILENAME,
  ManifestError,
  appendManifestBindings,
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

describe('autoDiscover', () => {
  it('is absent from a manifest that does not state it', () => {
    expect(parseManifest({ version: 1, workspace: 'w', bindings: [{ file: '.env', environment: 'dev' }] }).autoDiscover).toBeUndefined();
  });

  it('round-trips, with the ignore list', () => {
    const manifest = parseManifest({
      version: 1,
      workspace: 'w',
      autoDiscover: true,
      ignore: ['scratch/.env'],
      bindings: [{ file: '.env', environment: 'dev' }],
    });
    expect(manifest.autoDiscover).toBe(true);
    expect(manifest.ignore).toEqual(['scratch/.env']);
    expect(parseManifest(JSON.parse(renderManifest(manifest)))).toEqual(manifest);
  });

  it('rejects a value that is not a boolean', () => {
    expect(() => parseManifest({ version: 1, workspace: 'w', autoDiscover: 'yes', bindings: [{ file: '.env', environment: 'dev' }] }))
      .toThrow(/autoDiscover/);
  });
});

describe('appendManifestBindings', () => {
  const path = () => join(dir, MANIFEST_FILENAME);
  const write = (body: unknown) => writeFileSync(path(), `${JSON.stringify(body, null, 2)}\n`);
  const read = () => JSON.parse(readFileSync(path(), 'utf-8')) as { bindings: unknown[] } & Record<string, unknown>;

  it('appends to a generated manifest and leaves every existing entry as it was', () => {
    const before = {
      version: 1,
      workspace: 'shop',
      capture: 'auto',
      autoDiscover: true,
      // A field this version does not know, and a binding a person edited.
      notes: 'kept',
      bindings: [
        { file: '.env', environment: 'my-own-name', capture: 'prompt' },
        { file: 'apps/api/.dev.vars', environment: 'api-dev-worker' },
      ],
    };
    write(before);

    const written = appendManifestBindings(dir, [
      { file: '.env.production', workspace: 'shop', environment: 'root-production', capture: 'off' },
    ]);

    expect(written).toHaveLength(1);
    const after = read();
    expect(after['notes']).toBe('kept');
    expect(after.bindings.slice(0, 2)).toEqual(before.bindings);
    expect(after.bindings[2]).toEqual({ file: '.env.production', environment: 'root-production', capture: 'off' });
    expect(() => loadManifest(dir)).not.toThrow();
  });

  it('does not touch a manifest written by hand', () => {
    write({ version: 1, workspace: 'shop', bindings: [{ file: '.env', environment: 'dev' }] });
    const before = readFileSync(path(), 'utf-8');

    expect(appendManifestBindings(dir, [{ file: '.env.production', workspace: 'shop', environment: 'root-production' }])).toEqual([]);
    expect(readFileSync(path(), 'utf-8')).toBe(before);
  });

  it('does not touch a manifest that opted out', () => {
    write({ version: 1, workspace: 'shop', autoDiscover: false, bindings: [{ file: '.env', environment: 'dev' }] });
    expect(appendManifestBindings(dir, [{ file: 'a/.env', workspace: 'shop', environment: 'a-dev' }])).toEqual([]);
  });

  it('never adds a second binding for a file that has one', () => {
    write({ version: 1, workspace: 'shop', autoDiscover: true, bindings: [{ file: '.env', environment: 'mine' }] });
    expect(appendManifestBindings(dir, [{ file: '.env', workspace: 'shop', environment: 'root-dev' }])).toEqual([]);
    expect(read().bindings).toEqual([{ file: '.env', environment: 'mine' }]);
  });

  it('leaves no temporary file behind', () => {
    write({ version: 1, workspace: 'shop', autoDiscover: true, bindings: [{ file: '.env', environment: 'dev' }] });
    appendManifestBindings(dir, [{ file: 'a/.env', workspace: 'shop', environment: 'a-dev' }]);
    expect(readdirSync(dir)).toEqual([MANIFEST_FILENAME]);
  });
});
