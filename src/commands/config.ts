import { Command } from 'commander';
import chalk from 'chalk';
import { getAllConfig, setDefault, deleteKey, getConfigPath } from '../lib/config.js';
import * as output from '../lib/output.js';

export const configCommand = new Command('config')
  .description('Manage CLI configuration');

configCommand
  .command('list')
  .description('Show all configuration')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    const config = getAllConfig();
    if (opts.json) return output.json(config);

    console.log(chalk.dim(`Config file: ${getConfigPath()}`));
    console.log();
    console.log(JSON.stringify(config, null, 2));
  });

configCommand
  .command('get <key>')
  .description('Get a configuration value')
  .action((key: string) => {
    const config = getAllConfig();
    const keys = key.split('.');
    let value: unknown = config;
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = (value as Record<string, unknown>)[k];
      } else {
        console.log(chalk.dim('(not set)'));
        return;
      }
    }
    console.log(String(value));
  });

configCommand
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    setDefault(key, value);
    output.success(`Set ${chalk.bold(key)} = ${value}`);
  });

configCommand
  .command('unset <key>')
  .description('Remove a configuration value')
  .action((key: string) => {
    deleteKey(key);
    output.success(`Removed ${chalk.bold(key)}`);
  });
