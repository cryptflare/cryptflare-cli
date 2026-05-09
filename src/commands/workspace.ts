import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import * as output from '../lib/output.js';

type WorkspaceItem = { id: string; name: string; slug: string; created_at: string };

export const workspaceCommand = new Command('workspace')
  .alias('ws')
  .description('Manage workspaces');

workspaceCommand
  .command('list')
  .description('List workspaces')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);
      const data = await getClient().workspaces.list({ organisation: org }) as WorkspaceItem[];

      if (opts.json) return output.json(data);
      output.table(data.map((w) => ({ name: w.name, slug: w.slug, id: chalk.dim(w.id) })));
    } catch (err) {
      output.handleError(err);
    }
  });

workspaceCommand
  .command('create')
  .description('Create a workspace')
  .requiredOption('-n, --name <name>', 'Workspace name')
  .requiredOption('-s, --slug <slug>', 'URL-safe slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);
      const data = await getClient().workspaces.create({
        organisation: org,
        name: opts.name,
        slug: opts.slug,
      }) as { id: string; name: string; slug: string };

      if (opts.json) return output.json(data);
      output.success(`Created workspace ${chalk.bold(data.name)} (${data.slug})`);
    } catch (err) {
      output.handleError(err);
    }
  });

workspaceCommand
  .command('delete <slug>')
  .description('Delete a workspace')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (slug: string, opts) => {
    try {
      const org = resolveOrg(opts);

      if (!opts.yes) {
        console.log(chalk.yellow(`This will permanently delete workspace ${chalk.bold(slug)} and all its data.`));
        console.log('Pass --yes to confirm.');
        process.exit(0);
      }

      await getClient().workspaces.delete({ organisation: org, workspace: slug });
      output.success(`Deleted workspace ${chalk.bold(slug)}`);
    } catch (err) {
      output.handleError(err);
    }
  });
