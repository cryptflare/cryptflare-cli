import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../lib/api.js';
import { getOrg, getConfigPath, getDefault } from '../lib/config.js';
import * as output from '../lib/output.js';

export const whoamiCommand = new Command('whoami')
  .description('Show current authentication, organisation, and plan details')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      // We can introspect the bearer credential without an active-org
      // selection, so don't require CF_ORG / config-saved org just to
      // call this. When no org is set we render "(none selected)" in
      // the org block instead of erroring.
      const org = getOrg();

      const me = await getClient().auth.getMe() as unknown as {
        user: { id: string; email: string; name: string | null };
        organisations: Array<{
          id: string;
          name: string;
          role: string;
          plan: string;
          dataRegion: string;
        }>;
      };
      const { user, organisations } = me;

      const activeOrg = organisations.find((o) => o.id === org) ?? organisations[0];

      if (opts.json) {
        return output.json({
          user,
          organisation: activeOrg ?? null,
          defaults: {
            workspace: getDefault('workspace') ?? null,
            environment: getDefault('environment') ?? null,
          },
          configPath: getConfigPath(),
        });
      }

      console.log();
      console.log(chalk.bold('  User'));
      console.log(`  ${chalk.dim('Name:')}     ${user.name ?? chalk.dim('(not set)')}`);
      console.log(`  ${chalk.dim('Email:')}    ${user.email}`);
      console.log(`  ${chalk.dim('ID:')}       ${chalk.dim(user.id)}`);
      console.log();

      if (activeOrg) {
        console.log(chalk.bold('  Organisation'));
        console.log(`  ${chalk.dim('Name:')}     ${activeOrg.name}`);
        console.log(`  ${chalk.dim('Plan:')}     ${planBadge(activeOrg.plan)}`);
        console.log(`  ${chalk.dim('Role:')}     ${activeOrg.role}`);
        console.log(`  ${chalk.dim('Region:')}   ${activeOrg.dataRegion}`);
        console.log(`  ${chalk.dim('ID:')}       ${chalk.dim(activeOrg.id)}`);
        console.log();
      }

      const ws = getDefault('workspace');
      const env = getDefault('environment');
      if (ws || env) {
        console.log(chalk.bold('  Defaults'));
        if (ws) console.log(`  ${chalk.dim('Workspace:')}   ${ws}`);
        if (env) console.log(`  ${chalk.dim('Environment:')} ${env}`);
        console.log();
      }

      console.log(chalk.dim(`  Config: ${getConfigPath()}`));
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

function planBadge(plan: string): string {
  switch (plan) {
    case 'team': return chalk.bgMagenta.white(` ${plan.toUpperCase()} `);
    case 'pro': return chalk.bgBlue.white(` ${plan.toUpperCase()} `);
    default: return chalk.bgGray.white(` ${plan.toUpperCase()} `);
  }
}
