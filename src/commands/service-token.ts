/**
 * `cf service-token` - org-level tokens for machines.
 *
 * These existed in the API and the dashboard but had no CLI surface at all,
 * which is an odd hole in a tool whose main audience is CI: you could not mint
 * the token your pipeline authenticates with from the tool your pipeline uses.
 *
 * Distinct from `cf token`, which manages *personal* access tokens scoped to a
 * single workspace. A service token belongs to the organisation, is not tied to
 * a person, survives them leaving, and can be disabled without being destroyed -
 * which is what you want when a pipeline starts misbehaving at 3am and you would
 * rather pause it than delete it and lose the audit trail.
 */

import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { confirmDestructive } from '../lib/confirm.js';
import { timeAgo } from '../lib/timestamps.js';

type ServiceTokenItem = {
  id: string;
  name: string;
  description: string | null;
  scopes: string[];
  enabled: boolean;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
};

type CreatedServiceToken = ServiceTokenItem & { token: string; ipAllowlist?: string[] };

export const serviceTokenCommand = new Command('service-token')
  .alias('svc-token')
  .description('Manage organisation service tokens (for CI and automation)');

/** Comma-separated flag -> array. Undefined when the flag was absent, so the request is unchanged. */
function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

serviceTokenCommand
  .command('list')
  .description('List service tokens')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Minimal output')
  .action(async (opts) => {
    try {
      await requirePermission('service_tokens:read');
      const org = resolveOrg(opts);
      const data = await getClient().serviceTokens.list({ organisation: org }) as
        | ServiceTokenItem[]
        | { data: ServiceTokenItem[] };
      const items = Array.isArray(data) ? data : data.data ?? [];

      if (opts.json) return output.json(items);
      if (items.length === 0) {
        output.info('No service tokens. Create one with `cf service-token create`.');
        return;
      }

      output.table(
        items.map((t) => ({
          id: t.id,
          name: t.name,
          // Disabled tokens are the reason `toggle` exists; make the state
          // obvious rather than something you infer from a JSON dump.
          status: t.enabled ? 'enabled' : chalk.yellow('disabled'),
          scopes: t.scopes.join(','),
          'last used': t.last_used_at ? timeAgo(t.last_used_at) : 'never',
          expires: t.expires_at ? timeAgo(t.expires_at) : 'never',
        })),
        { quiet: opts.quiet },
      );
    } catch (err) {
      output.handleError(err);
    }
  });

serviceTokenCommand
  .command('create')
  .description('Create a service token for CI or automation')
  .requiredOption('-n, --name <name>', 'Token name')
  .requiredOption('-s, --scope <scope...>', 'Permission scopes (repeatable)')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-d, --description <text>', 'What this token is for')
  .option('--expires <date>', 'Expiry timestamp (ISO 8601)')
  .option('--ip-allow <cidrs>', 'Comma-separated IPs or CIDRs permitted to use this token')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  cf service-token create -n ci-deploy -s secrets:read
  cf service-token create -n ci-deploy -s secrets:read -s secrets:write \\
    --expires 2027-01-01T00:00:00Z --ip-allow 203.0.113.0/24

Scope it to the minimum the pipeline needs, and set an expiry - an
unexpiring token is one you will never notice has leaked.`,
  )
  .action(async (opts) => {
    try {
      await requirePermission('service_tokens:create');
      const org = resolveOrg(opts);
      const ipAllowlist = parseList(opts.ipAllow);

      const data = await getClient().serviceTokens.create({
        organisation: org,
        name: opts.name,
        scopes: opts.scope,
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.expires ? { expiresAt: opts.expires } : {}),
        ...(ipAllowlist ? { ipAllowlist } : {}),
      } as never) as CreatedServiceToken;

      if (opts.json) return output.json(data);

      console.log();
      output.success(`Created service token ${chalk.bold(data.name)}`);
      console.log();
      console.log(chalk.bold('Token:') + ' ' + chalk.cyan(data.token));
      console.log();
      if (data.ipAllowlist?.length) {
        console.log(chalk.bold('IP allowlist:') + ' ' + data.ipAllowlist.join(', '));
      }
      if (!opts.expires) {
        console.log(chalk.yellow('!') + ' No expiry set. Consider --expires so a leaked token eventually dies.');
      }
      console.log(chalk.yellow('Save this token now. It will not be shown again.'));
      console.log(chalk.dim('  Use it as CF_TOKEN in your pipeline.'));
    } catch (err) {
      output.handleError(err);
    }
  });

serviceTokenCommand
  .command('update <id>')
  .description('Rename a service token or change its scopes')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-n, --name <name>', 'New name')
  .option('-s, --scope <scope...>', 'Replace the scopes')
  .option('--json', 'Output as JSON')
  .action(async (id: string, opts) => {
    try {
      if (!opts.name && !opts.scope) {
        throw new Error('Nothing to update. Pass --name and/or --scope.');
      }
      const org = resolveOrg(opts);
      const data = await getClient().serviceTokens.update({
        organisation: org,
        tokenId: id,
        ...(opts.name ? { name: opts.name } : {}),
        ...(opts.scope ? { scopes: opts.scope } : {}),
      });

      if (opts.json) return output.json(data);
      output.success(`Updated service token ${chalk.bold(id)}`);
    } catch (err) {
      output.handleError(err);
    }
  });

serviceTokenCommand
  .command('disable <id>')
  .description('Disable a token without destroying it (reversible)')
  .option('-o, --org <id>', 'Organisation ID')
  .action(async (id: string, opts) => {
    try {
      const org = resolveOrg(opts);
      await getClient().serviceTokens.toggle({ organisation: org, tokenId: id, enabled: false });
      output.success(`Disabled ${chalk.bold(id)}. Re-enable with \`cf service-token enable ${id}\`.`);
    } catch (err) {
      output.handleError(err);
    }
  });

serviceTokenCommand
  .command('enable <id>')
  .description('Re-enable a disabled token')
  .option('-o, --org <id>', 'Organisation ID')
  .action(async (id: string, opts) => {
    try {
      const org = resolveOrg(opts);
      await getClient().serviceTokens.toggle({ organisation: org, tokenId: id, enabled: true });
      output.success(`Enabled ${chalk.bold(id)}`);
    } catch (err) {
      output.handleError(err);
    }
  });

serviceTokenCommand
  .command('revoke <id>')
  .description('Permanently revoke a service token')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .addHelpText(
    'after',
    `
Revoking is permanent. To pause a token temporarily - a misbehaving pipeline,
an investigation - use \`cf service-token disable\` instead, which is reversible
and keeps the audit trail intact.`,
  )
  .action(async (id: string, opts) => {
    try {
      await requirePermission('service_tokens:revoke');
      const org = resolveOrg(opts);
      await confirmDestructive({
        message: `This will permanently revoke service token ${chalk.bold(id)}. Anything using it stops working immediately.`,
        assumeYes: opts.yes,
      });
      await getClient().serviceTokens.revoke({ organisation: org, tokenId: id });
      output.success(`Revoked ${chalk.bold(id)}`);
    } catch (err) {
      output.handleError(err);
    }
  });
