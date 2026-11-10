import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDefault, getOrg } from './config.js';
import { MANIFEST_FILENAME } from './project-manifest.js';
import { resolveContext, resolveOrg } from './resolve.js';

vi.mock('./config.js', () => ({
  getOrg: vi.fn(),
  getDefault: vi.fn(),
}));

const mockedOrg = vi.mocked(getOrg);
const mockedDefault = vi.mocked(getDefault);

/** Every test resolves from a temp directory, never from this repository's own manifest. */
let dir: string;

function setDefaults(values: { org?: string; workspace?: string; environment?: string }): void {
  mockedOrg.mockReturnValue(values.org as ReturnType<typeof getOrg>);
  mockedDefault.mockImplementation(((key: string) =>
    key === 'workspace' ? values.workspace : key === 'environment' ? values.environment : undefined) as typeof getDefault);
}

function writeManifest(): void {
  writeFileSync(join(dir, MANIFEST_FILENAME), JSON.stringify({
    version: 1,
    org: 'org_manifest',
    workspace: 'ws_manifest',
    bindings: [
      { file: '.env', environment: 'env_manifest' },
      { file: 'apps/api/.dev.vars', environment: 'api_manifest', pod: 'pod_api' },
    ],
  }));
  mkdirSync(join(dir, 'apps', 'api'), { recursive: true });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-resolve-'));
  setDefaults({});
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveContext', () => {
  it('uses flag values over everything else', () => {
    writeManifest();
    setDefaults({ org: 'org_config', workspace: 'ws_config', environment: 'env_config' });

    const ctx = resolveContext({ org: 'org_flag', workspace: 'ws_flag', env: 'env_flag' }, dir);

    expect(ctx).toEqual({ org: 'org_flag', workspace: 'ws_flag', env: 'env_flag' });
  });

  it('falls back to config defaults outside a project', () => {
    setDefaults({ org: 'org_config', workspace: 'ws_config', environment: 'env_config' });

    expect(resolveContext({}, dir)).toEqual({ org: 'org_config', workspace: 'ws_config', env: 'env_config' });
  });

  it('takes the scope from the manifest ahead of config defaults', () => {
    writeManifest();
    setDefaults({ org: 'org_config', workspace: 'ws_config', environment: 'env_config' });

    expect(resolveContext({}, dir)).toEqual({ org: 'org_manifest', workspace: 'ws_manifest', env: 'env_manifest' });
  });

  it('uses the binding nearest the current directory, with its pod', () => {
    writeManifest();

    expect(resolveContext({}, join(dir, 'apps', 'api'))).toEqual({
      org: 'org_manifest',
      workspace: 'ws_manifest',
      env: 'api_manifest',
      pod: 'pod_api',
    });
  });

  it('selects a binding by file with --binding', () => {
    writeManifest();

    expect(resolveContext({ binding: 'apps/api/.dev.vars' }, dir).env).toBe('api_manifest');
  });

  it('lets --env override the manifest environment while keeping its workspace', () => {
    writeManifest();

    const ctx = resolveContext({ env: 'production' }, dir);

    expect(ctx).toEqual({ org: 'org_manifest', workspace: 'ws_manifest', env: 'production' });
  });

  it('still reads the organisation from the manifest when workspace and env are flags', () => {
    writeManifest();

    expect(resolveContext({ workspace: 'ws_flag', env: 'env_flag' }, dir)).toEqual({
      org: 'org_manifest',
      workspace: 'ws_flag',
      env: 'env_flag',
    });
  });

  it('throws, naming the fix, when no organisation can be found', () => {
    expect(() => resolveContext({ workspace: 'ws', env: 'dev' }, dir)).toThrow(/cf org select/);
  });

  it('throws when no workspace can be found', () => {
    setDefaults({ org: 'org_config' });
    expect(() => resolveContext({}, dir)).toThrow(/No workspace specified/);
  });

  it('throws when no environment can be found', () => {
    setDefaults({ org: 'org_config', workspace: 'ws_config' });
    expect(() => resolveContext({}, dir)).toThrow(/No environment specified/);
  });
});

describe('resolveOrg', () => {
  it('uses the flag over config', () => {
    setDefaults({ org: 'org_config' });
    expect(resolveOrg({ org: 'org_direct' }, dir)).toBe('org_direct');
  });

  it('reads the organisation from the project manifest ahead of config', () => {
    writeManifest();
    setDefaults({ org: 'org_config' });
    expect(resolveOrg({}, dir)).toBe('org_manifest');
  });

  it('throws when no organisation is selected', () => {
    expect(() => resolveOrg({}, dir)).toThrow(/No organisation selected/);
  });
});
