import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { resolveSecretValue } from './secret-input.js';

let dir: string;
let stderr: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-secret-input-'));
  stderr = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('resolveSecretValue', () => {
  it('reads from a file given with --file', async () => {
    const p = join(dir, 'v.txt');
    writeFileSync(p, 'sk_live_from_file');
    expect(await resolveSecretValue({ file: p })).toBe('sk_live_from_file');
  });

  it('strips exactly one trailing newline from a file', async () => {
    // `echo "$V" > v.txt` adds one; a secret almost never wants it.
    const p = join(dir, 'v.txt');
    writeFileSync(p, 'value\n');
    expect(await resolveSecretValue({ file: p })).toBe('value');
  });

  it('keeps interior newlines, so a PEM key survives', async () => {
    const pem = '-----BEGIN KEY-----\nline2\n-----END KEY-----';
    const p = join(dir, 'key.pem');
    writeFileSync(p, `${pem}\n`);
    expect(await resolveSecretValue({ file: p })).toBe(pem);
  });

  it('supports the @path shorthand', async () => {
    const p = join(dir, 'v.txt');
    writeFileSync(p, 'from_at_path');
    expect(await resolveSecretValue({ inline: `@${p}` })).toBe('from_at_path');
  });

  it('accepts an inline value but warns about shell history', async () => {
    expect(await resolveSecretValue({ inline: 'sk_live_inline' })).toBe('sk_live_inline');
    expect(stderr.join('\n')).toMatch(/shell history/);
  });

  it('warns on stderr, never stdout, so --json and pipes stay clean', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resolveSecretValue({ inline: 'x' });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('does not warn when the value came from a file', async () => {
    const p = join(dir, 'v.txt');
    writeFileSync(p, 'quiet');
    await resolveSecretValue({ file: p });
    expect(stderr.join('\n')).not.toMatch(/shell history/);
  });

  it('rejects an empty inline value rather than sending it', async () => {
    // The server rejects empty values; failing here saves a round trip.
    await expect(resolveSecretValue({ inline: '' })).rejects.toThrow(/empty/);
  });

  it('rejects an empty file', async () => {
    const p = join(dir, 'empty.txt');
    writeFileSync(p, '');
    await expect(resolveSecretValue({ file: p })).rejects.toThrow(/empty/);
  });

  it('reports a missing file by path', async () => {
    await expect(resolveSecretValue({ file: join(dir, 'nope.txt') })).rejects.toThrow(/nope\.txt/);
  });

  it('prefers --file over an inline value', async () => {
    const p = join(dir, 'v.txt');
    writeFileSync(p, 'from_file');
    expect(await resolveSecretValue({ inline: 'from_inline', file: p })).toBe('from_file');
  });
});
