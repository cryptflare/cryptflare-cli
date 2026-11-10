/**
 * The published CLI is built in a public mirror repository that does not
 * contain `@cryptflare/shared` (a private package). The sync step vendors one
 * file from it, `constants/brand`, and rewrites those imports. Any other
 * import from `@cryptflare/shared` resolves in this monorepo, passes every
 * check here, and then fails the mirror build at release time - which is how
 * the 0.8.0 release stopped.
 *
 * This reads the CLI's own source, so it also holds in the mirror.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED_IN_MIRROR = new Set(['../_vendored/brand']);
const IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"](@cryptflare\/shared[^'"]*)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(full);
    return /\.(ts|tsx|mts)$/.test(entry) ? [full] : [];
  });
}

describe('imports the public mirror cannot resolve', () => {
  it('only takes BRAND from the private shared package', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf-8').matchAll(IMPORT)) {
        const specifier = match[1] ?? '';
        if (!VENDORED_IN_MIRROR.has(specifier)) offenders.push(`${relative(SRC, file)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
