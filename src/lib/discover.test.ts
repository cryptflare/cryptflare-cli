import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildManifest, findEnvFiles, isEnvFileName, planBindings, planNewBindings, stageOf } from './discover.js';
import { parseManifest, renderManifest } from './project-manifest.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-discover-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function touch(...paths: string[]): void {
  for (const path of paths) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'KEY=value\n');
  }
}

const environments = (files: string[]) => Object.fromEntries(planBindings(files).map((b) => [b.file, b.environment]));

describe('isEnvFileName', () => {
  it('recognises the env files tools read', () => {
    for (const name of ['.env', '.env.local', '.env.production', '.envrc', '.dev.vars', '.dev.vars.preview', '.production.vars']) {
      expect(isEnvFileName(name), name).toBe(true);
    }
  });

  it('leaves examples and unrelated files alone', () => {
    for (const name of ['.env.example', '.env.sample', '.dev.vars.template', '.envrc.example', 'env.ts', '.environment', 'README.md']) {
      expect(isEnvFileName(name), name).toBe(false);
    }
  });
});

describe('stageOf', () => {
  it('is dev when the name declares no stage', () => {
    expect(stageOf('.env')).toBe('dev');
    expect(stageOf('.envrc')).toBe('dev');
    expect(stageOf('.dev.vars')).toBe('dev');
    expect(stageOf('.env.local')).toBe('dev');
  });

  it('reads the stage from the name', () => {
    expect(stageOf('.env.production')).toBe('production');
    expect(stageOf('.env.prod')).toBe('production');
    expect(stageOf('.env.staging')).toBe('staging');
    expect(stageOf('.production.vars')).toBe('production');
  });

  it('takes the stage after wrangler\'s own "dev" in .dev.vars.<stage>', () => {
    expect(stageOf('.dev.vars.production')).toBe('production');
    expect(stageOf('.dev.vars.preview')).toBe('preview');
  });
});

describe('planBindings', () => {
  it('names environments app-stage-kind, as the existing manifests do', () => {
    expect(environments([
      '.envrc',
      'apps/api/.dev.vars',
      'apps/cron/.dev.vars',
      'packages/sdk/typescript/.env',
      'packages/terraform-provider-cryptflare/examples/local-test/.envrc',
    ])).toEqual({
      '.envrc': 'root-dev-shell',
      'apps/api/.dev.vars': 'api-dev-worker',
      'apps/cron/.dev.vars': 'cron-dev-worker',
      'packages/sdk/typescript/.env': 'pkg-sdk-typescript-dev',
      'packages/terraform-provider-cryptflare/examples/local-test/.envrc': 'pkg-terraform-provider-cryptflare-examples-local-test-dev-shell',
    });
  });

  it('gives each stage of one app its own environment', () => {
    expect(environments(['apps/api/.dev.vars', 'apps/api/.dev.vars.preview', 'apps/api/.dev.vars.production'])).toEqual({
      'apps/api/.dev.vars': 'api-dev-worker',
      'apps/api/.dev.vars.preview': 'api-preview-worker',
      'apps/api/.dev.vars.production': 'api-production-worker',
    });
  });

  it('never binds two files to one environment', () => {
    const planned = planBindings(['apps/web/.env', 'apps/web/.env.development', 'apps/web/.env.local']);
    const names = planned.map((b) => b.environment);

    expect(new Set(names).size).toBe(3);
    expect(names).toEqual(['web-dev-env', 'web-dev-env-development', 'web-dev-env-local']);
  });

  it('captures automatically for development files only', () => {
    const planned = planBindings(['.env', '.env.production', '.env.staging']);
    expect(Object.fromEntries(planned.map((b) => [b.file, b.capture]))).toEqual({
      '.env': 'auto',
      '.env.production': 'off',
      '.env.staging': 'off',
    });
  });

  it('is stable whatever order the files arrive in', () => {
    const files = ['apps/b/.env', '.envrc', 'apps/a/.env'];
    expect(planBindings(files)).toEqual(planBindings([...files].reverse()));
  });
});

describe('findEnvFiles', () => {
  it('finds env files and skips dependencies, build output and examples', () => {
    touch(
      '.envrc', '.env.example', 'apps/api/.dev.vars', 'apps/web/.env.local',
      'node_modules/pkg/.env', 'apps/web/dist/.env', 'references/other/.env', '.git/.env',
    );

    expect(findEnvFiles(root)).toEqual(['.envrc', 'apps/api/.dev.vars', 'apps/web/.env.local']);
  });

  it('returns nothing for a repository with no env files', () => {
    touch('src/index.ts');
    expect(findEnvFiles(root)).toEqual([]);
  });
});

