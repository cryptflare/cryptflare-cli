/**
 * Feeds decrypted values to `wrangler dev` without a plaintext file.
 *
 * Verified against wrangler 4.80.0 and 4.157.0 (`getVarsForDev`,
 * `loadDotEnv` in `wrangler-dist/cli.js`): when `.dev.vars` exists and no
 * `--env-file` is given, wrangler binds `.dev.vars` and ignores the process
 * environment. With `--env-file`, `.dev.vars` is skipped, the named files are
 * loaded, and `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` merges `process.env` in,
 * where dotenv-expand lets an existing process value win over the file's.
 *
 * So the encrypted file itself is passed as `--env-file`, and the decrypted
 * values in the child's environment override its ciphertext.
 */

import { basename } from 'node:path'

const WRANGLER = /^wrangler(\.c?js)?$/i

export type WranglerAdaptation = { args: string[]; env: Record<string, string>; adapted: boolean }

/** The `--env <name>` / `-e <name>` value of a wrangler command line, if any. */
function wranglerEnv(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--env' || arg === '-e') return args[i + 1]
    if (arg.startsWith('--env=')) return arg.slice('--env='.length)
  }
  return undefined
}

/** Whether a command line starts `wrangler dev` directly (argv, not a script). */
export function wranglerDevIndex(argv: readonly string[]): number {
  const at = argv.findIndex((token) => WRANGLER.test(basename(token)))
  if (at === -1) return -1
  const sub = argv.slice(at + 1).find((token) => !token.startsWith('-'))
  return sub === 'dev' ? argv.indexOf('dev', at + 1) : -1
}

/**
 * Adds `--env-file <encrypted .dev.vars>` and `CLOUDFLARE_INCLUDE_PROCESS_ENV`
 * to a direct `wrangler dev` command line.
 *
 * @param devVars Absolute paths of bound `.dev.vars*` files that hold ciphertext.
 */
export function adaptWrangler(
  argv: readonly string[],
  devVars: readonly string[],
): WranglerAdaptation {
  const args = [...argv]
  const dev = wranglerDevIndex(args)
  const hasEnvFile = args.some((arg) => arg === '--env-file' || arg.startsWith('--env-file='))
  if (dev === -1 || hasEnvFile || devVars.length === 0) return { args, env: {}, adapted: false }

  const stage = wranglerEnv(args.slice(dev + 1))
  const file =
    (stage && devVars.find((path) => basename(path) === `.dev.vars.${stage}`)) ??
    devVars.find((path) => basename(path) === '.dev.vars') ??
    devVars[0] ??
    ''
  args.splice(dev + 1, 0, '--env-file', file)
  return { args, env: { CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true' }, adapted: true }
}
