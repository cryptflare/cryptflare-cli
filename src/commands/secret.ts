import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../lib/api.js';
import { resolveContext } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { confirmDestructive } from '../lib/confirm.js';
import { resolveSecretValue } from '../lib/secret-input.js';
import { timeAgo } from '../lib/timestamps.js';

export const secretCommand = new Command('secret')
  .description('Manage secrets');

secretCommand
  .command('list')
  .description('List secrets in an environment')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-p, --pod <id>', 'Filter by pod ID (use "root" for root level only)')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Minimal output')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts);
      const client = getClient();

      const items: Array<{ key: string; version: number; updatedAt: string }> = [];
      const page = await client.secrets.list({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        ...(opts.pod !== undefined ? { podId: opts.pod === 'root' ? null : opts.pod } : {}),
      });
      for await (const secret of page) items.push(secret);

      if (opts.json) return output.json(items);

      output.table(
        items.map((s) => ({
          key: s.key,
          version: `v${s.version}`,
          updated: timeAgo(s.updatedAt),
        })),
        { quiet: opts.quiet },
      );
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  // `<value>` is optional so the value need not appear on the command line,
  // where it would be captured by shell history and visible in `ps`.
  .command('set <key> [value]')
  .description('Create or update a secret. Omit the value to be prompted, or pipe it on stdin.')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-p, --pod <id>', 'Pod ID to place the secret in')
  .option('--file <path>', 'Read the value from a file instead of the command line')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  cf secret set API_KEY                      prompt for the value (hidden)
  echo -n "$API_KEY" | cf secret set API_KEY read it from stdin
  cf secret set API_KEY --file ./key.txt     read it from a file
  cf secret set API_KEY @./key.txt           same, shorthand`,
  )
  .action(async (key: string, value: string | undefined, opts) => {
    try {
      const ctx = resolveContext(opts);
      const secretValue = await resolveSecretValue({
        inline: value,
        file: opts.file,
        promptLabel: `Value for ${key}`,
      });
      const result = await getClient().secrets.create({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        value: secretValue,
        ...(opts.pod !== undefined ? { podId: opts.pod } : {}),
      });

      if (opts.json) return output.json(result);
      output.success(`Set ${chalk.bold(result.key)} (version ${result.version})`);
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('get <key>')
  .description('Retrieve a secret value')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Output value only')
  .action(async (key: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const data = await getClient().secrets.reveal({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
      });

      if (opts.json) return output.json(data);
      if (opts.quiet) return console.log(data.value);

      console.log(`${chalk.bold(data.key)} ${chalk.dim(`(v${data.version})`)}`);
      console.log(data.value);
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('rotate <key>')
  .description('Rotate a secret to a new value. Omit --value to be prompted, or pipe it on stdin.')
  // No longer required: supplying it here writes the new secret into shell
  // history, which is exactly what rotating a compromised secret is meant to
  // get away from.
  .option('--value <value>', 'New secret value (prefer stdin, --file, or the prompt)')
  .option('--file <path>', 'Read the new value from a file')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  cf secret rotate API_KEY                        prompt for the new value
  openssl rand -hex 32 | cf secret rotate API_KEY generate and rotate in one step`,
  )
  .action(async (key: string, opts) => {
    try {
      await requirePermission('secrets:write');
      const ctx = resolveContext(opts);
      const value = await resolveSecretValue({
        inline: opts.value,
        file: opts.file,
        promptLabel: `New value for ${key}`,
      });
      const result = await getClient().secrets.rotate({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        value,
      });

      if (opts.json) return output.json(result);
      output.success(`Rotated ${chalk.bold(result.key)} to version ${result.version}`);
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('delete <key>')
  .description('Delete a secret permanently')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (key: string, opts) => {
    try {
      await requirePermission('secrets:delete');
      const ctx = resolveContext(opts);

      await confirmDestructive({
        message: `This will permanently delete ${chalk.bold(key)} and all its version history.`,
        assumeYes: opts.yes,
      });

      await getClient().secrets.delete({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
      });

      output.success(`Deleted ${chalk.bold(key)}`);
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('versions <key>')
  .description('List historical versions of a secret (metadata only)')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Minimal output')
  .action(async (key: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const res = await getClient().secrets.listVersions({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
      });
      const versions = res.data;

      if (opts.json) return output.json(versions);
      if (versions.length === 0) {
        output.success(`No version history for ${chalk.bold(key)}`);
        return;
      }
      output.table(
        versions.map((v) => ({
          version: `v${v.version}`,
          createdBy: v.createdBy,
          createdAt: timeAgo(v.createdAt),
        })),
        { quiet: opts.quiet },
      );
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('rollback <key> <version>')
  .description('Restore a previous version as the new current version')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .option('--json', 'Output as JSON')
  .action(async (key: string, versionArg: string, opts) => {
    try {
      await requirePermission('secrets:restore');
      const ctx = resolveContext(opts);
      const version = Number(versionArg);
      if (!Number.isInteger(version) || version < 1) {
        output.handleError(new Error(`Version must be a positive integer (got ${chalk.bold(versionArg)})`));
        return;
      }

      await confirmDestructive({
        message:
          `This will create a new version of ${chalk.bold(key)} with the value from v${version}. ` +
          'The current version is preserved in history.',
        assumeYes: opts.yes,
      });

      const result = await getClient().secrets.rollback({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        version,
      });

      if (opts.json) return output.json(result);
      output.success(`Rolled back ${chalk.bold(result.key)} from v${version} to new v${result.version}`);
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('reveal-version <key> <version>')
  .description('Reveal the value of a specific historical version')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .option('-q, --quiet', 'Output value only')
  .action(async (key: string, versionArg: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const version = Number(versionArg);
      if (!Number.isInteger(version) || version < 1) {
        output.handleError(new Error(`Version must be a positive integer (got ${chalk.bold(versionArg)})`));
        return;
      }
      const data = await getClient().secrets.revealVersion({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        version,
      });

      if (opts.json) return output.json(data);
      if (opts.quiet) return console.log(data.value);

      console.log(`${chalk.bold(data.key)} ${chalk.dim(`(v${data.version})`)}`);
      console.log(data.value);
    } catch (err) {
      output.handleError(err);
    }
  });

secretCommand
  .command('move <key>')
  .description('Move a secret to a pod or root level')
  .requiredOption('--pod <id>', 'Target pod ID, or "root" to move to root level')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (key: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const podId = opts.pod === 'root' ? null : opts.pod;

      await getClient().secrets.move({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        podId,
      });

      if (opts.json) return output.json({ success: true });
      const dest = podId ? `pod ${chalk.bold(podId)}` : 'root level';
      output.success(`Moved ${chalk.bold(key)} to ${dest}`);
    } catch (err) {
      output.handleError(err);
    }
  });

