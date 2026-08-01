import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';

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

      const installer = chooseInstaller();
      console.log(`Running \`${installer.cmd} ${installer.args.join(' ')}\`...`);

      await new Promise<void>((resolve, reject) => {
        const child = spawn(installer.cmd, installer.args, { stdio: 'inherit' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`installer exited ${code}`))));
      });

      console.log(`${chalk.green('✓')} Updated to ${latest}.`);
    } catch (err) {
      handleError(err);
    }
  });

function chooseInstaller(): { cmd: string; args: string[] } {
  // Heuristic: respect the package manager that installed the CLI when we
  // can detect it. Falls back to npm.
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm/') || hasBin('pnpm')) {
    return { cmd: 'pnpm', args: ['add', '-g', `${NPM_PACKAGE}@latest`] };
  }
  if (ua.startsWith('bun/') || hasBin('bun')) {
    return { cmd: 'bun', args: ['add', '-g', `${NPM_PACKAGE}@latest`] };
  }
  if (ua.startsWith('yarn/') || hasBin('yarn')) {
    return { cmd: 'yarn', args: ['global', 'add', `${NPM_PACKAGE}@latest`] };
  }
  return { cmd: 'npm', args: ['install', '-g', `${NPM_PACKAGE}@latest`] };
}

function hasBin(name: string): boolean {
  // Cheap check: search PATH for an executable named `name`.
  const path = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  return path.split(sep).some((dir) => {
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const candidate = `${dir}/${name}`;
      return fs.existsSync(candidate) || fs.existsSync(`${candidate}.cmd`);
    } catch {
      return false;
    }
  });
}
