import chalk from 'chalk';

import { APIError, AuthenticationError, ConfigurationError, CryptFlareError } from '@cryptflare/sdk';

export function json(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function table(rows: Record<string, string>[], opts?: { quiet?: boolean }) {
  if (opts?.quiet) {
    rows.forEach((row) => console.log(Object.values(row).join('\t')));
    return;
  }

  if (rows.length === 0) {
    console.log(chalk.dim('No results'));
    return;
  }

  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => (r[k] ?? '').length)),
  );

  const header = keys.map((k, i) => chalk.bold(k.toUpperCase().padEnd(widths[i]))).join('  ');
  console.log(header);
  console.log(chalk.dim('-'.repeat(header.length)));

  rows.forEach((row) => {
    const line = keys.map((k, i) => (row[k] ?? '').padEnd(widths[i])).join('  ');
    console.log(line);
  });
}

export function success(message: string) {
  console.log(chalk.green('✓') + ' ' + message);
}

export function warn(message: string) {
  console.log(chalk.yellow('!') + ' ' + message);
}

export function info(message: string) {
  console.log(chalk.blue('i') + ' ' + message);
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
 * fire before their parents.
 */
export function handleError(err: unknown): never {
  if (err instanceof APIError) {
    const code = err.code ?? 'UNKNOWN';
    console.error(chalk.red(`Error [${code}]`) + ` ${err.message}`);
    if (err instanceof AuthenticationError) {
      console.error(chalk.dim('Run `cf auth login` to authenticate.'));
    }
    if (err.requestId) {
      console.error(chalk.dim(`Request ID: ${err.requestId}`));
    }
    process.exit(1);
  }

  if (err instanceof ConfigurationError) {
    console.error(chalk.red('Error:') + ` ${err.message}`);
    console.error(chalk.dim('Run `cf auth login` to authenticate.'));
    process.exit(1);
  }

  if (err instanceof CryptFlareError) {
    // Connection / timeout errors share the SDK base but lack a stable code
    // we want to branch on.
    const code = err.code ?? 'ERROR';
    console.error(chalk.red(`Error [${code}]`) + ` ${err.message}`);
    process.exit(1);
  }

  if (err instanceof Error) {
    console.error(chalk.red('Error:') + ` ${err.message}`);
    process.exit(1);
  }

  console.error(chalk.red('Unknown error'));
  process.exit(1);
}
