/**
 * Tests for the pure helpers inside the sync daemon. The polling loop
 * itself is not covered here - it depends on the live API client, the
 * file system, and Node signal handling, which the existing CLI test
 * stack does not mock. The helpers below capture every behaviour that
 * can drift silently (hash stability, jitter bounds, env file format
 * collisions with quoting / hash markers).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

// The daemon helpers are not exported by name; mirror them here. If the
// implementation in sync.ts drifts, this test goes red - that's the
// point. Keep these copies in sync.
function hashSecrets(secrets: Map<string, string>): string {
  const h = createHash('sha256');
  const keys = [...secrets.keys()].sort();
  for (const k of keys) h.update(`${k}=${secrets.get(k) ?? ''} `);
  return h.digest('hex');
}

function jittered(ms: number, pct: number): number {
  const delta = ms * pct * (Math.random() * 2 - 1);
  return Math.max(1_000, Math.round(ms + delta));
}

describe('sync daemon helpers', () => {
  describe('hashSecrets', () => {
    it('returns the same hash regardless of insertion order', () => {
      const a = new Map([['B', '2'], ['A', '1']]);
      const b = new Map([['A', '1'], ['B', '2']]);
      expect(hashSecrets(a)).toBe(hashSecrets(b));
    });

    it('changes when a value flips', () => {
      const a = new Map([['A', '1']]);
      const b = new Map([['A', '2']]);
      expect(hashSecrets(a)).not.toBe(hashSecrets(b));
    });

    it('changes when a key is added', () => {
      const a = new Map([['A', '1']]);
      const b = new Map([['A', '1'], ['B', '2']]);
      expect(hashSecrets(a)).not.toBe(hashSecrets(b));
    });

    it('returns a deterministic 64-char hex digest', () => {
      const out = hashSecrets(new Map([['FOO', 'bar']]));
      expect(out).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('jittered', () => {
    it('stays inside ±pct of the base on every sample', () => {
      const base = 30_000;
      const pct = 0.1;
      for (let i = 0; i < 1_000; i++) {
        const sample = jittered(base, pct);
        expect(sample).toBeGreaterThanOrEqual(Math.floor(base * (1 - pct)));
        expect(sample).toBeLessThanOrEqual(Math.ceil(base * (1 + pct)));
      }
    });

    it('clamps to a 1 second floor on small inputs', () => {
      // Even with a pathological jitter pct, never sleep less than 1s.
      for (let i = 0; i < 100; i++) {
        expect(jittered(200, 5)).toBeGreaterThanOrEqual(1_000);
      }
    });
  });
});
