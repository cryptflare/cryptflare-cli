import { describe, it, expect } from 'vitest';

import { parseRegistry, RegistryError } from './sync-registry.js';

const valid = {
  version: 1,
  projects: [
    {
      id: 'app',
      path: '/home/dev/app',
      org: 'org_1',
      workspace: 'ws',
      bindings: [{ file: '.env', environment: 'dev' }],
    },
  ],
};

describe('parseRegistry', () => {
  it('accepts a well-formed registry and defaults enabled to true', () => {
    expect(parseRegistry(valid).projects[0]!.enabled).toBe(true);
  });

  it('honours an explicit enabled:false', () => {
    const parked = { ...valid, projects: [{ ...valid.projects[0], enabled: false }] };
    expect(parseRegistry(parked).projects[0]!.enabled).toBe(false);
  });

  it('rejects an unknown version rather than guessing', () => {
    expect(() => parseRegistry({ ...valid, version: 2 })).toThrow(RegistryError);
  });

  it('names the offending path in the error', () => {
    const broken = { ...valid, projects: [{ ...valid.projects[0], workspace: '' }] };
    expect(() => parseRegistry(broken)).toThrow(/projects\[0\]\.workspace/);
  });

  it('rejects an absolute binding path', () => {
    const escape = {
      ...valid,
      projects: [{ ...valid.projects[0], bindings: [{ file: '/etc/passwd', environment: 'dev' }] }],
    };
    expect(() => parseRegistry(escape)).toThrow(/relative path/);
  });

  it('rejects a binding path that walks out of the project', () => {
    const escape = {
      ...valid,
      projects: [{ ...valid.projects[0], bindings: [{ file: '../../.ssh/config', environment: 'dev' }] }],
    };
    expect(() => parseRegistry(escape)).toThrow(/relative path/);
  });

  it('rejects duplicate project ids', () => {
    expect(() => parseRegistry({ ...valid, projects: [valid.projects[0], valid.projects[0]] })).toThrow(/duplicate/);
  });

  it('rejects two bindings racing for one file', () => {
    const racing = {
      ...valid,
      projects: [
        {
          ...valid.projects[0],
          bindings: [
            { file: '.env', environment: 'dev' },
            { file: '.env', environment: 'prod' },
          ],
        },
      ],
    };
    expect(() => parseRegistry(racing)).toThrow(/more than once/);
  });

  it('requires at least one binding', () => {
    expect(() => parseRegistry({ ...valid, projects: [{ ...valid.projects[0], bindings: [] }] })).toThrow(/non-empty/);
  });

  it('allows a project with no org, deferring to the CLI default', () => {
    const { org: _org, ...noOrg } = valid.projects[0]!;
    expect(parseRegistry({ ...valid, projects: [noOrg] }).projects[0]!.org).toBeUndefined();
  });
});

describe('one file, one owner', () => {
  const project = (id: string, path: string, file: string) => ({
    id,
    path,
    workspace: 'ws',
    enabled: true,
    bindings: [{ file, environment: 'dev' }],
  });

  it('rejects two projects binding the same file on disk', () => {
    // The shape a real registry drifted into: `peak-blog` and `peak-physique`
    // both owning apps/blog/.env at the same directory, so the file had two
    // merge bases and each pass processed it twice.
    expect(() => parseRegistry({
      version: 1,
      projects: [
        project('peak-blog', '/home/dev/peak', 'apps/blog/.env'),
        project('peak-physique', '/home/dev/peak', 'apps/blog/.env'),
      ],
    })).toThrow(/both bind .*apps\/blog\/\.env/);
  });

  it('allows the same relative filename in different repositories', () => {
    // The common case, and it must keep working: bindings resolve against the
    // project path, so two repos each with a .env are unrelated.
    expect(() => parseRegistry({
      version: 1,
      projects: [
        project('alpha', '/home/dev/alpha', '.env'),
        project('beta', '/home/dev/beta', '.env'),
      ],
    })).not.toThrow();
  });

  it('allows several env files inside one project', () => {
    expect(() => parseRegistry({
      version: 1,
      projects: [{
        id: 'multi',
        path: '/home/dev/multi',
        workspace: 'ws',
        enabled: true,
        bindings: [
          { file: '.env', environment: 'dev' },
          { file: 'apps/api/.dev.vars', environment: 'dev-worker' },
          { file: 'apps/api/.production.vars', environment: 'prod' },
        ],
      }],
    })).not.toThrow();
  });
});
