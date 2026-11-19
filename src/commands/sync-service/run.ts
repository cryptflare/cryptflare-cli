/** `cf sync status` / `cf sync run`. */

import { Command } from 'commander'
import chalk from 'chalk'
import { requirePermission } from '@/lib/permissions'
import * as output from '@/lib/output'
import { findNewBindings } from '@/lib/rediscover'
import { getRegistryPath, loadRegistry } from '@/lib/sync-registry'
import { getStatePath } from '@/lib/sync-state'
import { onboardPending } from '@/commands/sync-service/auto'
import { selectProjects } from '@/commands/sync-service/options'
import { runPass } from '@/commands/sync-service/pass'
import { rediscover } from '@/commands/sync-service/rediscover'

export const statusCommand = new Command('status')
  .description('Show what a sync pass would do, without changing anything')
  .option('-p, --project <id>', 'Limit to one project')
  .option('-a, --all', 'Include keys that are already in sync or intentionally skipped')
  .action(async (opts) => {
    try {
      const projects = selectProjects(opts.project)
      if (projects.length === 0) {
        output.info(`No enabled projects. Add one with ${chalk.cyan('cf sync add')}.`)
        return
      }
      output.print()
      await runPass({
        projectId: opts.project,
        push: true,
        dryRun: true,
        verbose: Boolean(opts.all),
        quiet: false,
      })

      const registry = loadRegistry()
      for (const project of projects) {
        for (const binding of findNewBindings(project, registry)) {
          output.print(
            `${chalk.bold(`${project.id}/${binding.file}`)} ${chalk.dim(`<-> ${binding.workspace}/${binding.environment}`)} ` +
              chalk.green('new env file - bound on the next `cf sync run`'),
          )
        }
      }
      output.print()
      output.print(chalk.dim(`  Registry: ${getRegistryPath()}`))
      output.print(chalk.dim(`  State:    ${getStatePath()}`))
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

export const runCommand = new Command('run')
  .description('Run one sync pass over every registered project and exit')
  .option('-p, --project <id>', 'Limit to one project')
  .option('--pull-only', 'Do not push local changes up')
  .option('--dry-run', 'Alias for `cf sync status`')
  .option('-q, --quiet', 'Only log when something changes')
  .action(async (opts) => {
    try {
      await requirePermission('secrets:read')
      if (!opts.pullOnly && !opts.dryRun) await requirePermission('secrets:write')

      // New repositories under the automatic directories are set up first,
      // so this same pass already syncs them.
      if (!opts.dryRun && !opts.pullOnly && !opts.project) onboardPending()
      // And new env files in repositories that are already set up.
      if (!opts.dryRun && !opts.pullOnly) await rediscover(selectProjects(opts.project))

      const summary = await runPass({
        projectId: opts.project,
        push: !opts.pullOnly,
        dryRun: Boolean(opts.dryRun),
        verbose: false,
        quiet: Boolean(opts.quiet),
        interactive: true,
      })

      if (opts.dryRun) return
      if (summary.failures > 0)
        output.warn(`${summary.failures} binding(s) failed. See errors above.`)
      if (summary.collisions > 0) {
        output.warn(
          `${summary.collisions} group(s) of files share an environment and were not synced. See errors above.`,
        )
      }
      if (summary.failures > 0 || summary.collisions > 0) process.exit(1)
      output.success(
        `Sync complete: ${summary.pulled} pulled, ${summary.pushed} pushed, ` +
          `${summary.created} created, ${summary.conflicts} conflict(s).`,
      )
    } catch (err) {
      output.handleError(err)
    }
  })
