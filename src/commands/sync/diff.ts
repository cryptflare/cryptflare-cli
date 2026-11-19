/** `cf diff` - compare a local env file with an environment. */

import { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import chalk from 'chalk'
import { getClient } from '@/lib/api'
import { resolveContext } from '@/lib/resolve'
import { requirePermission } from '@/lib/permissions'
import * as output from '@/lib/output'
import * as progress from '@/lib/progress'
import { revealSecrets } from '@/lib/reveal'
import { parseEnvFile } from '@/commands/sync/env-format'

export const diffCommand = new Command('diff')
  .description('Compare local .env file with remote secrets')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-w, --workspace <slug>', 'Workspace slug')
  .option('-e, --env <slug>', 'Environment slug')
  .option('-f, --file <path>', 'Input file path', '.env')
  .option('--values', 'Also compare values, not just key names (decrypts each shared key)')
  .option('--exit-code', 'Exit 1 when anything differs, for use in CI')
  .action(async (opts) => {
    try {
      await requirePermission(opts.values ? 'secrets:read' : 'secrets:list')
      const ctx = resolveContext(opts)
      const scope = { organisation: ctx.org, workspace: ctx.workspace, environment: ctx.env }
      const client = getClient()

      if (!existsSync(opts.file)) {
        output.warn(`File ${chalk.bold(opts.file)} not found.`)
        process.exit(1)
      }

      const content = readFileSync(opts.file, 'utf-8')
      const local = parseEnvFile(content)

      progress.start('Comparing...')

      const remoteKeys = new Set<string>()
      const diffPage = await client.secrets.list(scope)
      for await (const secret of diffPage) {
        remoteKeys.add(secret.key)
      }

      progress.stop()

      const onlyLocal: string[] = []
      const onlyRemote: string[] = []
      const common: string[] = []

      for (const key of local.keys()) {
        if (remoteKeys.has(key)) common.push(key)
        else onlyLocal.push(key)
      }
      for (const key of remoteKeys) {
        if (!local.has(key)) onlyRemote.push(key)
      }

      // Values are only compared on request: it costs one reveal per shared
      // key, each of which is a rate-limited, audit-logged decryption.
      const changed: string[] = []
      if (opts.values && common.length > 0) {
        progress.start(`Comparing ${common.length} value(s)...`)
        try {
          const remote = await revealSecrets(client, scope, common)
          for (const key of common) {
            const value = remote.get(key)
            if (value !== undefined && value !== local.get(key)) changed.push(key)
          }
        } finally {
          progress.stop()
        }
      }

      const identical = onlyLocal.length === 0 && onlyRemote.length === 0 && changed.length === 0

      if (identical) {
        // Never claim "in sync" off a key comparison alone. Matching key names
        // say nothing about values, and reporting that as in sync is how a
        // stale .env reaches production with the CLI's blessing.
        if (opts.values) output.success('Local and remote match (keys and values).')
        else
          output.success(
            `Keys match. Values not compared - pass ${chalk.bold('--values')} to compare them.`,
          )
        return
      }

      output.print()
      if (onlyLocal.length > 0) {
        output.print(chalk.green(`  + ${onlyLocal.length} only in local (${opts.file}):`))
        onlyLocal.forEach((k) => output.print(chalk.green(`    + ${k}`)))
      }
      if (onlyRemote.length > 0) {
        output.print(chalk.red(`  - ${onlyRemote.length} only in remote:`))
        onlyRemote.forEach((k) => output.print(chalk.red(`    - ${k}`)))
      }
      if (changed.length > 0) {
        // Key names only. Printing either side's value here would leak a
        // secret into a terminal and any CI log scraping this output.
        output.print(chalk.yellow(`  ~ ${changed.length} differ in value:`))
        changed.forEach((k) => output.print(chalk.yellow(`    ~ ${k}`)))
      }
      const unchanged = common.length - changed.length
      if (unchanged > 0) {
        output.print(
          opts.values
            ? chalk.dim(`  = ${unchanged} identical`)
            : chalk.dim(`  = ${unchanged} in both (values not compared - pass --values)`),
        )
      }
      output.print()

      if (opts.exitCode) process.exit(1)
    } catch (err) {
      output.handleError(err)
    }
  })
