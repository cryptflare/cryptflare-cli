/** `cf pull` - write an environment's secrets into a local env file. */

import { Command } from 'commander'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import chalk from 'chalk'
import { getClient } from '@/lib/api'
import { resolveContext } from '@/lib/resolve'
import * as output from '@/lib/output'
import * as progress from '@/lib/progress'
import { applyEnvChanges, parseEnvContent } from '@/lib/env-file'
import { revealSecrets } from '@/lib/reveal'
import { formatEnvFile, warnAboutNewlineValues } from '@/commands/sync/env-format'

export const pullCommand = new Command('pull')
  .description('Pull remote secrets to a local .env file')
  .option('-o, --org <id>', 'Organisation ID')
  .option('-w, --workspace <slug>', 'Workspace slug')
  .option('-e, --env <slug>', 'Environment slug')
  .option('-f, --file <path>', 'Output file path', '.env')
  .option('--overwrite', 'Replace the file wholesale instead of merging into it')
  .option('--json', 'Output as JSON instead of .env format')
  .addHelpText(
    'after',
    `
By default an existing file is MERGED into: pulled keys are updated in place,
new ones appended, and comments, ordering and any line the CLI does not manage
are preserved. Pass --overwrite to regenerate the file from scratch instead.

The file is written with mode 0600, since it holds plaintext secrets.`,
  )
  .action(async (opts) => {
    try {
      const ctx = resolveContext(opts)
      const scope = { organisation: ctx.org, workspace: ctx.workspace, environment: ctx.env }
      const client = getClient()
      progress.start('Fetching secrets...')

      // One request for the whole environment. This was a list plus one
      // reveal per key, so a 23-secret file cost 24 round trips.
      const revealed = await revealSecrets(client, scope)
      const count = revealed.size

      if (count === 0) {
        progress.info('No secrets found in this environment.')
        return
      }

      progress.stop()

      if (opts.json) {
        output.json(Object.fromEntries(revealed))
        return
      }

      // 0600 because this file holds plaintext secrets. It previously used the
      // default, which on a typical umask is 0644 - readable by every other
      // user on the machine, including on a shared CI runner.
      const MODE = 0o600

      warnAboutNewlineValues(revealed)

      if (!existsSync(opts.file) || opts.overwrite) {
        writeFileSync(opts.file, formatEnvFile(revealed), { encoding: 'utf-8', mode: MODE })
        output.success(
          `Pulled ${chalk.bold(String(revealed.size))} secrets to ${chalk.bold(opts.file)}`,
        )
        return
      }

      // Merge rather than refuse. Refusing meant the only way forward was
      // --overwrite, which discarded comments, ordering and any key the CLI
      // does not manage - so the safe-looking option was the destructive one.
      const original = readFileSync(opts.file, 'utf-8')
      const parsed = parseEnvContent(original)
      const updates = new Map<string, string>()
      const additions = new Map<string, string>()
      for (const [key, value] of revealed) {
        if (parsed.entries.has(key)) updates.set(key, value)
        else additions.set(key, value)
      }

      const { content, skippedMultiline } = applyEnvChanges(original, updates, additions)
      if (content !== original) {
        writeFileSync(opts.file, content, { encoding: 'utf-8', mode: MODE })
      }

      const changed = [...updates.keys()].filter(
        (k) => parsed.entries.get(k)?.value !== revealed.get(k),
      )
      output.success(
        `Merged into ${chalk.bold(opts.file)}: ` +
          `${chalk.green(`+${additions.size}`)} new, ${chalk.blue(`~${changed.length}`)} updated, ` +
          `${chalk.dim(`${updates.size - changed.length} unchanged`)}`,
      )
      if (skippedMultiline.length > 0) {
        output.warn(`Left multi-line values untouched: ${skippedMultiline.join(', ')}`)
      }
    } catch (err) {
      output.handleError(err)
    }
  })
