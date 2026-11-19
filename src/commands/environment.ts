import { Command } from 'commander'
import chalk from 'chalk'

import { getClient } from '@/lib/api'
import { resolveOrg } from '@/lib/resolve'
import * as output from '@/lib/output'
import { resolveSlug } from '@/lib/slug'
import { EXIT_CODES } from '@/lib/exit-codes'

export const environmentCommand = new Command('environment')
  .alias('env-mgmt')
  .description('Manage environments')

environmentCommand
  .command('list')
  .description('List environments in a workspace')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts)
      const workspace = opts.workspace
      if (!workspace) {
        output.printError('Workspace required. Pass --workspace.')
        process.exit(EXIT_CODES.USAGE)
      }

      const data = await getClient().environments.list({
        organisation: org,
        workspace,
      })

      if (opts.json) return output.json(data)
      output.table(data.map((e) => ({ name: e.name, slug: e.slug, id: chalk.dim(e.id) })))
    } catch (err) {
      output.handleError(err)
    }
  })

environmentCommand
  .command('create')
  .description('Create an environment')
  .requiredOption('-n, --name <name>', 'Environment name')
  .option('-s, --slug <slug>', 'URL-safe slug (derived from --name when omitted)')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts)
      const workspace = opts.workspace
      if (!workspace) {
        output.printError('Workspace required. Pass --workspace.')
        process.exit(EXIT_CODES.USAGE)
      }

      const data = await getClient().environments.create({
        organisation: org,
        workspace,
        name: opts.name,
        slug: resolveSlug(opts.name, opts.slug),
      })

      if (opts.json) return output.json(data)
      output.success(`Created environment ${chalk.bold(data.name)} (${data.slug})`)
    } catch (err) {
      output.handleError(err)
    }
  })
