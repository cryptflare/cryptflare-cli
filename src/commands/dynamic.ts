/**
 * `cf dynamic` - short-lived credentials minted on demand.
 *
 * A dynamic secret config (an Azure service principal, an AWS role, a
 * destroy.network identity) issues a fresh credential per lease and revokes
 * it when the lease ends. `cf dynamic issue --save` is the piece that ties
 * that to a project: it mints the credential and stores it as ordinary
 * secrets in the bound environment, so it reaches `.env` and `cf run` like
 * any other secret without being copied by hand.
 */

import { Command } from 'commander'
import chalk from 'chalk'

import { dynamicGithubCommand } from '@/commands/dynamic-github'
import { getClient } from '@/lib/api'
import { leaseSecretKeys } from '@/lib/lease-secrets'
import * as output from '@/lib/output'
import { resolveContext, resolveOrg } from '@/lib/resolve'
import { upsertSecret } from '@/lib/secret-write'

export const dynamicCommand = new Command('dynamic').description(
  'Issue short-lived credentials from dynamic secret configs',
)

dynamicCommand.addCommand(dynamicGithubCommand)

dynamicCommand
  .command('list')
  .description('List dynamic secret configs')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const organisation = resolveOrg(opts)
      const configs = (await getClient().dynamicSecrets.listConfigs({ organisation })).data
      if (opts.json) return output.json(configs)
      output.table(configs.map((c) => ({ id: c.id, name: c.name, provider: c.provider })))
    } catch (err) {
      output.handleError(err)
    }
  })

dynamicCommand
  .command('issue <config>')
  .description('Mint a credential from a dynamic secret config')
  .option(
    '--ttl <seconds>',
    'Lease length in seconds (the config sets the default and the ceiling)',
  )
  .option(
    '--save',
    'Store the credential as secrets in the bound environment instead of printing it',
  )
  .option('--prefix <PREFIX>', 'Key prefix for --save, e.g. SIGNUP_TEST gives SIGNUP_TEST_EMAIL')
  .option('-w, --workspace <slug>', 'Workspace ID or slug (for --save)')
  .option('-e, --env <slug>', 'Environment ID or slug (for --save)')
  .option(
    '-b, --binding <file>',
    'Use the scope of this bound file from .cryptflare.json (for --save)',
  )
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  cf dynamic issue signup-identities                       print the credential once
  cf dynamic issue signup-identities --save --prefix SIGNUP_TEST
                                                           store it in the bound environment;
                                                           nothing is printed but the key names

With --save the values are never shown. They reach your .env on the next
sync, and \`cf run\` picks them up at once.`,
  )
  .action(async (config: string, opts) => {
    try {
      if (opts.save && !opts.prefix)
        throw new Error('--save needs --prefix <PREFIX> to name the secrets.')
      const ttl = opts.ttl === undefined ? undefined : Number(opts.ttl)
      if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 1))
        throw new Error('--ttl must be a whole number of seconds.')

      // Resolved before the lease is issued: a credential minted and then
      // not stored because of a bad flag would be a live credential nobody has.
      const target = opts.save ? resolveContext(opts) : null
      const organisation = target?.org ?? resolveOrg(opts)
      const client = getClient()

      const { data: lease } = await client.dynamicSecrets.issueLease({
        organisation,
        configId: config,
        ...(ttl !== undefined ? { ttl } : {}),
      })
      // Provider credentials are strings today; anything else is stored as JSON
      // so a structured field is never written as "[object Object]".
      const credentials: Record<string, string> = Object.fromEntries(
        Object.entries(lease.credentials ?? {}).map(([field, value]) => [
          field,
          typeof value === 'string' ? value : JSON.stringify(value),
        ]),
      )

      if (!target) {
        if (opts.json) return output.json(lease)
        output.printError(
          chalk.dim(`Lease ${lease.leaseId} - expires ${lease.expiresAt}. Shown once.`),
        )
        for (const [field, value] of Object.entries(credentials)) output.print(`${field}=${value}`)
        return
      }

      const secrets = leaseSecretKeys(opts.prefix, credentials)
      const stored: string[] = []
      for (const [key, value] of secrets) {
        await upsertSecret(
          client,
          {
            organisation,
            workspace: target.workspace,
            environment: target.env,
            ...(target.pod ? { podId: target.pod } : {}),
          },
          key,
          value,
          {
            description: `Dynamic lease ${lease.leaseId} from ${config}, expires ${lease.expiresAt}`,
          },
        )
        stored.push(key)
      }

      if (opts.json)
        return output.json({ leaseId: lease.leaseId, expiresAt: lease.expiresAt, stored })
      output.success(
        `Stored ${stored.length} secret(s) in ${target.workspace}/${target.env}: ${stored.join(', ')}`,
      )
      output.print(
        chalk.dim(
          `  Lease ${lease.leaseId} expires ${lease.expiresAt}. Revoke early with: cf dynamic revoke ${lease.leaseId}`,
        ),
      )
    } catch (err) {
      output.handleError(err)
    }
  })

dynamicCommand
  .command('revoke <leaseId>')
  .description('Revoke a lease now, instead of waiting for it to expire')
  .option('-o, --org <id>', 'Organisation ID')
  .action(async (leaseId: string, opts) => {
    try {
      await getClient().dynamicSecrets.revokeLease({ organisation: resolveOrg(opts), leaseId })
      output.success(`Revoked lease ${leaseId}`)
    } catch (err) {
      output.handleError(err)
    }
  })
