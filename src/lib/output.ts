import { format } from 'node:util'

import chalk from 'chalk'

import {
  APIError,
  AuthenticationError,
  ConfigurationError,
  ConnectionError,
  CryptFlareError,
  TimeoutError,
} from '@cryptflare/sdk'

import { EXIT_CODES } from '@/lib/exit-codes'

/**
 * Status marks shown before a result line. They are the CLI's own UI (the
 * same marks `cf doctor`, `cf sync` and `cf update` have always printed), kept
 * here so every command draws them the same way.
 */
export const MARK = { ok: '\u2713', fail: '\u2717' } as const

/** Writes one line of command output to stdout (data a user may pipe). Formats like `console.log`. */
export function print(...parts: unknown[]): void {
  process.stdout.write(`${format(...parts)}\n`)
}

/** Writes one line to stderr (diagnostics, prompts, progress), never mixed into piped stdout. */
export function printError(...parts: unknown[]): void {
  process.stderr.write(`${format(...parts)}\n`)
}

export function json(data: unknown) {
  print(JSON.stringify(data, null, 2))
}

export function table(rows: Record<string, string>[], opts?: { quiet?: boolean }) {
  if (opts?.quiet) {
    rows.forEach((row) => print(Object.values(row).join('\t')))
    return
  }

  if (rows.length === 0) {
    print(chalk.dim('No results'))
    return
  }

  const keys = Object.keys(rows[0] ?? {})
  const columns = keys.map((key) => ({
    key,
    width: Math.max(key.length, ...rows.map((r) => (r[key] ?? '').length)),
  }))

  const header = columns
    .map(({ key, width }) => chalk.bold(key.toUpperCase().padEnd(width)))
    .join('  ')
  print(header)
  print(chalk.dim('-'.repeat(header.length)))

  rows.forEach((row) => {
    print(columns.map(({ key, width }) => (row[key] ?? '').padEnd(width)).join('  '))
  })
}

export function success(message: string) {
  print(`${chalk.green(MARK.ok)} ${message}`)
}

/**
 * Warnings and notes go to stderr so they never end up inside piped data
 * (`cf env > .env`, `cf secret list --json | jq`).
 */
export function warn(message: string) {
  printError(chalk.yellow('!') + ' ' + message)
}

/** Status notes for the person at the terminal. Written to stderr, see {@link warn}. */
export function info(message: string) {
  printError(chalk.blue('i') + ' ' + message)
}

/**
 * Prints a usage problem (missing or invalid flag) to stderr and exits with
 * `EXIT_CODES.USAGE`.
 */
export function usageError(message: string, hint?: string): never {
  printError(chalk.red('Error:') + ` ${message}`)
  if (hint) printError(hint)
  process.exit(EXIT_CODES.USAGE)
}

/**
 * Pretty-prints an error to stderr and exits the process. Branches on the
 * SDK's error class hierarchy:
 *   `APIError`             - server returned a non-2xx response (4xx/5xx).
 *     `AuthenticationError`  - 401, hint user to log in.
 *   `ConfigurationError`   - thrown before any request leaves the CLI
 *                            (no token loaded, etc.). Hint user to log in.
 *   `CryptFlareError`      - any other SDK error (connection, timeout).
 *   `Error`                - non-SDK runtime error.
 *
 * `instanceof` checks are ordered most-specific first so subclass branches
 * fire before their parents. Exit codes come from `EXIT_CODES`: 3 for auth,
 * 4 for network and timeouts, 1 for everything else.
 */
export function handleError(err: unknown): never {
  if (err instanceof APIError) {
    const code = err.code ?? 'UNKNOWN'
    printError(chalk.red(`Error [${code}]`) + ` ${err.message}`)
    if (err instanceof AuthenticationError) {
      printError(chalk.dim('Run `cf auth login` to authenticate.'))
    }
    if (err.requestId) {
      printError(chalk.dim(`Request ID: ${err.requestId}`))
    }
    process.exit(err instanceof AuthenticationError ? EXIT_CODES.AUTH : EXIT_CODES.ERROR)
  }

  if (err instanceof ConfigurationError) {
    printError(chalk.red('Error:') + ` ${err.message}`)
    printError(chalk.dim('Run `cf auth login` to authenticate.'))
    process.exit(EXIT_CODES.AUTH)
  }

  if (err instanceof CryptFlareError) {
    // Connection / timeout errors share the SDK base but lack a stable code
    // we want to branch on.
    const code = err.code ?? 'ERROR'
    printError(chalk.red(`Error [${code}]`) + ` ${err.message}`)
    const network = err instanceof ConnectionError || err instanceof TimeoutError
    process.exit(network ? EXIT_CODES.NETWORK : EXIT_CODES.ERROR)
  }

  if (err instanceof Error) {
    printError(chalk.red('Error:') + ` ${err.message}`)
    process.exit(EXIT_CODES.ERROR)
  }

  printError(chalk.red('Unknown error'))
  process.exit(EXIT_CODES.ERROR)
}
