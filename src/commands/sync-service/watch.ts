/** `cf sync watch` - the long-running service loop. */

import { Command } from 'commander'
import chalk from 'chalk'
import { requirePermission } from '@/lib/permissions'
import * as output from '@/lib/output'
import { type FileWake } from '@/lib/file-wake'
import { needsLoginMessage } from '@/lib/login-state'
import { getRegistryPath, loadRegistry, type SyncProject } from '@/lib/sync-registry'
import { onboardPending } from '@/commands/sync-service/auto'
import {
  AUTH_FAILURE_LIMIT,
  BACKOFF_CEILING_MS,
  BACKOFF_MULTIPLIER,
  DEFAULT_INTERVAL_S,
  EXIT_NEEDS_LOGIN,
  MIN_INTERVAL_S,
  NO_CHANGE_GRACE,
  ONBOARD_INTERVAL_MS,
  REDISCOVER_MIN_INTERVAL_MS,
  jittered,
  selectProjects,
} from '@/commands/sync-service/options'
import { runPass } from '@/commands/sync-service/pass'
import { rediscover, startFileWake, watchSignature } from '@/commands/sync-service/rediscover'
import { errorMessage } from '@/lib/guards'

export const watchCommand = new Command('watch')
  .description(
    'Long-running loop that syncs every registered project (what the background service runs)',
  )
  .option('-p, --project <id>', 'Limit to one project')
  .option('--interval <seconds>', 'Base poll interval', String(DEFAULT_INTERVAL_S))
  .option('--pull-only', 'Do not push local changes up')
  .option('-q, --quiet', 'Only log when something changes')
  .action(async (opts) => {
    try {
      const intervalS = Number(opts.interval)
      if (!Number.isFinite(intervalS) || intervalS < MIN_INTERVAL_S) {
        throw new Error(`--interval must be a number >= ${MIN_INTERVAL_S} (got ${opts.interval})`)
      }
      const baseIntervalMs = intervalS * 1_000

      await requirePermission('secrets:read')
      if (!opts.pullOnly) await requirePermission('secrets:write')

      // Setting repositories up uploads, so a pull-only or single-project
      // service never does it.
      const canOnboard = !opts.project && !opts.pullOnly
      const canDiscover = !opts.pullOnly

      // Read once here so a registry that is broken, or a --project that does
      // not exist, fails at start where someone sees it.
      const initial = selectProjects(opts.project)
      const initialRoots = canOnboard ? (loadRegistry().roots ?? []) : []

      let stop = false
      const onSignal = (sig: NodeJS.Signals) => {
        if (stop) return
        stop = true
        output.printError(chalk.dim(`[sync] ${sig} received, finishing current pass...`))
      }
      process.on('SIGTERM', onSignal)
      process.on('SIGINT', onSignal)

      output.printError(
        chalk.bold(
          `[sync] started, checking every ${intervalS}s${opts.pullOnly ? ' (pull-only)' : ''}`,
        ),
      )
      if (initial.length === 0 && initialRoots.length === 0) {
        // Not an error: the service is often installed before the first
        // directory is named, and it picks that up without a restart.
        output.printError(
          chalk.dim(
            `[sync] nothing to sync yet. Waiting for \`cf sync auto <directory>\` or \`cf sync init\` (registry: ${getRegistryPath()})`,
          ),
        )
      }

      const loggedSkips = new Set<string>()
      let backoffMs = baseIntervalMs
      let idlePasses = 0
      let authFailedPasses = 0

      let fileWake: FileWake | undefined
      let signature: string | undefined
      let knownRoots = new Set<string>()
      let nextOnboardAt = 0
      let lastRediscoverAt = 0
      // Whether this turn of the loop was caused by a change on disk.
      let woken = false
      let registryProblem = ''

      /** The registry as it is now, or `null` while it cannot be read. */
      const readRegistry = (): { projects: SyncProject[]; roots: string[] } | null => {
        try {
          const projects = selectProjects(opts.project)
          const roots = canOnboard ? (loadRegistry().roots ?? []) : []
          registryProblem = ''
          return { projects, roots }
        } catch (err) {
          // Saved half-edited, or the one project this service is for was
          // removed. Say so once and wait for it to be put right.
          const problem = errorMessage(err)
          if (problem !== registryProblem)
            output.printError(chalk.red(`[sync] ${problem} - waiting for the registry to be fixed`))
          registryProblem = problem
          return null
        }
      }

      while (!stop) {
        // The registry is read again on every turn, and the loop is woken
        // when the file changes. That is what makes `cf sync auto <dir>`,
        // `cf sync init` and `cf sync remove` take effect in a running
        // service.
        let current = readRegistry()

        if (current) {
          const addedRoots = current.roots.filter((root) => !knownRoots.has(root))
          const currentRoots = current.roots
          const removedRoots = [...knownRoots].filter((root) => !currentRoots.includes(root))
          if (signature !== undefined) {
            for (const root of addedRoots)
              output.printError(chalk.bold(`[sync] now setting up repositories under ${root}`))
            for (const root of removedRoots)
              output.printError(chalk.dim(`[sync] no longer setting up repositories under ${root}`))
          }
          knownRoots = new Set(current.roots)
          // A directory that was just named is looked at now, not at the
          // next ten-minute mark.
          if (addedRoots.length > 0) nextOnboardAt = 0

          if (current.roots.length > 0 && Date.now() >= nextOnboardAt) {
            nextOnboardAt = Date.now() + ONBOARD_INTERVAL_MS
            if (onboardPending() > 0) current = readRegistry() ?? current
          }

          if (
            canDiscover &&
            (woken || Date.now() - lastRediscoverAt >= REDISCOVER_MIN_INTERVAL_MS)
          ) {
            lastRediscoverAt = Date.now()
            if ((await rediscover(current.projects, loggedSkips)) > 0)
              current = readRegistry() ?? current
          }

          const nextSignature = watchSignature(current.projects, current.roots)
          if (nextSignature !== signature) {
            const fileCount = current.projects.reduce(
              (n, project) => n + project.bindings.length,
              0,
            )
            output.printError(
              chalk.bold(
                `[sync] ${signature === undefined ? 'watching' : 'registry changed, now watching'} ` +
                  `${current.projects.length} project(s), ${fileCount} file(s)`,
              ),
            )
            // New projects and new files mean new things to watch.
            fileWake?.close()
            fileWake = startFileWake(current.projects)
            if (fileWake.watching === 0) {
              output.printError(
                chalk.dim(
                  '[sync] file changes cannot be watched here; relying on the poll interval',
                ),
              )
            }
            signature = nextSignature
          }
        }

        const summary = await runPass({
          projectId: opts.project,
          push: !opts.pullOnly,
          dryRun: false,
          verbose: false,
          quiet: Boolean(opts.quiet),
          loggedSkips,
          projects: current?.projects ?? [],
        })

        // A revoked or expired token fails every binding with 401 and will keep
        // doing so. Retrying it every minute for a fortnight helps nobody and
        // buries the cause in the journal, so stop and say what to do.
        authFailedPasses =
          summary.bindings > 0 && summary.authFailures === summary.bindings
            ? authFailedPasses + 1
            : 0
        if (authFailedPasses >= AUTH_FAILURE_LIMIT) {
          output.printError(chalk.red(needsLoginMessage(AUTH_FAILURE_LIMIT)))
          process.exit(EXIT_NEEDS_LOGIN)
        }

        if (summary.changed || summary.failures > 0) {
          // Activity (or trouble) means poll tight again - a developer who just
          // rotated a secret should not wait out a ten-minute backoff.
          idlePasses = 0
          backoffMs = baseIntervalMs
        } else if (++idlePasses >= NO_CHANGE_GRACE) {
          backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_CEILING_MS)
        }

        if (stop) break

        const sleepMs = jittered(backoffMs)
        const edited = await new Promise<boolean>((resolveSleep) => {
          const timer = setTimeout(() => resolveSleep(false), sleepMs)
          const wake = (byEdit: boolean) => {
            clearTimeout(timer)
            resolveSleep(byEdit)
          }
          process.once('SIGTERM', () => wake(false))
          process.once('SIGINT', () => wake(false))
          void fileWake?.next().then(() => wake(true))
        })
        woken = edited
        if (edited) {
          // Someone is working in these files: poll tight again.
          idlePasses = 0
          backoffMs = baseIntervalMs
        }
      }

      fileWake?.close()
      output.printError(chalk.dim('[sync] stopped'))
    } catch (err) {
      output.handleError(err)
    }
  })
