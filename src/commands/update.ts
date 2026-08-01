import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleError } from '../lib/output.js';
import * as progress from '../lib/progress.js';

const NPM_PACKAGE = '@cryptflare/cli';

export const updateCommand = new Command('update')
  .description('Self-update the CLI to the latest published version')
  .option('--check', 'Only check for an update; do not install')
  .action(async (opts) => {
    try {
      const installed = (await import('../version.js')).VERSION;
      progress.start(`Checking npm for the latest ${NPM_PACKAGE}...`);

      const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(NPM_PACKAGE)}/latest`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) {
        progress.fail(`Could not reach npm: HTTP ${res.status}`);
        process.exit(1);
      }
      const body = (await res.json()) as { version: string };
      const latest = body.version;
      progress.stop();

      if (latest === installed) {
        console.log(`${chalk.green('✓')} You are on the latest version (${installed}).`);
        return;
      }

      console.log(`Update available: ${chalk.dim(installed)} -> ${chalk.bold.green(latest)}`);

      if (opts.check) return;

      const root = installRoot();
      const installer = chooseInstaller(root);
      console.log(`Running \`${installer.cmd} ${installer.args.join(' ')}\`...`);

      await new Promise<void>((resolve, reject) => {
        const child = spawn(installer.cmd, installer.args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`installer exited ${code}`))));
      });

      // Never claim success on the installer's exit code alone. When the
      // wrong manager was chosen it exited 0 having installed into a tree this
      // CLI does not load from, and the old version kept running.
      const onDisk = root ? installedVersionOnDisk(root) : null;
      if (onDisk === latest) {
        console.log(`${chalk.green('✓')} Updated to ${latest}.`);
        return;
      }
      if (onDisk === null) {
        console.log(`${chalk.green('✓')} Installer finished. Run ${chalk.cyan('cf --version')} to confirm.`);
        return;
      }
      console.log();
      console.log(`${chalk.yellow('!')} ${installer.cmd} reported success, but ${root} still holds ${onDisk}.`);
      console.log(chalk.dim(`  The copy on your PATH was not replaced. Install it directly with:`));
      console.log(`    ${chalk.cyan(`npm install -g ${NPM_PACKAGE}@latest`)}`);
      process.exitCode = 1;
    } catch (err) {
      handleError(err);
    }
  });

/**
 * Finds the package root of the running CLI.
 *
 * Everything below keys off where this copy actually lives, not what happens
 * to be installed on the machine.
 */
function installRoot(): string | null {
  // dist/index.js -> package root. Walk up looking for our own package.json
  // rather than assuming a fixed depth, since the bundle layout can change.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i += 1) {
    const candidate = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as { name?: string };
      if (pkg.name === NPM_PACKAGE) return dir;
    } catch {
      // Keep walking - a missing or unreadable package.json just means
      // this is not the root yet.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Version currently on disk at `root`, which is what a re-run would load. */
function installedVersionOnDisk(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Picks the package manager that owns this installation.
 *
 * This used to pick whichever manager existed on PATH, checking pnpm first.
 * On any machine with pnpm installed - every machine with a pnpm monorepo -
 * `cf update` ran `pnpm add -g` against a CLI that npm had installed. pnpm
 * wrote into its own global tree, the npm copy on PATH was never touched, and
 * the command still printed "Updated to x.y.z". The update silently did
 * nothing, every time.
 *
 * The install path is the evidence: a pnpm global install lives under pnpm's
 * store, a bun one under ~/.bun, and npm's under a node_modules it owns.
 */
export function chooseInstaller(root: string | null): { cmd: string; args: string[] } {
  const path = (root ?? '').replace(/\\/g, '/');

  if (/[/\\]\.?pnpm[/\\]|[/\\]pnpm[/\\]global[/\\]/.test(path) || path.includes('/pnpm/')) {
    return { cmd: 'pnpm', args: ['add', '-g', `${NPM_PACKAGE}@latest`] };
  }
  if (path.includes('/.bun/')) {
    return { cmd: 'bun', args: ['add', '-g', `${NPM_PACKAGE}@latest`] };
  }
  if (path.includes('/yarn/global/') || path.includes('/.yarn/')) {
    return { cmd: 'yarn', args: ['global', 'add', `${NPM_PACKAGE}@latest`] };
  }
  return { cmd: 'npm', args: ['install', '-g', `${NPM_PACKAGE}@latest`] };
}
