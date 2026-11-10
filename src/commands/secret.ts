import { Command } from 'commander';
import chalk from 'chalk';
import { getClient } from '../lib/api.js';
import { resolveContext } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { confirmDestructive } from '../lib/confirm.js';
import { resolveSecretValue } from '../lib/secret-input.js';
import { timeAgo } from '../lib/timestamps.js';
import { DEFAULT_GENERATED_BYTES, generateSecretValue } from '../lib/generate.js';
import { upsertAcrossEnvironments } from '../lib/secret-write.js';

/** Splits `--envs dev,production` into slugs. Returns `undefined` when the flag is absent. */
function parseEnvironments(raw: unknown): [string, ...string[]] | undefined {
  if (typeof raw !== 'string') return undefined;
  const [first, ...rest] = [...new Set(raw.split(',').map((slug) => slug.trim()).filter(Boolean))];
  if (!first) throw new Error('--envs needs at least one environment slug.');
  return [first, ...rest];
}

export const secretCommand = new Command('secret')
  .description('Manage secrets');

secretCommand
  .command('list')
  .description('List secrets in an environment')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-b, --binding <file>', 'Use the scope of this bound file from .cryptflare.json')
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
  .description('Create a secret, or rotate it if the key exists. Omit the value to be prompted, or pipe it on stdin.')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('--envs <slugs>', 'Write the same value to several environments, comma-separated (e.g. dev,production)')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-b, --binding <file>', 'Use the scope of this bound file from .cryptflare.json')
  .option('-p, --pod <id>', 'Pod ID to place the secret in')
  .option('--file <path>', 'Read the value from a file instead of the command line')
  .option(
    '--generate [bytes]',
    `Generate a random value instead of supplying one (default ${DEFAULT_GENERATED_BYTES} bytes). The value is never printed.`,
  )
  .option('--description <text>', 'Description stored with a newly created secret')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Inside a project with a .cryptflare.json the workspace and environment come
from the binding nearest the current directory, so no flags are needed.

Examples:
  cf secret set API_KEY                      prompt for the value (hidden)
  echo -n "$API_KEY" | cf secret set API_KEY read it from stdin
  cf secret set API_KEY --file ./key.txt     read it from a file
  cf secret set API_KEY @./key.txt           same, shorthand
  cf secret set SESSION_SECRET --generate    generate 32 random bytes and store them
  cf secret set API_KEY --envs dev,production   one value, two environments`,
  )
  .action(async (key: string, value: string | undefined, opts) => {
    try {
      const environments = parseEnvironments(opts.envs);
      if (environments && opts.env) {
        throw new Error('Pass --env or --envs, not both.');
      }
      if (opts.generate !== undefined && (value !== undefined || opts.file)) {
        throw new Error('--generate creates the value; do not also pass one.');
      }

      // With --envs the environment of the binding is irrelevant, but its
      // organisation and workspace still are, so resolve against the first.
      const ctx = resolveContext({ ...opts, ...(environments ? { env: environments[0] } : {}) });
      const secretValue = opts.generate !== undefined
        ? generateSecretValue(opts.generate === true ? DEFAULT_GENERATED_BYTES : Number(opts.generate))
        : await resolveSecretValue({
          inline: value,
          file: opts.file,
          promptLabel: `Value for ${key}`,
        });

      const podId = opts.pod ?? ctx.pod;
      const result = await upsertAcrossEnvironments(
        getClient(),
        { organisation: ctx.org, workspace: ctx.workspace, ...(podId !== undefined ? { podId } : {}) },
        environments ?? [ctx.env],
        key,
        secretValue,
        opts.description ? { description: opts.description } : {},
      );

      if (opts.json) {
        output.json(result);
      } else {
        for (const write of result.written) {
          const verb = write.action === 'created' ? 'Created' : 'Rotated';
          output.success(`${verb} ${chalk.bold(write.key)} in ${ctx.workspace}/${write.environment} (version ${write.version})`);
        }
        for (const failure of result.failed) {
          console.error(chalk.red(`✗ ${ctx.workspace}/${failure.environment}: ${failure.message}`));
        }
      }
      if (result.failed.length > 0) process.exit(1);
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
  .option('-b, --binding <file>', 'Use the scope of this bound file from .cryptflare.json')
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

