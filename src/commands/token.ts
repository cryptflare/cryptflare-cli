import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import * as output from '../lib/output.js';

type TokenItem = {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
};

type CreatedToken = {
  id: string;
  name: string;
  token: string;
  tokenPrefix: string;
  scopes: string[];
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
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts);
      const data = await getClient().tokens.create({
        organisation: org,
        name: opts.name,
        workspaceId: opts.workspace,
        scopes: opts.scope,
        environment: 'live',
        ...(opts.expires ? { expiresAt: opts.expires } : {}),
      } as never) as CreatedToken;

      if (opts.json) return output.json(data);

      console.log();
      output.success(`Created token ${chalk.bold(data.name)}`);
      console.log();
      console.log(chalk.bold('Token:') + ' ' + chalk.cyan(data.token));
      console.log();
      console.log(chalk.yellow('Save this token now. It will not be shown again.'));
    } catch (err) {
      output.handleError(err);
    }
  });

tokenCommand
  .command('revoke <id>')
  .description('Revoke an API token')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (id: string, opts) => {
    try {
      const org = resolveOrg(opts);

      if (!opts.yes) {
        console.log(chalk.yellow('This will permanently revoke this token. It cannot be undone.'));
        console.log('Pass --yes to confirm.');
        process.exit(0);
      }

      await getClient().tokens.revoke({ organisation: org, tokenId: id });
      output.success('Token revoked');
    } catch (err) {
      output.handleError(err);
    }
  });
