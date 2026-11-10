import { describe, expect, it } from 'vitest';

import { assertNoBindingCollisions, collidingFiles, describeCollision, findBindingCollisions } from './binding-collisions.js';

describe('findBindingCollisions', () => {
  it('finds two files bound to one environment', () => {
    const collisions = findBindingCollisions(
      [
        { file: '.env', environment: 'dev' },
        { file: 'apps/api/.dev.vars', environment: 'dev' },
        { file: '.env.production', environment: 'production' },
      ],
      'shop',
    );
    expect(collisions).toEqual([{ target: 'shop/dev', files: ['.env', 'apps/api/.dev.vars'] }]);
    expect([...collidingFiles(collisions)]).toEqual(['.env', 'apps/api/.dev.vars']);
  });

  it('treats the same environment name in two workspaces as two places', () => {
    expect(findBindingCollisions([
      { file: 'apps/web/.env', workspace: 'web', environment: 'dev' },
      { file: 'apps/api/.env', workspace: 'api', environment: 'dev' },
    ])).toEqual([]);
  });

  it('applies the default workspace before comparing', () => {
    expect(findBindingCollisions(
      [{ file: 'a/.env', environment: 'dev' }, { file: 'b/.env', workspace: 'shop', environment: 'dev' }],
      'shop',
    )).toHaveLength(1);
  });

  it('treats pods of one environment as separate places', () => {
    expect(findBindingCollisions([
      { file: 'apps/web/.env', environment: 'dev', pod: 'web' },
      { file: 'apps/api/.env', environment: 'dev', pod: 'api' },
    ], 'shop')).toEqual([]);
    expect(findBindingCollisions([
      { file: 'apps/web/.env', environment: 'dev', pod: 'web' },
      { file: 'apps/api/.env', environment: 'dev', pod: 'web' },
    ], 'shop')).toEqual([{ target: 'shop/dev/web', files: ['apps/web/.env', 'apps/api/.env'] }]);
  });
});

describe('describeCollision', () => {
  it('names both files and the environment', () => {
    const message = describeCollision({ target: 'shop/dev', files: ['.env', 'apps/api/.dev.vars'] });
    expect(message).toContain('".env" and "apps/api/.dev.vars" are both bound to environment shop/dev');
  });

  it('names every file when there are more than two', () => {
    expect(describeCollision({ target: 'shop/dev', files: ['a', 'b', 'c'] })).toContain('"a", "b" and "c" are all bound');
  });
});

describe('assertNoBindingCollisions', () => {
  it('throws with the message, and passes when nothing collides', () => {
    expect(() => assertNoBindingCollisions([{ file: 'a', environment: 'dev' }, { file: 'b', environment: 'dev' }], 'w')).toThrow(/"a" and "b"/);
    expect(() => assertNoBindingCollisions([{ file: 'a', environment: 'dev' }, { file: 'b', environment: 'prod' }], 'w')).not.toThrow();
  });
});
