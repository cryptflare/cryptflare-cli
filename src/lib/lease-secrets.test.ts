import { describe, expect, it } from 'vitest';

import { leaseSecretKeys } from './lease-secrets.js';

describe('leaseSecretKeys', () => {
  it('prefixes every credential field', () => {
    const secrets = leaseSecretKeys('SIGNUP_TEST', { EMAIL: 'a@b.example', PASSWORD: 'p' });
    expect([...secrets.entries()]).toEqual([['SIGNUP_TEST_EMAIL', 'a@b.example'], ['SIGNUP_TEST_PASSWORD', 'p']]);
  });

  it('normalises field names that are not already UPPER_SNAKE_CASE', () => {
    expect([...leaseSecretKeys('AWS', { 'access-key.id': 'x', secretKey: 'y' }).keys()]).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRETKEY']);
  });

  it('ignores a trailing underscore on the prefix', () => {
    expect([...leaseSecretKeys('SIGNUP_', { EMAIL: 'x' }).keys()]).toEqual(['SIGNUP_EMAIL']);
  });

  it('rejects a prefix that is not UPPER_SNAKE_CASE', () => {
    expect(() => leaseSecretKeys('signup test', { EMAIL: 'x' })).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => leaseSecretKeys('', { EMAIL: 'x' })).toThrow(/UPPER_SNAKE_CASE/);
  });

  it('returns nothing for a lease with no credentials', () => {
    expect(leaseSecretKeys('X', {}).size).toBe(0);
  });
});
