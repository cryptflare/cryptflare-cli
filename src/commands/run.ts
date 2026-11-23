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

import spawn from 'cross-spawn'

import { Command } from 'commander'

import { getClient } from '@/lib/api'
import { renderEnvFile } from '@/lib/env-file'
import { runChildWithCleanup } from '@/lib/local-env/child'
import { Keyring } from '@/lib/local-env/keyring'
import {
  materializeMode,
  prepareRun,
  type MaterializeMode,
  type PreparedRun,
} from '@/lib/local-env/prepare-run'
import { loadLocalFiles, type LocalFilesPlan } from '@/lib/local-env/run-files'
import { resolveContext, type ResolvedContext } from '@/lib/resolve'
import { revealSecrets } from '@/lib/reveal'
import * as output from '@/lib/output'
import { EXIT_CODES } from '@/lib/exit-codes'
import { errorCode } from '@/lib/guards'

async function fetchEnv(ctx: ResolvedContext): Promise<Record<string, string>> {
  const client = getClient()
  const scope = {
    organisation: ctx.org,
    workspace: ctx.workspace,
    environment: ctx.env,
    ...(ctx.pod ? { podId: ctx.pod } : {}),
  }
  // One request for the whole environment instead of a list plus one reveal
  // per key - `cf run` starts a process, so its latency is felt every time.
  return Object.fromEntries(await revealSecrets(client, scope))
}

const NO_LOCAL_FILES: LocalFilesPlan = { env: {}, materialize: [], devVars: [], restored: [] }

/**
 * Decrypts the bound encrypted files in memory and works out what the child
 * needs for them. A key that cannot be fetched stops the run here, before
 * anything starts: an app must not come up with half its configuration.
 */
async function prepareLocalFiles(
  ctx: ResolvedContext,
  argv: string[],
  opts: { localFiles?: boolean; file?: string[] },
  mode: MaterializeMode | null,
): Promise<{ values: Record<string, string>; run: PreparedRun }> {
  let local = NO_LOCAL_FILES
  if (opts.localFiles !== false) {
    try {
      local = await loadLocalFiles({
        cwd: process.cwd(),
        scope: {
          org: ctx.org,
          workspace: ctx.workspace,
          env: ctx.env,
          ...(ctx.pod ? { pod: ctx.pod } : {}),
        },
        files: opts.file ?? [],
        keyring: new Keyring(getClient()),
      })
    } catch (err) {
      output.printError(
        'cf run: the encrypted local files could not be decrypted. Nothing was started.',
      )
      throw err
    }
  }
  const run = prepareRun(argv, local, mode)
  for (const note of run.notes) output.printError(`cf run: ${note}`)
  return { values: local.env, run }
}

/** Signal names map to 128+n by convention, matching what a shell reports. */
const SIGNAL_EXIT_BASE = EXIT_CODES.SIGNAL_BASE
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
}

