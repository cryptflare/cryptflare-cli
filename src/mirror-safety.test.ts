import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

/**
 * This package is mirrored to cryptflare/cryptflare-cli, where the repo root
 * *is* the package: there is no `packages/`, no sibling `shared/`, nothing
 * above it. The mirror's release workflow runs `npm test` before publishing,
 * so a test that reads a file outside this package passes here and throws
 * ENOENT there - which fails the release rather than the pull request.
 *
 * That is not hypothetical: secret-validation.test.ts read
 * `../../../shared/src/schemas/secrets.ts` and blocked the 0.5.0 publish. The
 * cost is asymmetric - it surfaces at the one moment the pipeline is meant to
 * be unattended - so the rule is enforced rather than remembered.
 *
 * A test that legitimately wants the monorepo (the schema parity check) must
 * guard on `existsSync` and skip, not read unconditionally.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** Every `*.test.ts` under src/, recursively. */
function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

describe('tests stay inside the package (mirror safety)', () => {
  const files = testFiles(SRC);

  it('finds the test files to check', () => {
    // Guards the walker itself: a scan that silently matches nothing would
    // report success forever.
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files.map((f) => relative(SRC, f)))('%s reads nothing above the package root', (rel) => {
    const source = readFileSync(join(SRC, rel), 'utf-8');

    // src/ is at most two levels deep (src/commands, src/lib), so any literal
    // climbing three or more levels leaves the package.
    const escapes = [...source.matchAll(/'([^']*\.\.\/\.\.\/\.\.\/[^']*)'/g)].map((m) => m[1]!);

    // An escaping path is allowed only where the file also guards on
    // existsSync, which is what makes it skip in the mirror.
    const guarded = source.includes('existsSync');

    expect(
      escapes.length === 0 || guarded,
      `${rel} reads ${escapes.join(', ')} - outside the package, so it throws in the mirror. `
        + 'Guard it with existsSync and describe.skipIf, as secret-validation.test.ts does.',
    ).toBe(true);
  });
});
