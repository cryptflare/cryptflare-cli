/** `cf sync add` - register a project directory and its bindings. */

import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import { getOrg, getDefault } from '@/lib/config'
import * as output from '@/lib/output'
import { CAPTURE_MODES } from '@/lib/capture'
import { assertNoBindingCollisions } from '@/lib/binding-collisions'
import {
  getRegistryPath,
  loadRegistry,
  saveRegistry,
  type SyncBinding,
  type SyncProject,
} from '@/lib/sync-registry'
import { MANIFEST_FILENAME, hasManifest } from '@/lib/project-manifest'
import { parseCaptureOption } from '@/commands/sync-service/options'

export const addCommand = new Command('add')
  .description('Register a project directory so the sync service manages its env files')
  .argument('[path]', 'Project root (defaults to the current directory)', '.')
  .option('--id <id>', 'Project identifier (defaults to the directory name)')
  .option('-o, --org <id>', 'Organisation ID (defaults to the CLI default)')
  .option('-w, --workspace <slug>', 'Workspace slug (defaults to the CLI default)')
  .option(
    '-b, --bind <file=[workspace/]environment...>',
    'Bind an env file. Repeatable: --bind .env=dev --bind apps/web/.env=peak-web/dev',
  )
  .option(
    '--capture <mode>',
    `What to do with new local keys: ${CAPTURE_MODES.join(' | ')} (default off). \`auto\` creates them in CryptFlare.`,
  )
  .action(async (pathArg: string, opts) => {
    try {
      const root = resolve(pathArg)
      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`)

      if (hasManifest(root) && !opts.bind) {
        // The repo already carries its mapping; re-deriving it from flags is
        // how the two drift apart.
        output.warn(
          `${root} has a ${MANIFEST_FILENAME}. Use ${chalk.cyan('cf sync init')} to register from it.`,
        )
        output.print()
      }

      const org = opts.org ?? getOrg()
      const capture = parseCaptureOption(opts.capture)

      const bindArgs: string[] = opts.bind ?? []
      if (bindArgs.length === 0) {
        // Default binding uses the CLI's default environment for `.env`, which
        // is the single-environment case most projects start from.
        const env = getDefault('environment')
        if (!env) {
          throw new Error('No bindings given. Pass --bind .env=<environment> (repeatable).')
        }
        bindArgs.push(`.env=${env}`)
      }

      const bindings = bindArgs.map((raw): SyncBinding => {
        const idx = raw.lastIndexOf('=')
        if (idx <= 0)
          throw new Error(`Invalid --bind "${raw}". Expected <file>=[workspace/]<environment>.`)
        const file = raw.slice(0, idx)
        const target = raw.slice(idx + 1)

        // `workspace/environment` targets a different workspace per binding,
        // which is how one monorepo maps each app to its own access boundary.
        const slash = target.indexOf('/')
        if (slash > 0) {
          return {
            file,
            workspace: target.slice(0, slash),
            environment: target.slice(slash + 1),
            ...(capture ? { capture } : {}),
          }
        }
        return { file, environment: target, ...(capture ? { capture } : {}) }
      })

      // Only needed as a default for bindings that did not name their own.
      const workspace = opts.workspace ?? getDefault('workspace')
      if (!workspace && bindings.some((b) => !b.workspace)) {
        throw new Error(
          'No workspace. Pass --workspace, set one with `cf config set defaults.workspace <slug>`, ' +
            'or qualify each binding as --bind <file>=<workspace>/<environment>.',
        )
      }

      // Two files in one environment overwrite each other on every pass.
      assertNoBindingCollisions(bindings, workspace)

      const id = opts.id ?? basename(root)
      const registry = loadRegistry()
      const existingIdx = registry.projects.findIndex((p) => p.id === id)
      const project: SyncProject = {
        id,
        path: root,
        ...(org ? { org } : {}),
        ...(workspace ? { workspace } : {}),
        enabled: true,
        bindings,
      }

      if (existingIdx >= 0) registry.projects[existingIdx] = project
      else registry.projects.push(project)
      saveRegistry(registry)

      output.success(`${existingIdx >= 0 ? 'Updated' : 'Registered'} ${chalk.bold(id)} -> ${root}`)
      for (const b of bindings) {
        const marker = existsSync(join(root, b.file))
          ? chalk.dim('(exists)')
          : chalk.yellow('(will be created)')
        output.print(
          `    ${b.file} ${chalk.dim('->')} ${b.workspace ?? workspace}/${b.environment} ${marker}`,
        )
      }
      output.print()
      output.print(chalk.dim(`  Registry: ${getRegistryPath()}`))
      output.print(`  Preview:  ${chalk.cyan(`cf sync status --project ${id}`)}`)
      output.print(`  Run once: ${chalk.cyan(`cf sync run --project ${id}`)}`)
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })
