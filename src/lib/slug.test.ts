import { describe, it, expect } from 'vitest';

import { SLUG_PATTERN, resolveSlug, toSlug } from './slug.js';

describe('toSlug', () => {
  it('passes through an already-valid slug', () => {
    expect(toSlug('peak-physique-api')).toBe('peak-physique-api');
  });

  it('lowercases and hyphenates a display name', () => {
    expect(toSlug('Peak Physique API')).toBe('peak-physique-api');
    expect(toSlug('Development')).toBe('development');
  });

  it('folds accents to their base letter rather than dropping them', () => {
    // NFKD + combining-mark strip. Without it "Café" would slug to "caf".
    expect(toSlug('Café Staging')).toBe('cafe-staging');
  });

  it('collapses runs of separators', () => {
    expect(toSlug('a  --  b')).toBe('a-b');
    expect(toSlug('Web // Blog')).toBe('web-blog');
  });

  it('trims leading and trailing separators', () => {
    expect(toSlug('  spaced  ')).toBe('spaced');
    expect(toSlug('--edge--')).toBe('edge');
  });

  it('returns empty when nothing survives', () => {
    expect(toSlug('!!!')).toBe('');
    expect(toSlug('日本語')).toBe('');
  });

  it('always produces output the server will accept', () => {
    const names = ['Peak Physique API', 'Café Staging', 'a  --  b', 'Prod_2026', 'v1.2.3'];
    for (const n of names) {
      const s = toSlug(n);
      expect(SLUG_PATTERN.test(s), `${n} -> ${s}`).toBe(true);
    }
  });
});

describe('resolveSlug', () => {
  it('derives from the name when no slug is given', () => {
    // The duplication this removes:
    //   cf workspace create -n peak-physique-api -s peak-physique-api
    expect(resolveSlug('peak-physique-api')).toBe('peak-physique-api');
    expect(resolveSlug('Peak Physique API')).toBe('peak-physique-api');
  });

  it('prefers an explicit slug when the two should differ', () => {
    expect(resolveSlug('Development', 'dev')).toBe('dev');
  });

  it('rejects an invalid explicit slug locally, before the request', () => {
    expect(() => resolveSlug('Development', 'Dev Env')).toThrow(/Invalid slug/);
  });

  it('suggests a valid form in the rejection message', () => {
    expect(() => resolveSlug('Development', 'Dev Env')).toThrow(/dev-env/);
  });

  it('asks for an explicit slug when the name cannot be slugged', () => {
    expect(() => resolveSlug('日本語')).toThrow(/Could not derive a slug/);
    expect(() => resolveSlug('日本語')).toThrow(/--slug/);
  });
});
