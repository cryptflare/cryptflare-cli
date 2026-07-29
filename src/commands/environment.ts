import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import * as output from '../lib/output.js';
import { resolveSlug } from '../lib/slug.js';

type EnvironmentItem = { id: string; name: string; slug: string; created_at: string };

export const environmentCommand = new Command('environment')
  .alias('env-mgmt')
  .description('Manage environments');

environmentCommand
  .command('list')
  .description('List environments in a workspace')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);
      const workspace = opts.workspace;
      if (!workspace) {
        console.error('Workspace required. Pass --workspace.');
        process.exit(1);
      }

      const data = await getClient().environments.list({
        organisation: org,
        workspace,
      }) as EnvironmentItem[];

      if (opts.json) return output.json(data);
      output.table(data.map((e) => ({ name: e.name, slug: e.slug, id: chalk.dim(e.id) })));
    } catch (err) {
      output.handleError(err);
    }
  });

environmentCommand
  .command('create')
  .description('Create an environment')
  .requiredOption('-n, --name <name>', 'Environment name')
  .option('-s, --slug <slug>', 'URL-safe slug (derived from --name when omitted)')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);
      const workspace = opts.workspace;
      if (!workspace) {
        console.error('Workspace required. Pass --workspace.');
        process.exit(1);
      }

      const data = await getClient().environments.create({
        organisation: org,
        workspace,
        name: opts.name,
        slug: resolveSlug(opts.name, opts.slug),
      }) as { id: string; name: string; slug: string };

      if (opts.json) return output.json(data);
      output.success(`Created environment ${chalk.bold(data.name)} (${data.slug})`);
    } catch (err) {
      output.handleError(err);
    }
  });
