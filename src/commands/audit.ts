import { Command } from 'commander';
import { createWriteStream, existsSync } from 'node:fs';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { timeAgo } from '../lib/timestamps.js';

/** One row of the audit log, as returned by `GET /organisations/:org/audit`. */
type AuditEvent = {
  id: string;
  action: string;
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  occurredAt: string;
};

export const auditCommand = new Command('audit')
  .description('Inspect and export the audit log');

auditCommand
  .command('list')
  .description('List recent audit events, newest first')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-n, --limit <count>', 'Maximum events to show', '20')
  .option('--action <action>', 'Filter by action (e.g. secret.revealed)')
  .option('--actor <id>', 'Filter by actor user ID')
  .option('--from <iso>', 'Only events at or after this ISO 8601 timestamp')
  .option('--to <iso>', 'Only events at or before this ISO 8601 timestamp')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      // Argument validation first: a typo in --limit should say so, not be
      // masked by a permission error the user then has to look past.
      const limit = Number.parseInt(opts.limit, 10);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`Invalid --limit "${opts.limit}". Expected a positive integer.`);
      }

      await requirePermission('audit:read');
      const org = resolveOrg(opts);

      const events: AuditEvent[] = [];
      // The endpoint is cursor-paginated with a server-chosen page size, so
      // stop once enough rows have arrived rather than draining the log.
      for await (const event of await getClient().audit.list({
        organisation: org,
        ...(opts.action ? { action: opts.action } : {}),
        ...(opts.actor ? { actorId: opts.actor } : {}),
        ...(opts.from ? { from: opts.from } : {}),
        ...(opts.to ? { to: opts.to } : {}),
      }) as AsyncIterable<AuditEvent>) {
        events.push(event);
        if (events.length >= limit) break;
      }

      if (opts.json) return output.json(events);
      if (events.length === 0) return output.info('No audit events matched.');

      output.table(
        events.map((e) => ({
          when: timeAgo(e.occurredAt),
          action: e.action,
          resource: e.resourceType ? `${e.resourceType}${e.resourceId ? `/${e.resourceId}` : ''}` : chalk.dim('-'),
          actor: e.actorId ?? chalk.dim('-'),
        })),
      );
      console.log(chalk.dim(`\n  ${events.length} event(s). Full records: ${chalk.cyan('cf audit list --json')}`));
    } catch (err) {
      output.handleError(err);
    }
  });

auditCommand
  .command('export')
  .description('Stream the audit log window to a JSONL file')
  .requiredOption('--start <iso>', 'ISO 8601 start timestamp (inclusive)')
  .requiredOption('--end <iso>', 'ISO 8601 end timestamp (inclusive)')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-f, --file <path>', 'Output file path (use "-" for stdout)', '-')
  .option('--overwrite', 'Overwrite existing file without confirmation')
  .action(async (opts) => {
    try {
      await requirePermission('audit:export');
      const org = resolveOrg(opts);

      if (opts.file !== '-' && existsSync(opts.file) && !opts.overwrite) {
        output.warn(`File ${chalk.bold(opts.file)} already exists. Use ${chalk.bold('--overwrite')} to replace.`);
        process.exit(1);
      }

      const stream = await getClient().audit.export({
        organisation: org,
        startDate: opts.start,
        endDate: opts.end,
      });

      // Pipe Uint8Array chunks straight to disk (or stdout). Avoid
      // buffering in JS so large exports stay memory-bounded.
      const target = opts.file === '-' ? process.stdout : createWriteStream(opts.file, { mode: 0o600 });
      let bytes = 0;
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytes += value.byteLength;
          if (opts.file === '-') {
            process.stdout.write(value);
          } else {
            (target as ReturnType<typeof createWriteStream>).write(value);
          }
        }
      }
      if (opts.file !== '-') {
        await new Promise<void>((resolve) => (target as ReturnType<typeof createWriteStream>).end(resolve));
        output.success(`Exported ${chalk.bold(`${bytes} bytes`)} to ${chalk.bold(opts.file)}`);
      }
    } catch (err) {
      output.handleError(err);
    }
  });
