/** `cf env status` - which local secrets files and values are encrypted. No network. */

import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import chalk from 'chalk'
import { Command } from 'commander'

import { gitFileStates } from '@/lib/git-state'
import { inspectContent } from '@/lib/local-env/encrypt-file'
import { detectFormat, type FileFormat } from '@/lib/local-env/formats'
import { restoreLeftovers } from '@/lib/local-env/materialize'
import { scanRepository } from '@/lib/local-env/scan'
import { findManifestRoot } from '@/lib/project-context'
import * as output from '@/lib/output'

type Row = { rel: string; format: FileFormat }

export const statusCommand = new Command('status')
  .description(
    'Show which local secrets files and values are encrypted (reads files only, no network)',
  )
  .argument('[paths...]', 'Files to check. Default: every recognised file in the project')
  .option('--json', 'Machine-readable output')
  .action((paths: string[], opts) => {
    try {
      const root = findManifestRoot(process.cwd()) ?? process.cwd()
      const rows: Row[] =
        paths.length > 0
          ? paths.flatMap((path) => {
              const rel = relative(root, resolve(path)).split(sep).join('/')
              const format = detectFormat(rel)
              return format ? [{ rel, format }] : []
            })
          : scanRepository(root).files
      const restored = restoreLeftovers(rows.map((row) => join(root, row.rel)))
      const git = gitFileStates(
        root,
        rows.map((row) => row.rel),
      )

      const report = rows
        .filter((row) => existsSync(join(root, row.rel)))
        .map((row) => ({
          file: row.rel,
          format: row.format.id,
          injection: row.format.injection,
          git: git.get(row.rel) ?? 'unknown',
          ...inspectContent(readFileSync(join(root, row.rel), 'utf-8'), row),
        }))

      if (opts.json) {
        output.json({ root, files: report, restored })
        return
      }
      output.print()
      for (const path of restored)
        output.warn(`restored ${path} from a .cf-restore sidecar left by an earlier run`)
      for (const row of report) {
        const state =
          row.encrypted > 0 && row.plaintext === 0
            ? chalk.green('encrypted')
            : row.encrypted > 0
              ? chalk.yellow('partly encrypted')
              : chalk.red('plaintext')
        const counts = chalk.dim(
          `${row.encrypted} encrypted, ${row.plaintext} plaintext, ${row.unmanaged} unmanaged`,
        )
        const tracked = row.git === 'tracked' ? chalk.yellow(' tracked by git') : ''
        output.print(`  ${row.file}  ${state}  ${counts}  ${chalk.dim(row.format)}${tracked}`)
      }
      if (report.length === 0) output.print(chalk.dim('  No local secrets files found.'))
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })
