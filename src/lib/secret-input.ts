/**
 * Reads a secret value without putting it on the command line.
 *
 * `cf secret set KEY VALUE` and `cf secret rotate KEY --value VALUE` took the
 * value as an argument. That writes every secret you set into shell history
 * (`~/.bash_history`, `~/.zsh_history`), exposes it in `ps` output to any other
 * user on the machine for the lifetime of the process, and leaves it in
 * terminal scrollback and CI job logs.
 *
 * Every mature secrets CLI avoids this: `gh secret set` reads stdin, `wrangler
 * secret put` prompts, `vault kv put` supports `@file`. This module gives the
 * same three routes, in the order a caller would expect:
 *
 *   1. `--file <path>` / `@path`  - read from a file, trailing newline stripped
 *   2. piped stdin                - `echo -n "$V" | cf secret set KEY`
 *   3. interactive prompt         - hidden input, nothing echoed
 *
 * The inline forms still work, because breaking existing scripts to fix an
 * ergonomics problem is a poor trade - but they warn, once, on stderr, so the
 * warning cannot corrupt piped output.
 */

import { readFileSync } from 'node:fs';

import chalk from 'chalk';
import prompts from 'prompts';

export type SecretValueSource = {
  /** Positional or `--value`. Present means it came from the command line. */
  inline?: string | undefined;
  /** `--file <path>`, or an `@path` passed inline. */
  file?: string | undefined;
  /** Label used in the interactive prompt. */
  promptLabel?: string;
};

/**
 * Warns that a value was supplied on the command line. stderr, so it never
 * contaminates `--json` output or a pipeline.
 */
function warnInline(): void {
  console.error(
    chalk.yellow('!') +
      ' Secret value passed on the command line - it will be stored in your shell history.\n' +
      chalk.dim('  Prefer:  cf secret set KEY            (prompts, hidden)\n') +
      chalk.dim('           echo -n "$VALUE" | cf secret set KEY\n') +
      chalk.dim('           cf secret set KEY --file ./value.txt'),
  );
}

/** True when stdin is a pipe or file rather than a terminal. */
export function hasPipedStdin(): boolean {
  return !process.stdin.isTTY;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  // Strip exactly one trailing newline: `echo "$V" |` adds one, and a secret
  // almost never wants it. `printf` or `echo -n` remain byte-exact.
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
}

function readFromFile(path: string): string {
  return readFileSync(path, 'utf-8').replace(/\r?\n$/, '');
}

/**
 * Resolves the secret value from whichever source is available.
 *
 * @throws when no source yields a value, or the value is empty - the server
 *         rejects empty values, so failing here saves a round trip.
 */
export async function resolveSecretValue(source: SecretValueSource): Promise<string> {
  const { inline, file, promptLabel = 'Secret value' } = source;

  // `@path` is a long-standing convention (curl, vault) for "read this file".
  if (inline?.startsWith('@')) {
    const value = readFromFile(inline.slice(1));
    if (!value) throw new Error(`${inline.slice(1)} is empty.`);
    return value;
  }

  if (file) {
    const value = readFromFile(file);
    if (!value) throw new Error(`${file} is empty.`);
    return value;
  }

  if (inline !== undefined) {
    warnInline();
    if (!inline) throw new Error('Secret value is empty.');
    return inline;
  }

  if (hasPipedStdin()) {
    const value = await readStdin();
    if (!value) throw new Error('No value received on stdin.');
    return value;
  }

  const { value } = await prompts(
    { type: 'password', name: 'value', message: promptLabel },
    { onCancel: () => { throw new Error('Cancelled.'); } },
  );
  if (!value) throw new Error('Secret value is empty.');
  return value as string;
}
