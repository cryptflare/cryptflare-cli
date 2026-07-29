/**
 * `cf run` and `cf env` - inject secrets into a process or a shell.
 *
 * `cf run` had never worked in any published version. It declared no positional
 * argument, so commander rejected the command outright:
 *
 *   $ cf run -w app -e dev -- echo hello
 *   error: too many arguments for 'run'. Expected 0 arguments but got 2.
 *
 * `allowUnknownOption()` permits unknown *options*, not operands. The fix is a
 * variadic `[command...]` argument plus `passThroughOptions`, so flags meant for
 * the child (`-v`, `--watch`) reach the child rather than being parsed by us.
 *
 * Two further problems were fixed while rewriting it:
 *
 * 1. The command was reassembled with `args.join(' ')` and handed to
 *    `execSync`, which runs it through a shell. Any argument containing a
 *    space, quote, `;`, `&&` or `$(...)` was reinterpreted - so
 *    `cf run -- node -e 'console.log("a b")'` did not survive, and an argument
 *    from an untrusted source could execute arbitrary commands. It now uses
 *    `spawnSync` with the argv vector intact and no shell.
 *
 * 2. The child's exit code was swallowed. `execSync` throws on any non-zero
 *    exit and the catch turned that into a CryptFlare-branded error and exit 1,
 *    so `cf run -- npm test` reported the same code whether tests failed with 1
 *    or 2 - and buried the reason. The child's status is now propagated
 *    verbatim, and a signal death becomes 128+signal as a shell would report it.
 */

import { spawnSync } from 'node:child_process';

import { Command } from 'commander';

import { getClient } from '../lib/api.js';
import { resolveContext } from '../lib/resolve.js';
import * as output from '../lib/output.js';

async function fetchEnv(ctx: { org: string; workspace: string; env: string }): Promise<Record<string, string>> {
  const client = getClient();
  const scope = { organisation: ctx.org, workspace: ctx.workspace, environment: ctx.env };
  const pairs: Record<string, string> = {};
  const page = await client.secrets.list(scope);
  for await (const secret of page) {
    const revealed = await client.secrets.reveal({ ...scope, key: secret.key });
    pairs[secret.key] = revealed.value;
  }
  return pairs;
}

/** Signal names map to 128+n by convention, matching what a shell reports. */
const SIGNAL_EXIT_BASE = 128;
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15,
};

export const runCommand = new Command('run')
  .description('Run a command with secrets injected as environment variables')
  .argument('[command...]', 'Command and arguments to run')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--override', 'Let secrets take precedence over existing environment variables')
  // Without this, a flag intended for the child (`-v`, `--watch`) is parsed as
  // one of ours and rejected.
  .passThroughOptions()
  .addHelpText(
    'after',
    `
Examples:
  cf run -- node server.js
  cf run -- npm test
  cf run -w my-app -e production -- ./deploy.sh

The command's exit code is propagated, so this composes with CI and with
shell && chains.`,
  )
  .action(async (args: string[], opts) => {
    try {
      if (!args || args.length === 0) {
        console.error('No command specified. Usage: cf run -- <command> [args...]');
        process.exit(1);
      }

      const ctx = resolveContext(opts);
      const env = await fetchEnv(ctx);

      // Default: the ambient environment wins, so a locally exported override
      // is respected. `--override` flips it for the "trust the vault" case.
      const mergedEnv = opts.override
        ? { ...process.env, ...env }
        : { ...env, ...process.env };

      const [command, ...commandArgs] = args;

      // No shell: argv is passed through as a vector, so quoting, spaces and
      // shell metacharacters are inert.
      const result = spawnSync(command!, commandArgs, {
        stdio: 'inherit',
        env: mergedEnv as NodeJS.ProcessEnv,
        shell: false,
      });

      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          console.error(`cf run: command not found: ${command}`);
          process.exit(127); // Conventional "command not found".
        }
        throw result.error;
      }

      if (result.signal) {
        const n = SIGNAL_NUMBERS[result.signal] ?? 0;
        process.exit(SIGNAL_EXIT_BASE + n);
      }

      process.exit(result.status ?? 0);
    } catch (err) {
      output.handleError(err);
    }
  });

/** Quotes a value for safe `eval` in a POSIX shell by single-quoting it. Exported for tests. */
export function shellQuote(value: string): string {
  // A single quote is closed, escaped, and reopened - the only way to embed one
  // inside a single-quoted string. The previous double-quoted form left `$`,
  // backticks and `\` live, so a secret containing `$(...)` would execute when
  // the output was eval'd.
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const envCommand = new Command('env')
  .description('Export secrets in various formats')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-f, --format <format>', 'Output format: shell, dotenv, json', 'dotenv')
  .addHelpText(
    'after',
    `
Examples:
  eval "$(cf env -f shell)"     load secrets into the current shell
  cf env -f dotenv > .env       write a dotenv file
  cf env -f json | jq .`,
  )
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts);
      const pairs = await fetchEnv(ctx);

      switch (opts.format) {
        case 'shell':
          Object.entries(pairs).forEach(([k, v]) => console.log(`export ${k}=${shellQuote(v)}`));
          break;
        case 'json':
          output.json(pairs);
          break;
        case 'dotenv':
          Object.entries(pairs).forEach(([k, v]) => console.log(`${k}=${v}`));
          break;
        default:
          throw new Error(`Unknown format "${opts.format}". Use shell, dotenv, or json.`);
      }
    } catch (err) {
      output.handleError(err);
    }
  });
