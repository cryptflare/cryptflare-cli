import { Command } from 'commander';
import { createWriteStream, existsSync } from 'node:fs';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { resolveOrg } from '../lib/resolve.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';

export const auditCommand = new Command('audit')
  .description('Inspect and export the audit log');

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
