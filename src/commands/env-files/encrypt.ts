/** `cf env encrypt <file...>` - replace plaintext values with `cf:v1` ciphertext in place. */

import chalk from 'chalk'
import { Command } from 'commander'

import { getClient } from '@/lib/api'
import { encryptFile, type EncryptFileResult } from '@/lib/local-env/encrypt-file'
import { resolveFileTarget } from '@/lib/local-env/file-target'
import { Keyring } from '@/lib/local-env/keyring'
import { revealSecrets } from '@/lib/reveal'
import * as output from '@/lib/output'

function report(result: EncryptFileResult): void {
  const verb = result.changed
    ? `encrypted ${result.encrypted.length} value(s)`
    : 'nothing to encrypt'
  output.print(
    `  ${chalk.green(output.MARK.ok)} ${result.rel} ${chalk.dim(`key v${result.version}`)} ${verb}`,
  )
  const publicNames = result.byDecision.get('public') ?? []
  if (publicNames.length > 0) {
    output.print(
      chalk.yellow(
        `      left plaintext, shipped to browsers by the bundler: ${publicNames.join(', ')}`,
      ) + chalk.dim(' (--include-public to encrypt)'),
    )
  }
  const notSecret = result.byDecision.get('not-secret') ?? []
  if (notSecret.length > 0) {
    output.print(
      chalk.dim(
        `      left plaintext, not secret-looking: ${notSecret.join(', ')} (--all-values to encrypt)`,
      ),
    )
  }
  for (const item of result.unmanaged) {
    output.print(chalk.dim(`      line ${item.line} ${item.name}: not managed (${item.reason})`))
  }
  if (result.duplicates.length > 0) {
    output.print(
      chalk.yellow(
        `      defined more than once (every copy encrypted): ${result.duplicates.join(', ')}`,
      ),
    )
  }
  if (result.byDecision.has('registry-token')) {
    output.print(
      chalk.yellow(
        '      registry tokens are not encrypted in place: run `cf env migrate --move-registry-tokens`',
      ),
    )
  }
}

export const encryptCommand = new Command('encrypt')
  .description('Encrypt the values of local env files in place (cf:v1 ciphertext)')
  .argument('<files...>', 'Files to encrypt: .env*, .dev.vars, .envrc, secrets.toml, *.tfvars, ...')
  .option('-w, --workspace <slug>', 'Workspace, for a file not bound in .cryptflare.json')
  .option('-e, --env <slug>', 'Environment, for a file not bound in .cryptflare.json')
  .option('-o, --org <id>', 'Organisation ID')
  .option(
    '--format <id>',
    'Format, for a file whose name no format claims (dotenv, toml, json, tfvars)',
  )
  .option('--rotate', 'Re-encrypt every value under the next key version')
  .option('--include-public', 'Also encrypt browser-public names (NEXT_PUBLIC_, VITE_, ...)')
  .option('--all-values', 'Structured files: encrypt every string, not only secret-looking ones')
  .option(
    '--from-vault',
    'Take each value from CryptFlare instead of the file (after a BYOK key change)',
  )
  .option('--dry-run', 'Say what would change, write nothing')
  .addHelpText(
    'after',
    `
Comments, blank lines, ordering, quoting and export prefixes are kept; values
already encrypted are left alone. The key is fetched once per environment and
never written to disk.

Examples:
  cf env encrypt .env apps/api/.dev.vars
  cf env encrypt --rotate .env
  cf env encrypt -w my-app -e dev config/app.env --format dotenv`,
  )
  .action(async (files: string[], opts) => {
    try {
      const client = getClient()
      const keyring = new Keyring(client)
      output.print()
      for (const file of files) {
        const target = resolveFileTarget(file, opts)
        let replacements: Map<string, string> | undefined
        if (opts.fromVault) {
          replacements = await revealSecrets(client, {
            organisation: target.scope.org,
            workspace: target.scope.workspace,
            environment: target.scope.environment,
            ...(target.pod ? { podId: target.pod } : {}),
          })
        }
        report(
          await encryptFile(target, keyring, {
            rotate: Boolean(opts.rotate),
            includePublic: Boolean(opts.includePublic),
            allValues: Boolean(opts.allValues),
            dryRun: Boolean(opts.dryRun),
            ...(replacements ? { replacements } : {}),
          }),
        )
      }
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })
