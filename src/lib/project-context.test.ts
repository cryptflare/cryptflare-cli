import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findManifestRoot, resolveProjectTarget, selectTarget } from './project-context.js';
import { MANIFEST_FILENAME, parseManifest } from './project-manifest.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-context-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A monorepo shaped like the ones this is for: one environment per bound file. */
const MONOREPO = {
  version: 1,
  org: 'org_1',
  workspace: 'platform',
  bindings: [
    { file: '.envrc', environment: 'root-shell' },
    { file: 'apps/api/.dev.vars', environment: 'api-dev' },
    { file: 'apps/web/.env', environment: 'web-dev', workspace: 'web', pod: 'pod_web' },
  ],
};

function writeProject(manifest: unknown = MONOREPO): void {
  writeFileSync(join(root, MANIFEST_FILENAME), JSON.stringify(manifest));
  mkdirSync(join(root, 'apps', 'api', 'src'), { recursive: true });
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(join(root, 'docs'), { recursive: true });
}

describe('findManifestRoot', () => {
  it('finds the manifest from a nested directory', () => {
    writeProject();
    expect(findManifestRoot(join(root, 'apps', 'api', 'src'))).toBe(root);
  });

  it('returns null outside any project', () => {
    expect(findManifestRoot(root)).toBeNull();
  });
});

describe('selectTarget', () => {
  const manifest = parseManifest(MONOREPO);

  it('uses the root binding at the project root', () => {
    expect(selectTarget(manifest, root, { cwd: root })).toEqual({
      org: 'org_1',
      workspace: 'platform',
      environment: 'root-shell',
      file: '.envrc',
    });
  });

  it('prefers the binding nearest the current directory', () => {
    const target = selectTarget(manifest, root, { cwd: join(root, 'apps', 'api', 'src') });
    expect(target?.environment).toBe('api-dev');
  });

  it('carries a binding workspace override and pod', () => {
    expect(selectTarget(manifest, root, { cwd: join(root, 'apps', 'web') })).toEqual({
      org: 'org_1',
      workspace: 'web',
      environment: 'web-dev',
      pod: 'pod_web',
      file: 'apps/web/.env',
    });
  });

  it('falls back to an enclosing binding in a directory with none of its own', () => {
    expect(selectTarget(manifest, root, { cwd: join(root, 'docs') })?.environment).toBe('root-shell');
  });

  it('selects by file with --binding regardless of the current directory', () => {
    const target = selectTarget(manifest, root, { cwd: join(root, 'docs'), binding: './apps/api/.dev.vars' });
    expect(target?.environment).toBe('api-dev');
  });

  it('rejects a --binding the manifest does not have, listing the ones it does', () => {
    expect(() => selectTarget(manifest, root, { cwd: root, binding: 'nope.env' })).toThrow(/apps\/api\/\.dev\.vars/);
  });

  it('returns null when --env matches no binding here, so flags and defaults apply', () => {
    expect(selectTarget(manifest, root, { cwd: root, environment: 'production' })).toBeNull();
  });

  it('treats two files on the same scope in one directory as one answer', () => {
    const shared = parseManifest({
      version: 1,
      workspace: 'api',
      environment: 'dev',
      bindings: [{ file: '.env' }, { file: '.env.local' }],
    });
    expect(selectTarget(shared, root, { cwd: root })?.environment).toBe('dev');
  });

  it('takes the development file when .env sits beside .env.production', () => {
    const sideBySide = parseManifest({
      version: 1,
      workspace: 'api',
      bindings: [
        { file: '.env.production', environment: 'production' },
        { file: '.env', environment: 'dev' },
      ],
    });
    expect(selectTarget(sideBySide, root, { cwd: root })?.environment).toBe('dev');
  });

  it('never picks a production file implicitly', () => {
    const noDevFile = parseManifest({
      version: 1,
      workspace: 'api',
      bindings: [
        { file: '.env.staging', environment: 'staging' },
        { file: '.env.production', environment: 'production' },
      ],
    });
    expect(() => selectTarget(noDevFile, root, { cwd: root })).toThrow(/--env <slug> or --binding <file>/);
  });

  it('prefers .env.local over .env', () => {
    const local = parseManifest({
      version: 1,
      workspace: 'api',
      bindings: [
        { file: '.env', environment: 'dev' },
        { file: '.env.local', environment: 'dev-local' },
      ],
    });
    expect(selectTarget(local, root, { cwd: root })?.environment).toBe('dev-local');
  });

  it('resolves that ambiguity with --env', () => {
    const sideBySide = parseManifest({
      version: 1,
      workspace: 'api',
      bindings: [
        { file: '.env', environment: 'dev' },
        { file: '.env.production', environment: 'production' },
      ],
    });
    expect(selectTarget(sideBySide, root, { cwd: root, environment: 'production' })?.file).toBe('.env.production');
  });
});

describe('resolveProjectTarget', () => {
  it('returns null outside a project', () => {
    expect(resolveProjectTarget({ cwd: root })).toBeNull();
  });

  it('rejects --binding outside a project instead of ignoring it', () => {
    expect(() => resolveProjectTarget({ cwd: root, binding: '.env' })).toThrow(/\.cryptflare\.json/);
  });

  it('reads the manifest above the current directory', () => {
    writeProject();
    expect(resolveProjectTarget({ cwd: join(root, 'apps', 'api') })?.environment).toBe('api-dev');
  });
});
