import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { confirmDestructive } from '../lib/confirm.js';

type TokenItem = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  ipAllowlist: string[] | null;
};

type CreatedToken = {
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
  scopes: string[];
  ipAllowlist: string[] | null;
};

export const tokenCommand = new Command('token')
  .description('Manage API tokens');

tokenCommand
  .command('list')
  .description('List API tokens')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);
      const data = await getClient().tokens.list({ organisation: org }) as TokenItem[];

      if (opts.json) return output.json(data);
      output.table(
        data.map((t) => ({
          name: t.name,
          prefix: chalk.dim(t.tokenPrefix + '...'),
          scopes: t.scopes.join(', '),
          expires: t.expiresAt ?? chalk.dim('never'),
          ipAllowlist: t.ipAllowlist?.length ? `${t.ipAllowlist.length} entries` : chalk.dim('any'),
        })),
      );
    } catch (err) {
      output.handleError(err);
    }
  });

tokenCommand
  .command('create')
  .description('Create a new API token')
  .requiredOption('-n, --name <name>', 'Token name')
  .requiredOption('-w, --workspace <slug>', 'Workspace to scope the token to')
  .requiredOption('-s, --scope <scope...>', 'Permission scopes')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--expires <date>', 'Expiry date (ISO 8601)')
  .option(
    '--ip-allow <cidrs>',
    'Restrict to a comma-separated list of IPv4/IPv6 addresses or CIDRs (e.g. 10.0.0.0/8,203.0.113.5). Requests from outside this list are rejected.',
  )
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      await requirePermission('tokens:create');
      const org = resolveOrg(opts);
      const ipAllowlist = parseIpAllowlist(opts.ipAllow);
      const data = await getClient().tokens.create({
        organisation: org,
        name: opts.name,
        workspaceId: opts.workspace,
        scopes: opts.scope,
        environment: 'live',
        ...(opts.expires ? { expiresAt: opts.expires } : {}),
        ...(ipAllowlist ? { ipAllowlist } : {}),
      } as never) as CreatedToken;

      if (opts.json) return output.json(data);

      console.log();
      output.success(`Created token ${chalk.bold(data.name)}`);
      console.log();
      console.log(chalk.bold('Token:') + ' ' + chalk.cyan(data.token));
      if (data.ipAllowlist?.length) {
        console.log();
        console.log(chalk.bold('IP allowlist:') + ' ' + data.ipAllowlist.join(', '));
      }
      console.log();
      console.log(chalk.yellow('Save this token now. It will not be shown again.'));
    } catch (err) {
      output.handleError(err);
    }
  });

/**
 * Splits a comma-separated CLI flag into a clean array. Returns undefined
 * when the user did not pass the flag so the API request stays unchanged.
 * Empty entries are dropped so trailing commas don't reject the request.
 */
function parseIpAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

tokenCommand
  .command('revoke <id>')
  .description('Revoke an API token')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (id: string, opts) => {
    try {
      await requirePermission('tokens:revoke');
      const org = resolveOrg(opts);

      await confirmDestructive({
        message: 'This will permanently revoke this token. It cannot be undone.',
        assumeYes: opts.yes,
      });

      await getClient().tokens.revoke({ organisation: org, tokenId: id });
      output.success('Token revoked');
    } catch (err) {
      output.handleError(err);
    }
  });
