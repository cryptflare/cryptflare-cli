import { execFileSync } from 'node:child_process';

import { describe, it, expect } from 'vitest';

import { findNewlineValues } from './sync.js';
import { applyEnvChanges } from '../lib/env-file.js';

describe('findNewlineValues', () => {
  it('names the keys whose values contain a newline', () => {
    const values = new Map([
      ['PLAIN', 'one'],
      ['CERT', '-----BEGIN-----\nabc\n-----END-----'],
      ['ALSO', 'two\nlines'],
    ]);
    expect(findNewlineValues(values).sort()).toEqual(['ALSO', 'CERT']);
  });

  it('is silent when every value is single-line', () => {
    expect(findNewlineValues(new Map([['A', '1'], ['B', '2']]))).toEqual([]);
  });

  it('describes a real limitation - the escaped form does not survive a shell', () => {
    // Pins why the warning exists. The writer emits KEY="line1\nline2"; a
    // POSIX shell treats \n inside double quotes literally, so sourcing the
    // file cannot reconstruct the newline. If this ever starts passing, the
    // encoding changed and the warning should go.
    const { content } = applyEnvChanges('KEY=x', new Map([['KEY', 'line1\nline2']]));
    const sourced = execFileSync('sh', ['-c', `${content}\nprintf %s "$KEY"`], { encoding: 'utf-8' });
    expect(sourced).not.toBe('line1\nline2');
    expect(sourced).toBe('line1\\nline2');
  });
});
