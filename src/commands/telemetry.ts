import { Command } from 'commander';
import chalk from 'chalk';

import { isTelemetryEnabled, setTelemetry } from '../lib/config.js';
import * as output from '../lib/output.js';

const PRIVACY_NOTE = `Anonymous usage telemetry. We collect:
  - Command name (e.g. \`secret list\`, never the args)
  - CLI version + Node version + OS
  - Command duration + success / failure outcome

We do NOT collect:
  - Tokens, secret keys, secret values, organisation IDs, workspace names
  - File paths, hostnames, or any free-form text from your shell

Disable any time with \`cf telemetry off\` or \`DO_NOT_TRACK=1\`. Default is OFF until you opt in.`;

export const telemetryCommand = new Command('telemetry')
  .description('Manage anonymous CLI telemetry');

telemetryCommand
  .command('status')
  .description('Show whether telemetry is enabled')
  .action(() => {
    const on = isTelemetryEnabled();
    console.log();
    console.log(`  Telemetry: ${on ? chalk.green('on') : chalk.dim('off')}`);
    console.log();
    console.log(PRIVACY_NOTE);
    console.log();
  });

telemetryCommand
  .command('on')
  .description('Enable anonymous telemetry')
  .action(() => {
    setTelemetry(true);
    output.success('Telemetry enabled. Thanks for helping us improve the CLI.');
    console.log();
    console.log(chalk.dim(PRIVACY_NOTE));
    console.log();
  });

telemetryCommand
  .command('off')
  .description('Disable anonymous telemetry')
  .action(() => {
    setTelemetry(false);
    output.success('Telemetry disabled. No usage data will be sent.');
  });
