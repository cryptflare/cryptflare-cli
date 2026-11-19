/** Picks up new env files in repositories that are already registered. */

import { dirname } from 'node:path'
import chalk from 'chalk'
import { getClient } from '@/lib/api'
import * as output from '@/lib/output'
import { isEnvFileName } from '@/lib/discover'
import { watchFiles, type DirectoryWatch, type FileWake } from '@/lib/file-wake'
import { describePlanRefusal } from '@/lib/plan-allowance'
import { findNewBindings, rediscoverProjects, type RediscoverReport } from '@/lib/rediscover'
import {
  bindingFilePath,
  getRegistryPath,
  loadRegistry,
  type SyncProject,
  type SyncRegistry,
} from '@/lib/sync-registry'
import { newScopeCache } from '@/lib/provision'
import { errorMessage } from '@/lib/guards'

/** Files that could not be bound, and when each may be tried again. */
const rediscoverRetryAt = new Map<string, number>()

/**
 * Binds env files that appeared since each project was set up. See
 * `../lib/rediscover.ts` for what it will and will not touch.
 *
 * Never throws: a repository whose new file cannot be bound must not stop
 * the files that are already synced.
 *
 * @param logged Lines already printed by this process. Without it every line is printed.
 * @returns how many files were newly bound.
 */
export async function rediscover(
  projects: readonly SyncProject[],
  logged?: Set<string>,
): Promise<number> {
  // Looking is local and free; the client is only needed once something new is found.
  let registry: SyncRegistry
  try {
    registry = loadRegistry()
  } catch {
    return 0
  }
  if (!projects.some((project) => findNewBindings(project, registry).length > 0)) return 0

  let reports: RediscoverReport[]
  try {
    reports = await rediscoverProjects(getClient(), projects, {
      retryAt: rediscoverRetryAt,
      scopeCache: newScopeCache(),
    })
  } catch (err) {
    output.printError(chalk.yellow(`[sync] could not look for new env files: ${errorMessage(err)}`))
    return 0
  }

  const once = (signature: string, line: string) => {
    if (logged?.has(signature)) return
    logged?.add(signature)
    output.printError(line)
  }

  let added = 0
  for (const report of reports) {
    const id = report.project.id
    for (const binding of report.added) {
      added += 1
      const mode = binding.capture ?? 'off'
      output.printError(
        chalk.green(
          `[${id}/${binding.file}] new env file, now synced with ${binding.workspace}/${binding.environment} (capture: ${mode})`,
        ),
      )
    }
    if (report.refused.length > 0) {
      once(
        `${id}:plan:${report.refused.map((item) => item.file).join(',')}`,
        chalk.yellow(`[${id}] ${describePlanRefusal(report.refused, report.allowance)}`),
      )
    }
    for (const item of report.failed) {
      once(
        `${id}:rediscover:${item.file}:${item.message}`,
        chalk.yellow(
          `[${id}/${item.file}] new env file, not synced yet: ${item.message.slice(0, 200)} - trying again every hour`,
        ),
      )
    }
  }
  return added
}

/** What the watch loop watches: every bound file, plus the registry itself. */
export function startFileWake(projects: readonly SyncProject[]): FileWake {
  const files = projects.flatMap((project) =>
    project.bindings.map((binding) => bindingFilePath(project, binding)),
  )
  // A new env file wakes the loop too, wherever a bound file already lives
  // and at the top of each repository.
  const directories: DirectoryWatch[] = [
    ...new Set([...projects.map((project) => project.path), ...files.map((file) => dirname(file))]),
  ].map((directory) => ({ directory, matches: isEnvFileName }))
  // `cf sync auto`, `init`, `add` and `remove` all save the registry, so
  // watching it is what makes them take effect without a restart.
  return watchFiles([...files, getRegistryPath()], undefined, directories)
}

/** Changes when the set of things to watch changes, and only then. */
export function watchSignature(projects: readonly SyncProject[], roots: readonly string[]): string {
  return JSON.stringify([
    [...roots].sort(),
    projects.map((project) => [
      project.id,
      project.path,
      project.bindings.map((binding) => binding.file),
    ]),
  ])
}
