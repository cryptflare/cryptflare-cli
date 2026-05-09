import { Command } from 'commander';
import { execSync } from 'child_process';

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

export const runCommand = new Command('run')
  .description('Run a command with secrets injected as environment variables')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--override', 'Overwrite existing env vars')
  .allowUnknownOption()
  .action(async (opts, cmd) => {
    try {
      const ctx = resolveContext(opts);
      const args = cmd.args;

      if (args.length === 0) {
        console.error('No command specified. Usage: cf run -- <command>');
        process.exit(1);
      }

      const env = await fetchEnv(ctx);

      const mergedEnv = opts.override
        ? { ...process.env, ...env }
        : { ...env, ...process.env };

      const command = args.join(' ');
      execSync(command, {
        stdio: 'inherit',
        env: mergedEnv as Record<string, string>,
      });
    } catch (err) {
      output.handleError(err);
    }
  });

export const envCommand = new Command('env')
  .description('Export secrets in various formats')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-f, --format <format>', 'Output format: shell, dotenv, json', 'dotenv')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts);
      const pairs = await fetchEnv(ctx);

      switch (opts.format) {
        case 'shell':
          Object.entries(pairs).forEach(([k, v]) => console.log(`export ${k}="${v.replace(/"/g, '\\"')}"`));
          break;
        case 'json':
          output.json(pairs);
          break;
        case 'dotenv':
        default:
          Object.entries(pairs).forEach(([k, v]) => console.log(`${k}=${v}`));
          break;
      }
    } catch (err) {
      output.handleError(err);
    }
  });
