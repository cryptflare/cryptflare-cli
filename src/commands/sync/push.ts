/** `cf push` - upload a local env file to an environment. */

import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import chalk from 'chalk'
import { getClient } from '@/lib/api'
import { resolveContext } from '@/lib/resolve'
import * as output from '@/lib/output'
import * as progress from '@/lib/progress'
import { chunk, validateSecrets } from '@/lib/secret-validation'
import { parseEnvFile } from '@/commands/sync/env-format'

export const pushCommand = new Command('push')
  .description('Push local .env file to remote environment')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-w, --workspace <slug>', 'Workspace slug')
  .option('-e, --env <slug>', 'Environment slug')
  .option('-f, --file <path>', 'Input file path', '.env')
  .option('--dry-run', 'Show what would be pushed without making changes')
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts)
      const scope = { organisation: ctx.org, workspace: ctx.workspace, environment: ctx.env }
      const client = getClient()

      if (!existsSync(opts.file)) {
        output.warn(`File ${chalk.bold(opts.file)} not found.`)
        process.exit(1)
      }

      const content = readFileSync(opts.file, 'utf-8')
      const local = parseEnvFile(content)

      if (local.size === 0) {
        output.info('No secrets found in file.')
        return
      }

      // Validate the whole file before writing anything. Previously each key
      // was sent individually with no rollback, so a rejection partway through
      // left the environment half-written and named only the failing field -
      // not which keys had already landed.
      const problems = validateSecrets(local)
      if (problems.length > 0) {
        output.print()
        output.warn(`${opts.file} has ${problems.length} problem(s). Nothing was pushed.`)
        output.print()
        for (const p of problems) {
          output.print(`    ${chalk.red(p.key)}  ${chalk.dim(p.reason)}`)
        }
        output.print()
        process.exit(1)
      }

      progress.start('Comparing with remote...')

      const remoteKeys = new Set<string>()
      const remotePage = await client.secrets.list(scope)
      for await (const secret of remotePage) {
        remoteKeys.add(secret.key)
      }

      const toCreate: Array<{ key: string; value: string }> = []
      const toUpdate: Array<{ key: string; value: string }> = []
      for (const [key, value] of local) {
        if (remoteKeys.has(key)) toUpdate.push({ key, value })
        else toCreate.push({ key, value })
      }

      progress.stop()

      if (opts.dryRun) {
        output.print()
        output.print(chalk.bold('  Dry run - no changes will be made'))
        output.print()
        if (toCreate.length > 0) {
          output.print(chalk.green(`  + ${toCreate.length} new secrets:`))
          toCreate.forEach(({ key }) => output.print(chalk.green(`    + ${key}`)))
        }
        if (toUpdate.length > 0) {
          output.print(chalk.blue(`  ~ ${toUpdate.length} secrets to update:`))
          toUpdate.forEach(({ key }) => output.print(chalk.blue(`    ~ ${key}`)))
        }
        output.print(chalk.dim(`\n  ${local.size} key(s) validated - no problems found.`))
        output.print()
        return
      }

      progress.start(`Pushing ${local.size} secrets...`)
      const landed: string[] = []

      // Batch endpoints instead of one request per key: each batch is a single
      // multi-row INSERT server-side, so it either lands whole or not at all.
      // It also cuts a 24-key push from 24 requests to one, which removes most
      // of the window in which a transient failure can half-apply a file.
      try {
        for (const batch of chunk(toCreate)) {
          progress.update(`Creating ${batch.length} secrets...`)
          await client.secrets.batchCreate({ ...scope, secrets: batch })
          landed.push(...batch.map((s) => s.key))
        }
        for (const batch of chunk(toUpdate)) {
          progress.update(`Updating ${batch.length} secrets...`)
          await client.secrets.batchUpdate({ ...scope, secrets: batch })
          landed.push(...batch.map((s) => s.key))
        }
      } catch (err) {
        progress.stop()
        // Say what did land. A bare error leaves the caller unable to tell an
        // untouched environment from a partly-written one.
        if (landed.length > 0) {
          output.warn(
            `Partially applied: ${landed.length} of ${local.size} key(s) were written before the failure.`,
          )
          output.print(chalk.dim(`    ${landed.join(', ')}`))
          output.print(chalk.dim('    Re-running this push is safe - it is idempotent.'))
          output.print()
        } else {
          output.warn('Nothing was written.')
        }
        throw err
      }

      progress.stop()
      output.success(
        `Pushed ${chalk.bold(String(landed.length))} secrets (${chalk.green(`+${toCreate.length}`)} new, ${chalk.blue(`~${toUpdate.length}`)} updated)`,
      )
    } catch (err) {
      output.handleError(err)
    }
  })
