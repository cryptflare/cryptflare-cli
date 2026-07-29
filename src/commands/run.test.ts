import { execFileSync } from 'node:child_process';

import { describe, it, expect } from 'vitest';

import { shellQuote } from './run.js';

/** Round-trips through a real shell: what does `eval` actually produce? */
function evalInShell(exported: string): string {
  return execFileSync('sh', ['-c', `${exported}; printf '%s' "$K"`], { encoding: 'utf-8' });
}

describe('shellQuote', () => {
  it('leaves a plain value intact', () => {
    expect(evalInShell(`export K=${shellQuote('simple')}`)).toBe('simple');
  });

  it('does not execute command substitution in a secret value', () => {
    // The previous double-quoted form left `$(...)` live, so a secret
    // containing it executed when `cf env -f shell` output was eval'd.
    const value = 'a$(whoami)b';
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });

  it('does not expand a variable reference', () => {
    const value = 'prefix-$HOME-suffix';
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });

  it('does not execute backticks', () => {
    const value = 'a`whoami`b';
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });

  it('survives an embedded single quote', () => {
    // The one character single-quoting cannot contain directly.
    const value = "it's a secret";
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });

  it('survives double quotes and backslashes', () => {
    const value = 'say "hi" \\ then stop';
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });

  it('preserves whitespace exactly', () => {
    const value = '  leading and trailing  ';
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });

  it('cannot be escaped to inject a second command', () => {
    // If quoting were broken this would create the file; the assertion is that
    // the value comes back verbatim instead.
    const value = "'; touch /tmp/cf-injection-canary; echo '";
    expect(evalInShell(`export K=${shellQuote(value)}`)).toBe(value);
  });
});
