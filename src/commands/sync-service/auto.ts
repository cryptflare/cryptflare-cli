/** `cf sync auto` - automatic setup of repositories under the named roots. */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Command } from 'commander'
import chalk from 'chalk'
import * as output from '@/lib/output'
import { pendingRepositories } from '@/lib/auto-onboard'
import { loadRegistry, saveRegistry } from '@/lib/sync-registry'
import { MANIFEST_FILENAME } from '@/lib/project-manifest'
import { ONBOARD_RETRY_MS } from '@/commands/sync-service/options'

/** Repositories that failed to set up, and when each may be tried again. */
const onboardRetryAt = new Map<string, number>()
/** The last reason logged per repository, so an hourly retry that fails the same way stays quiet. */
const onboardReasonLogged = new Map<string, string>()

/**
 * Sets up every repository under the auto roots that is not registered yet.
 *
 * Each one is set up by running this CLI's own `sync init`, in a child
 * process: the exact path a person would take by hand, with its own exit
 * code, so one repository that cannot be set up (a plan limit, a bad file)
 * cannot take the others or the sync loop down with it.
 *
 * @returns how many repositories were set up.
 */
function isRegisteredPath(path: string): boolean {
  try {
    return loadRegistry().projects.some((project) => resolve(project.path) === resolve(path))
  } catch {
    return false
  }
}

export function onboardPending(): number {
  const pending = pendingRepositories(loadRegistry()).filter(
    (repo) => (onboardRetryAt.get(repo.path) ?? 0) <= Date.now(),
  )
  let done = 0

  for (const repo of pending) {
    const args = [
      'sync',
      'init',
      repo.path,
      '--yes',
      ...(repo.action === 'create' ? ['--create'] : []),
    ]
    const result = spawnSync(process.execPath, [process.argv[1] ?? 'cf', ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // The last line the child printed is its summary or its error. Its
    // output never holds a secret value, but only that one line is repeated.
    const lastLine = (text: string | null | undefined) =>
      (text ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .pop()
    // Errors and the plan-limit summary go to stderr, so that is read first.
    const reason = (
      lastLine(result.stderr) ??
      lastLine(result.stdout) ??
      `exit ${result.status}`
    ).slice(0, 400)

    if (result.status === 0) {
      done += 1
      onboardRetryAt.delete(repo.path)
      onboardReasonLogged.delete(repo.path)
      output.printError(
        chalk.green(
          `[auto] set up ${repo.path}${repo.action === 'create' ? ' (new: manifest written, files uploaded)' : ' (files pulled)'}`,
        ),
      )
    } else if (isRegisteredPath(repo.path)) {
      // Part of it was set up: a plan limit or one bad file kept some files
      // out. It is registered, so it is not looked at here again, and the
      // files left out are picked up by the sync pass when they can be.
      done += 1
      onboardRetryAt.delete(repo.path)
      output.printError(chalk.yellow(`[auto] set up ${repo.path}, but not all of it. ${reason}`))
    } else {
      onboardRetryAt.set(repo.path, Date.now() + ONBOARD_RETRY_MS)
      // Said once per repository, not once an hour for as long as a plan
      // limit stands.
      if (onboardReasonLogged.get(repo.path) !== reason) {
        onboardReasonLogged.set(repo.path, reason)
        output.printError(
          chalk.yellow(`[auto] could not set up ${repo.path}: ${reason} - trying again every hour`),
        )
      }
    }
  }
  return done
}

export const autoCommand = new Command('auto')
  .description(
    'Set up every repository under a directory automatically, now and as new ones appear',
  )
  .argument('[directory]', 'Directory that holds your repositories, e.g. ~/code')
  .option(
    '--remove',
    'Stop setting up repositories under this directory (already set up projects are kept)',
  )
  .addHelpText(
    'after',
    `
Run once per machine:

  cf sync auto ~/code
  cf sync install-service --enable

After that there is nothing to run per project. Any git repository under
~/code that has a .env, .dev.vars or .envrc gets a ${MANIFEST_FILENAME}, its own
workspace, and its files uploaded and kept in sync. A fresh clone that already
has a ${MANIFEST_FILENAME} gets its env files pulled.

This uploads the env files of every repository under the directory without
asking again. Name only directories whose repositories are yours.`,
  )
  .action((directory: string | undefined, opts) => {
    try {
      const registry = loadRegistry()
      const roots = new Set(registry.roots ?? [])

      if (!directory) {
        if (roots.size === 0) {
          output.info(
            `No automatic directories. Add one with ${chalk.cyan('cf sync auto <directory>')}.`,
          )
          return
        }
        for (const root of roots) output.print(`  ${root}`)
        const waiting = pendingRepositories(registry)
        output.print()
        output.print(
          chalk.dim(
            `  ${waiting.length} repository(ies) waiting to be set up on the next sync pass.`,
          ),
        )
        return
      }

      const root = resolve(directory)
      if (opts.remove) {
        if (!roots.delete(root)) throw new Error(`${root} is not an automatic directory.`)
        saveRegistry({ ...registry, roots: [...roots] })
        output.success(
          `Stopped setting up repositories under ${chalk.bold(root)}. Projects already set up are unchanged.`,
        )
        return
      }

      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`)
      roots.add(root)
      const next = { ...registry, roots: [...roots] }
      saveRegistry(next)

      const waiting = pendingRepositories(next)
      output.success(`Repositories under ${chalk.bold(root)} are now set up automatically.`)
      output.print()
      if (waiting.length === 0) {
        output.print(chalk.dim('  Nothing to set up right now.'))
      } else {
        output.print(`  ${waiting.length} to set up on the next pass:`)
        for (const repo of waiting.slice(0, 20)) {
          output.print(
            `    ${repo.path} ${chalk.dim(repo.action === 'create' ? '(new: env files will be uploaded)' : '(has a manifest: files will be pulled)')}`,
          )
        }
        if (waiting.length > 20) output.print(chalk.dim(`    ...and ${waiting.length - 20} more`))
      }
      output.print()
      output.print(`  Do it now:        ${chalk.cyan('cf sync run')}`)
      output.print(`  Keep it running:  ${chalk.cyan('cf sync install-service --enable')}`)
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })
