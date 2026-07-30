import { Command } from 'commander';
import chalk from 'chalk';
import { getAllConfig, setDefault, deleteKey, getConfigPath } from '../lib/config.js';
import * as output from '../lib/output.js';
import { getRegistryPath } from '../lib/sync-registry.js';
import { getStatePath } from '../lib/sync-state.js';

export const configCommand = new Command('config')
  .description('Manage CLI configuration');

/**
 * Replaces the API key with its identifying prefix.
 *
 * `cf config list` printed `cf_live_...` in full. That output is what people
 * paste into bug reports, screen shares, and support threads, so the default
 * has to be safe; the prefix is what `cf token list` shows and is enough to
 * tell which token is active. `--reveal` prints it for the cases that need it.
 */
function maskToken<T extends Record<string, unknown>>(config: T): T {
  const token = config.token;
  if (typeof token !== 'string' || token.length === 0) return config;
  return { ...config, token: `${token.slice(0, 12)}... (${token.length} chars, --reveal to show)` };
}

configCommand
  .command('list')
  .description('Show all configuration')
  .option('--json', 'Output as JSON')
  .option('--reveal', 'Print the API token in full instead of masking it')
  .action((opts) => {
    const config = opts.reveal ? getAllConfig() : maskToken(getAllConfig());
    if (opts.json) return output.json(config);

    console.log(chalk.dim(`Config file: ${getConfigPath()}`));
    console.log();
    console.log(JSON.stringify(config, null, 2));
  });

configCommand
  .command('path')
  .description('Print where the CLI keeps its config, sync registry, and sync state')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    // These live under `~/.config/cryptflare-nodejs` - the `-nodejs` is
    // env-paths' default suffix, not a typo, and it is unguessable enough
    // that people went looking in `~/.config/cryptflare` and found nothing.
    // Backing the files up or hand-editing them starts with locating them.
    const paths = {
      config: getConfigPath(),
      registry: getRegistryPath(),
      state: getStatePath(),
    };
    if (opts.json) return output.json(paths);

    console.log(`  ${chalk.dim('config')}    ${paths.config}`);
    console.log(`  ${chalk.dim('registry')}  ${paths.registry}`);
    console.log(`  ${chalk.dim('state')}     ${paths.state}`);
  });

configCommand
  .command('get <key>')
  .description('Get a configuration value')
  .option('--reveal', 'Print the API token in full instead of masking it')
  .action((key: string, opts) => {
    const config = opts.reveal ? getAllConfig() : maskToken(getAllConfig());
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
    // `String(anObject)` is "[object Object]", which is what `cf config get
    // permissions` and `cf config get defaults` printed - the two keys whose
    // values are objects, so the command was useless for exactly the cases
    // where you most want to read the config.
    console.log(typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value));
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
