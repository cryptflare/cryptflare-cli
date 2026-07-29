import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../lib/api.js';
import { resolveContext } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';

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
  .command('set <key> <value>')
  .description('Create or update a secret')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-p, --pod <id>', 'Pod ID to place the secret in')
  .option('--json', 'Output as JSON')
  .action(async (key: string, value: string, opts) => {
    try {
      const ctx = resolveContext(opts);
      const result = await getClient().secrets.create({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        value,
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
  .description('Rotate a secret to a new value')
  .requiredOption('--value <value>', 'New secret value')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (key: string, opts) => {
    try {
      await requirePermission('secrets:write');
      const ctx = resolveContext(opts);
      const result = await getClient().secrets.rotate({
        organisation: ctx.org,
        workspace: ctx.workspace,
        environment: ctx.env,
        key,
        value: opts.value,
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

      if (!opts.yes) {
        console.log(chalk.yellow(`This will permanently delete ${chalk.bold(key)} and all its version history.`));
        console.log('Pass --yes to confirm.');
        process.exit(0);
      }

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

      if (!opts.yes) {
        console.log(chalk.yellow(`This will create a new version of ${chalk.bold(key)} with the value from v${version}.`));
        console.log('The current version is preserved in history. Pass --yes to confirm.');
        process.exit(0);
      }

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
