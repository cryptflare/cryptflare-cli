import { Command } from 'commander'
import chalk from 'chalk'

import { getClient } from '@/lib/api'
import { resolveOrg } from '@/lib/resolve'
import { requirePermission } from '@/lib/permissions'
import * as output from '@/lib/output'
import { confirmDestructive } from '@/lib/confirm'
import { resolveSlug } from '@/lib/slug'

export const workspaceCommand = new Command('workspace')
  .alias('ws')
  .description('Manage workspaces')

workspaceCommand
  .command('list')
  .description('List workspaces')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts)
      const data = await getClient().workspaces.list({ organisation: org })

      if (opts.json) return output.json(data)
      output.table(data.map((w) => ({ name: w.name, slug: w.slug, id: chalk.dim(w.id) })))
    } catch (err) {
      output.handleError(err)
    }
  })

workspaceCommand
  .command('create')
  .description('Create a workspace')
  .requiredOption('-n, --name <name>', 'Workspace name')
  .option('-s, --slug <slug>', 'URL-safe slug (derived from --name when omitted)')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    try {
      const org = resolveOrg(opts)
      const data = await getClient().workspaces.create({
        organisation: org,
        name: opts.name,
        slug: resolveSlug(opts.name, opts.slug),
      })

      if (opts.json) return output.json(data)
      output.success(`Created workspace ${chalk.bold(data.name)} (${data.slug})`)
    } catch (err) {
      output.handleError(err)
    }
  })

workspaceCommand
  .command('delete <slug>')
  .description('Delete a workspace')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-y, --yes', 'Skip confirmation')
  .action(async (slug: string, opts) => {
    try {
      await requirePermission('workspaces:delete')
      const org = resolveOrg(opts)

      // Typed confirmation, not y/N: this takes every environment, pod and
      // secret in the workspace with it, and there is no undo.
      await confirmDestructive({
        message: `This will permanently delete workspace ${chalk.bold(slug)} and all its data.`,
        assumeYes: opts.yes,
        requireTyped: slug,
      })

      await getClient().workspaces.delete({ organisation: org, workspace: slug })
      output.success(`Deleted workspace ${chalk.bold(slug)}`)
    } catch (err) {
      output.handleError(err)
    }
  })
