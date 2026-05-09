import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { getOrg, setOrg } from '../lib/config.js';
import * as output from '../lib/output.js';

type OrgListItem = { id: string; name: string; plan: string; role: string; createdAt: string };

export const orgCommand = new Command('org')
  .description('Manage organisations');

orgCommand
  .command('list')
  .description('List your organisations')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const data = await getClient().organisations.list() as OrgListItem[];

      if (opts.json) return output.json(data);

      const currentOrg = getOrg();
      output.table(
        data.map((o) => ({
          name: o.id === currentOrg ? chalk.cyan('● ' + o.name) : '  ' + o.name,
          plan: o.plan,
          role: o.role,
          id: chalk.dim(o.id),
        })),
      );
    } catch (err) {
      output.handleError(err);
    }
  });

orgCommand
  .command('select')
  .description('Select the active organisation')
  .argument('[id]', 'Organisation ID (interactive if omitted)')
  .action(async (id?: string) => {
    try {
      if (id) {
        setOrg(id);
        output.success(`Active organisation: ${chalk.bold(id)}`);
        return;
      }

      const data = await getClient().organisations.list() as OrgListItem[];

      if (data.length === 0) {
        console.log(chalk.dim('No organisations found.'));
        return;
      }

      if (data.length === 1) {
        setOrg(data[0]!.id);
        output.success(`Active organisation: ${chalk.bold(data[0]!.name)}`);
        return;
      }

      console.log(chalk.bold('Select an organisation:'));
      data.forEach((o, i) => {
        console.log(`  ${chalk.dim(`${i + 1}.`)} ${o.name} ${chalk.dim(`(${o.plan})`)} - ${chalk.dim(o.id)}`);
      });
      console.log();
      console.log(`Run: ${chalk.bold('cf org select <id>')}`);
    } catch (err) {
      output.handleError(err);
    }
  });

orgCommand
  .command('current')
  .description('Show the active organisation')
  .action(() => {
    const org = getOrg();
    if (!org) {
      console.log(chalk.dim('No organisation selected. Run `cf org select`.'));
      return;
    }
    console.log(org);
  });
