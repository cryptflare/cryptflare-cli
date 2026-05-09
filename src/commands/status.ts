import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import * as output from '../lib/output.js';

type Subscription = {
  plan: string;
  status: string;
  limits: Record<string, number>;
  usage: Record<string, number>;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
};

function usageBar(current: number, limit: number, width = 20): string {
  if (limit === -1) return chalk.dim('unlimited');
  const pct = limit > 0 ? Math.min(current / limit, 1) : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = pct >= 0.8
    ? chalk.red('█'.repeat(filled))
    : pct >= 0.5
      ? chalk.yellow('█'.repeat(filled))
      : chalk.green('█'.repeat(filled));
  return `${bar}${chalk.dim('░'.repeat(empty))} ${current}/${limit}`;
}

export const statusCommand = new Command('status')
  .description('Show organisation status, plan usage, and limits')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);

      const sub = await getClient().billing.getSubscription({ organisation: org }) as Subscription;

      if (opts.json) return output.json(sub);

      console.log();
      console.log(chalk.bold('  Organisation Status'));
      console.log();
      console.log(`  ${chalk.dim('Plan:')}    ${planBadge(sub.plan)} ${sub.status === 'cancelling' ? chalk.yellow('(cancelling)') : ''}`);
      if (sub.currentPeriodEnd) {
        console.log(`  ${chalk.dim('Renews:')}  ${new Date(sub.currentPeriodEnd).toLocaleDateString()}`);
      }
      console.log();
      console.log(chalk.bold('  Resource Usage'));
      console.log();

      const rows: Array<[string, number, number]> = [
        ['Secrets', sub.usage.secrets ?? 0, sub.limits.secrets ?? 0],
        ['Workspaces', sub.usage.workspaces ?? 0, sub.limits.workspaces ?? 0],
        ['Environments', sub.usage.environments ?? 0, sub.limits.environments ?? 0],
        ['Members', sub.usage.members ?? 0, sub.limits.members ?? 0],
        ['Teams', sub.usage.teams ?? 0, sub.limits.teams ?? 0],
        ['Daily Requests', sub.usage.dailyRequests ?? 0, sub.limits.dailyRequests ?? 0],
      ];

      for (const [label, current, limit] of rows) {
        const paddedLabel = label.padEnd(16);
        console.log(`  ${chalk.dim(paddedLabel)} ${usageBar(current, limit)}`);
      }

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