describe('buildManifest', () => {
  it('produces a manifest the CLI itself accepts', () => {
    touch('.envrc', 'apps/api/.dev.vars', 'apps/api/.dev.vars.production');
    const manifest = buildManifest(root, planBindings(findEnvFiles(root)), { org: 'org_1', workspace: 'my-app' });

    const parsed = parseManifest(JSON.parse(renderManifest(manifest)));

    expect(parsed.workspace).toBe('my-app');
    expect(parsed.org).toBe('org_1');
    expect(parsed.bindings.map((b) => [b.file, b.environment, b.capture])).toEqual([
      ['.envrc', 'root-dev-shell', 'auto'],
      ['apps/api/.dev.vars', 'api-dev-worker', 'auto'],
      ['apps/api/.dev.vars.production', 'api-production-worker', 'off'],
    ]);
  });

  it('names the workspace after the directory when none is given', () => {
    const manifest = buildManifest('/home/me/code/My Cool App', planBindings(['.env']));
    expect(manifest.workspace).toBe('my-cool-app');
  });

  it('holds no values, only names', () => {
    touch('.env');
    const rendered = renderManifest(buildManifest(root, planBindings(findEnvFiles(root))));
    expect(rendered).not.toContain('KEY=value');
    expect(rendered).not.toContain('value');
  });
});

describe('files that only look like env files', () => {
  it('ignores the sync engine\'s conflict sidecars and temporaries, and editor backups', () => {
    expect(isEnvFileName('.env.cf-conflict-2026-07-28T11-04-22-891Z')).toBe(false);
    expect(isEnvFileName('.env.tmp-48213')).toBe(false);
    expect(isEnvFileName('.env.bak')).toBe(false);
    expect(isEnvFileName('.env.local.orig')).toBe(false);
    expect(isEnvFileName('.env.swp')).toBe(false);
    expect(isEnvFileName('.env~')).toBe(false);
  });
});

describe('planNewBindings', () => {
  const existing = [
    { file: '.env', environment: 'root-dev' },
    { file: 'apps/api/.dev.vars', environment: 'api-dev-worker' },
  ];

  it('returns nothing when every file is already bound', () => {
    expect(planNewBindings(existing, ['.env', 'apps/api/.dev.vars'])).toEqual([]);
  });

  it('names a new file by the same rules as the first ones', () => {
    expect(planNewBindings(existing, ['.env', 'apps/api/.dev.vars', 'apps/worker/.dev.vars', '.env.production'])).toEqual([
      { file: '.env.production', stage: 'production', environment: 'root-production', capture: 'off' },
      { file: 'apps/worker/.dev.vars', stage: 'dev', environment: 'worker-dev-worker', capture: 'auto' },
    ]);
  });

  it('never captures automatically from a file that names another stage', () => {
    const added = planNewBindings(existing, ['.env.production', '.env.staging', 'apps/api/.dev.vars.production']);
    expect(added.map((binding) => binding.capture)).toEqual(['off', 'off', 'off']);
  });

  it('gives a new file its own environment when its natural name is taken, without renaming the old one', () => {
    const added = planNewBindings(existing, ['.env', '.env.local']);
    expect(added).toEqual([{ file: '.env.local', stage: 'dev', environment: 'root-dev-env-local', capture: 'auto' }]);
  });

  it('avoids a name a person chose for another file', () => {
    const edited = [{ file: '.env', environment: 'root-production' }];
    const added = planNewBindings(edited, ['.env', '.env.production']);
    expect(added[0]?.environment).toBe('root-production-env-production');
  });

  it('falls back to a number when even the file name is taken', () => {
    const edited = [
      { file: '.env', environment: 'root-dev' },
      { file: 'other', environment: 'root-dev-env-local' },
    ];
    expect(planNewBindings(edited, ['.env', '.env.local'])[0]?.environment).toBe('root-dev-env-local-2');
  });

  it('keeps two new files apart from each other', () => {
    const added = planNewBindings([], ['.env', '.env.local']);
    expect(new Set(added.map((binding) => binding.environment)).size).toBe(2);
  });
});

describe('the generated manifest', () => {
  it('opts in to having new env files added', () => {
    expect(buildManifest('/home/me/code/app', planBindings(['.env'])).autoDiscover).toBe(true);
  });
});
