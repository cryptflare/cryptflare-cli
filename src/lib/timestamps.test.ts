import { describe, it, expect, vi, afterEach } from 'vitest';

import { parseApiTimestamp, timeAgo } from './timestamps.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('parseApiTimestamp', () => {
  it('treats a zone-less SQLite datetime as UTC, not local', () => {
    // The regression: `datetime('now')` returns this shape, `new Date()` reads
    // it as local time, and every non-UTC reader is wrong by their own offset.
    expect(parseApiTimestamp('2026-07-29 02:51:23').toISOString()).toBe('2026-07-29T02:51:23.000Z');
  });

  it('handles fractional seconds on the SQLite shape', () => {
    expect(parseApiTimestamp('2026-07-29 02:51:23.456').toISOString()).toBe('2026-07-29T02:51:23.456Z');
  });

  it('leaves a proper ISO-8601 string untouched', () => {
    expect(parseApiTimestamp('2026-07-29T02:51:23.000Z').toISOString()).toBe('2026-07-29T02:51:23.000Z');
  });

  it('preserves a non-UTC offset rather than forcing UTC', () => {
    expect(parseApiTimestamp('2026-07-29T12:51:23+10:00').toISOString()).toBe('2026-07-29T02:51:23.000Z');
  });

  it('returns an invalid Date for junk, matching new Date()', () => {
    expect(Number.isNaN(parseApiTimestamp('not-a-date').getTime())).toBe(true);
  });

  it('does not mistake an ISO string for the SQLite shape', () => {
    // A space-separated string with a T must not be rewritten.
    expect(parseApiTimestamp('2026-07-29T02:51:23Z').toISOString()).toBe('2026-07-29T02:51:23.000Z');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-07-29T02:51:23.000Z');

  it('reports a freshly created secret as just now, whatever the shape', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    // Both spellings describe the same instant and must read the same. Before
    // the fix the SQLite shape reported the reader's UTC offset instead - the
    // "10h ago" seen from UTC+10 on a secret created seconds earlier.
    expect(timeAgo('2026-07-29 02:51:20')).toBe('just now');
    expect(timeAgo('2026-07-29T02:51:20.000Z')).toBe('just now');
  });

  it('scales through minutes, hours and days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo('2026-07-29 02:21:23')).toBe('30m ago');
    expect(timeAgo('2026-07-29 00:51:23')).toBe('2h ago');
    expect(timeAgo('2026-07-26 02:51:23')).toBe('3d ago');
  });

  it('clamps a marginally future timestamp instead of printing a negative', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    expect(timeAgo('2026-07-29T02:51:25.000Z')).toBe('just now');
  });

  it('returns "unknown" rather than NaN for unparseable input', () => {
    expect(timeAgo('garbage')).toBe('unknown');
  });
});