export const runCommand = new Command('run')
  .description('Run a command with secrets injected as environment variables')
  .argument('[command...]', 'Command and arguments to run')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-b, --binding <file>', 'Use the scope of this bound file from .cryptflare.json')
  .option('--override', 'Let secrets take precedence over existing environment variables')
  .option(
    '--file <path>',
    'Encrypted local file to decrypt into the command (repeatable). Default: the bound files around this directory',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .option(
    '--materialize [mode]',
    'Write plaintext for files the tool reads itself: "in-place" (default, restored on exit) or "temp"',
  )
  .option('--files-only', 'Use only the local files, not the values stored in CryptFlare')
  .option('--no-local-files', 'Ignore encrypted local files')
  // Without this, a flag intended for the child (`-v`, `--watch`) is parsed as
  // one of ours and rejected.
  .passThroughOptions()
  .addHelpText(
    'after',
    `
Inside a project with a .cryptflare.json the workspace and environment come
from the binding nearest the current directory, so no flags and no .env file
are needed.

Examples:
  cf run -- node server.js
  cf run -- npm test
  cf run -b apps/api/.dev.vars -- wrangler dev
  cf run -w my-app -e production -- ./deploy.sh

Encrypted local files (cf:v1 values, see cf env encrypt) are decrypted in
memory with a key fetched once for this run; no plaintext file is written.
  cf run -- wrangler dev                    adds --env-file for the encrypted .dev.vars
  cf run --materialize -- streamlit run app.py   plaintext secrets.toml while it runs

The command's exit code is propagated, so this composes with CI and with
shell && chains.`,
  )
  .action(async (args: string[], opts) => {
    try {
      if (!args || args.length === 0) {
        output.printError('No command specified. Usage: cf run -- <command> [args...]')
        process.exit(EXIT_CODES.USAGE)
      }

      const ctx = resolveContext(opts)
      const mode = materializeMode(opts.materialize)
      const vault = opts.filesOnly ? {} : await fetchEnv(ctx)
      const prepared = await prepareLocalFiles(ctx, args, opts, mode)

      // Default: the ambient environment wins, so a locally exported override
      // is respected. `--override` flips it for the "trust the vault" case.
      // Decrypted local files sit above the vault: they are what this
      // checkout says.
      const env = { ...vault, ...prepared.values }
      const mergedEnv = {
        ...(opts.override ? { ...process.env, ...env } : { ...env, ...process.env }),
        ...prepared.run.env,
      }

      const [command, ...commandArgs] = prepared.run.args
      if (command === undefined)
        output.usageError('Missing command. Usage: cf run -- <command> [args...]')

      // Decrypted local values live only in the child. With `spawn.sync` a
      // SIGTERM to cf (an IDE's stop button, a process manager) killed cf and
      // left the child running on its own; the async path forwards it.
      const { cleanup } = prepared.run
      if (cleanup || Object.keys(prepared.values).length > 0) {
        process.exit(
          await runChildWithCleanup(command, commandArgs, mergedEnv, cleanup ?? (() => undefined)),
        )
      }

      // No shell on POSIX: argv is passed through as a vector, so quoting,
      // spaces and shell metacharacters are inert. On Windows most tools on
      // PATH are `.cmd` shims (npm, pnpm, vite, wrangler), which Node refuses
      // to start without a shell; cross-spawn runs them through cmd.exe with
      // every argument escaped, which keeps the same guarantee there.
      const result = spawn.sync(command, commandArgs, {
        stdio: 'inherit',
        env: mergedEnv,
      })

      if (result.error) {
        const code = errorCode(result.error)
        if (code === 'ENOENT') {
          output.printError(`cf run: command not found: ${command}`)
          process.exit(EXIT_CODES.COMMAND_NOT_FOUND)
        }
        throw result.error
      }

      if (result.signal) {
        const n = SIGNAL_NUMBERS[result.signal] ?? 0
        process.exit(SIGNAL_EXIT_BASE + n)
      }

      process.exit(result.status ?? 0)
    } catch (err) {
      output.handleError(err)
    }
  })

/**
 * Quotes a value for PowerShell. A single-quoted PowerShell string is
 * literal - no `$` expansion, no backtick escapes - and a single quote inside
 * it is written twice. Exported for tests.
 */
export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Output formats of `cf env`. */
export const ENV_FORMATS = ['dotenv', 'shell', 'powershell', 'json'] as const

/** Quotes a value for safe `eval` in a POSIX shell by single-quoting it. Exported for tests. */
export function shellQuote(value: string): string {
  // A single quote is closed, escaped, and reopened - the only way to embed one
  // inside a single-quoted string. The previous double-quoted form left `$`,
  // backticks and `\` live, so a secret containing `$(...)` would execute when
  // the output was eval'd.
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export const envCommand = new Command('env')
  .description('Export secrets in various formats')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-b, --binding <file>', 'Use the scope of this bound file from .cryptflare.json')
  .option('-f, --format <format>', `Output format: ${ENV_FORMATS.join(', ')}`, 'dotenv')
  .addHelpText(
    'after',
    `
Examples:
  eval "$(cf env -f shell)"                    load secrets into the current shell (bash, zsh)
  cf env -f powershell | Invoke-Expression     load secrets into the current PowerShell session
  cf env -f dotenv > .env                      write a dotenv file
  cf env -f json | jq .`,
  )
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts)
      const pairs = await fetchEnv(ctx)

      switch (opts.format) {
        case 'shell':
          Object.entries(pairs).forEach(([k, v]) => output.print(`export ${k}=${shellQuote(v)}`))
          break
        case 'json':
          output.json(pairs)
          break
        case 'powershell':
          Object.entries(pairs).forEach(([k, v]) =>
            output.print(`$env:${k} = ${powershellQuote(v)}`),
          )
          break
        case 'dotenv':
          // The same writer `cf pull` uses, so a value with spaces, `#` or a
          // newline is quoted instead of being printed raw and misread.
          process.stdout.write(renderEnvFile(new Map(Object.entries(pairs))))
          break
        default:
          throw new Error(`Unknown format "${opts.format}". Use ${ENV_FORMATS.join(', ')}.`)
      }
    } catch (err) {
      output.handleError(err)
    }
  })
