import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { buildImportBody } from './import.js';

describe('buildImportBody', () => {
  const items = [{ key: 'A', value: '1' }];

  it('sends the array under `secrets`, the name the server validates', () => {
    const body = buildImportBody({ source: 'dotenv', conflictPolicy: 'skip', items });
    expect(body['secrets']).toEqual(items);
    // The original defect: the array arrived as `items`, so the server saw no
    // `secrets` field and rejected every import.
    expect(body).not.toHaveProperty('items');
  });

  it('omits podId entirely when no pod was given', () => {
    // `podId: undefined` and an absent key are not the same to a validator
    // that distinguishes them.
    expect(buildImportBody({ source: 'dotenv', conflictPolicy: 'skip', items })).not.toHaveProperty('podId');
    expect(buildImportBody({ source: 'dotenv', conflictPolicy: 'skip', pod: '', items })).not.toHaveProperty('podId');
  });

  it('passes a pod through as podId', () => {
    const body = buildImportBody({ source: 'dotenv', conflictPolicy: 'skip', pod: 'pod_1', items });
    expect(body['podId']).toBe('pod_1');
  });
});

// The schema lives in @cryptflare/shared, which the mirror repo does not carry.
// See mirror-safety.test.ts - guard on existsSync so this skips there.
const SHARED = join(dirname(fileURLToPath(import.meta.url)), '../../../shared/src');
const SCHEMA = join(SHARED, 'schemas/secrets-import.ts');

describe.skipIf(!existsSync(SCHEMA))('parity with ImportRequestSchema', () => {
  const schema = existsSync(SCHEMA) ? readFileSync(SCHEMA, 'utf-8') : '';

  it('sends only field names the schema declares', () => {
    const body = buildImportBody({
      source: 'dotenv',
      conflictPolicy: 'skip',
      pod: 'pod_1',
      items: [{ key: 'A', value: '1' }],
    });

    // Field names as declared in the Zod object, e.g. `secrets: z`.
    const declared = new Set(
      [...schema.matchAll(/^\s{2}(\w+):\s*z\s*$/gm)].map((m) => m[1]!),
    );
    expect(declared.size, 'could not read field names out of ImportRequestSchema').toBeGreaterThan(2);

    for (const key of Object.keys(body)) {
      expect(declared.has(key), `body field "${key}" is not in ImportRequestSchema`).toBe(true);
    }
  });
});
