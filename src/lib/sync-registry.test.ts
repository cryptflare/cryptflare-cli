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
