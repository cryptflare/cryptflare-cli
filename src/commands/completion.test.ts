import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { buildCompletionCommand } from './completion.js';

/** A miniature program so the tests do not depend on the real command list. */
function fixtureProgram(): Command {
  const program = new Command().name('cf');
  const secret = new Command('secret').option('-w, --workspace <slug>', 'ws');
  secret.command('list').option('--json', 'json');
  secret.command('set').option('--file <path>', 'file');
  program.addCommand(secret);
  program.addCommand(new Command('whoami'));
  return program;
}

function generate(shell: string, program = fixtureProgram()): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((v: unknown) => {
    lines.push(String(v));
  });
  buildCompletionCommand(program).parse(['node', 'cf', shell]);
  spy.mockRestore();
  return lines.join('\n');
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cf-completion-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('completion generation', () => {
  it('lists top-level commands for bash', () => {
    const script = generate('bash');
    expect(script).toContain('secret');
    expect(script).toContain('whoami');
    expect(script).toContain('complete -F _cf_completion cf');
  });

  it('includes subcommands and flags per command', () => {
    const script = generate('bash');
    expect(script).toContain('list');
    expect(script).toContain('--workspace');
    expect(script).toContain('--json');
  });

  it('emits a valid bash script', () => {
    // Generating text that does not parse would be worse than no completions.
    const p = join(dir, 'cf.bash');
    writeFileSync(p, generate('bash'));
    expect(() => execFileSync('bash', ['-n', p])).not.toThrow();
  });

  it('actually completes subcommands when sourced', () => {
    const p = join(dir, 'cf.bash');
    writeFileSync(p, generate('bash'));
    const out = execFileSync(
      'bash',
      ['-c', `source ${p}; COMP_WORDS=(cf secret ""); COMP_CWORD=2; _cf_completion; echo "\${COMPREPLY[@]}"`],
      { encoding: 'utf-8' },
    );
    expect(out).toContain('list');
    expect(out).toContain('set');
  });

  it('emits a zsh script with a compdef header', () => {
    const script = generate('zsh');
    expect(script.startsWith('#compdef cf')).toBe(true);
    expect(script).toContain('_cf()');
  });

  it('emits fish completions that disable file matching', () => {
    const script = generate('fish');
    // Without `-f`, fish offers filenames where a subcommand belongs.
    expect(script).toContain('complete -c cf -f');
    expect(script).toContain('__fish_use_subcommand');
  });

  it('derives the tree from the live program, so it cannot drift', () => {
    const program = fixtureProgram();
    program.addCommand(new Command('brand-new-command'));
    expect(generate('bash', program)).toContain('brand-new-command');
  });

  it('rejects an unsupported shell by name', () => {
    const program = fixtureProgram();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    buildCompletionCommand(program).parse(['node', 'cf', 'powershell']);
    expect(err.mock.calls.flat().join(' ')).toMatch(/Unsupported shell/);
    exit.mockRestore();
  });
});
