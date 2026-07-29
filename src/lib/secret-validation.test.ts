import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import {
  KEY_PATTERN,
  MAX_BATCH_SIZE,
  MAX_KEY_LENGTH,
  MAX_VALUE_LENGTH,
  chunk,
  suggestKey,
  validateSecrets,
} from './secret-validation.js';

describe('validateSecrets', () => {
  it('accepts a well-formed set', () => {
    expect(validateSecrets(new Map([['DATABASE_URL', 'postgres://x'], ['PORT', '3000']]))).toEqual([]);
  });

  it('rejects an empty value, naming the key', () => {
    // The exact line that broke a real push: `VITE_API_URL=`
    const problems = validateSecrets(new Map([['VITE_API_URL', '']]));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.key).toBe('VITE_API_URL');
    expect(problems[0]!.reason).toMatch(/empty/);
  });

  it('rejects a lowercase key and suggests the fix', () => {
    const [problem] = validateSecrets(new Map([['database_url', 'x']]));
    expect(problem!.reason).toMatch(/UPPER_SNAKE_CASE/);
    expect(problem!.reason).toMatch(/DATABASE_URL/);
  });

  it('rejects a key that survived a bad parse', () => {
    // What a parser without `export ` support produced before that was fixed.
    const [problem] = validateSecrets(new Map([['export CLOUDFLARE_API_TOKEN', 'x']]));
    expect(problem!.reason).toMatch(/UPPER_SNAKE_CASE/);
  });

  it('reports every problem at once, not just the first', () => {
    // One round trip to fix a bad file, not one per bad key.
    const problems = validateSecrets(new Map([
      ['ok_lower', 'v'],
      ['EMPTY', ''],
      ['ALSO_FINE', 'v'],
      ['9_STARTS_WITH_DIGIT', 'v'],
    ]));
    expect(problems.map((p) => p.key).sort()).toEqual(['9_STARTS_WITH_DIGIT', 'EMPTY', 'ok_lower']);
  });

  it('rejects an oversized value', () => {
    const [problem] = validateSecrets(new Map([['BIG', 'x'.repeat(MAX_VALUE_LENGTH + 1)]]));
    expect(problem!.reason).toMatch(/max 65536/);
  });

  it('rejects an oversized key', () => {
    const [problem] = validateSecrets(new Map([['A'.repeat(MAX_KEY_LENGTH + 1), 'v']]));
    expect(problem!.reason).toMatch(/max 256/);
  });
});

describe('suggestKey', () => {
  it('converts common shapes', () => {
    expect(suggestKey('database_url')).toBe('DATABASE_URL');
    expect(suggestKey('viteApiUrl')).toBe('VITE_API_URL');
    expect(suggestKey('my-key.name')).toBe('MY_KEY_NAME');
  });

  it('falls back rather than suggesting something still invalid', () => {
    expect(suggestKey('123')).toBe('VALID_KEY_NAME');
    expect(KEY_PATTERN.test(suggestKey('!!!'))).toBe(true);
  });
});

describe('chunk', () => {
  it('splits at the server batch limit', () => {
    const items = Array.from({ length: 250 }, (_, i) => i);
    expect(chunk(items).map((c) => c.length)).toEqual([100, 100, 50]);
  });

  it('leaves a small set in one batch', () => {
    expect(chunk([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it('returns nothing for an empty set, so no request is sent', () => {
    expect(chunk([])).toEqual([]);
  });
});

// These constants are duplicated because the CLI mirror vendors only BRAND
// from @cryptflare/shared. Duplication that drifts silently is worse than
// none, so read the server's source and assert they still agree.
// Resolved from this file, not process.cwd(): the working directory is the
// package under a filtered run but the repo root under `pnpm test:run`, and
// the relative path only worked for the former.
const SHARED = join(dirname(fileURLToPath(import.meta.url)), '../../../shared/src');

// The mirror repo (cryptflare/cryptflare-cli) contains this package's src and
// nothing else, so packages/shared is not on disk there and these reads throw
// ENOENT. That failure took down `npm test` in the mirror's release workflow
// and blocked the 0.5.0 publish. The check is a monorepo concern: skip it
// where its subject does not exist, rather than fail a release over it.
const hasSharedSource = existsSync(join(SHARED, 'schemas/secrets.ts'));

describe.skipIf(!hasSharedSource)('parity with the server schema', () => {
  const schema = hasSharedSource ? readFileSync(join(SHARED, 'schemas/secrets.ts'), 'utf-8') : '';

  it('matches the server key and value limits', () => {
    expect(schema).toContain(`max(${MAX_KEY_LENGTH})`);
    expect(schema).toContain(`max(${MAX_VALUE_LENGTH})`);
  });

  it('matches the server batch limit', () => {
    expect(schema).toContain(`max(${MAX_BATCH_SIZE})`);
  });

  it('matches the server key pattern exactly', () => {
    const validation = readFileSync(join(SHARED, 'constants/validation.ts'), 'utf-8');
    const match = validation.match(/UPPER_SNAKE_CASE_REGEX\s*=\s*(\/.+?\/)/);
    expect(match, 'UPPER_SNAKE_CASE_REGEX not found in shared constants').not.toBeNull();
    // Compare the literals, so a change on either side fails here rather than
    // surfacing as a rejected push.
    expect(match![1]).toBe(KEY_PATTERN.toString());
  });
});
