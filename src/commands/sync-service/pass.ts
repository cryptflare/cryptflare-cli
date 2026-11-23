/** One sync pass over the registered projects, shared by `status`, `run` and `watch`. */

import chalk from 'chalk'
import prompts from 'prompts'
import { getClient } from '@/lib/api'
import type { DeviceErrorCode } from '@/lib/device-contract'
import { classifyError } from '@/lib/device-report'
import * as output from '@/lib/output'
import { collidingFiles, describeCollision, findBindingCollisions } from '@/lib/binding-collisions'
import { isPlanLimitError, upgradeHint } from '@/lib/plan-allowance'
import { loadManifestCapture, resolveCapture } from '@/lib/sync-capture'
import {
  applyPlan,
  countActionable,
  planBinding,
  type ApplyResult,
  type BindingPlan,
  type SyncAction,
} from '@/lib/sync-engine'
import { bindingFilePath, type SyncProject } from '@/lib/sync-registry'
import { loadState, saveState } from '@/lib/sync-state'
import { ONBOARD_RETRY_MS, selectProjects } from '@/commands/sync-service/options'
import { errorMessage, errorStatus, isStringArray } from '@/lib/guards'

const ACTION_STYLE: Record<string, (s: string) => string> = {
  pull: chalk.blue,
  push: chalk.green,
  conflict: chalk.red,
  create: chalk.green,
  'confirm-create': chalk.cyan,
  'skip-invalid-local': chalk.yellow,
  'skip-new-local': chalk.yellow,
  'skip-local-deleted': chalk.dim,
  'skip-remote-deleted': chalk.dim,
  'skip-multiline': chalk.yellow,
  'needs-compare': chalk.cyan,
}

const ACTION_GLYPH: Record<string, string> = {
  pull: '<-',
  push: '->',
  conflict: '!!',
  create: '+>',
  'confirm-create': '+?',
  'skip-invalid-local': '..',
  'skip-new-local': '..',
  'skip-local-deleted': '..',
  'skip-remote-deleted': '..',
  'skip-multiline': '..',
  'needs-compare': '??',
}

function describeAction(action: SyncAction): string {
  switch (action.type) {
    case 'create':
      return 'new local key - will be created (capture: auto)'
    case 'confirm-create':
      return 'new local key - `cf sync run` asks before creating it (capture: prompt)'
    case 'skip-invalid-local':
      return `new local key, not created - ${action.reason}`
    case 'skip-new-local':
      return 'new local key, not created (capture: off) - set "capture": "auto" on the binding, or `cf push`'
    case 'skip-local-deleted':
      return 'removed locally, still remote - not deleted'
    case 'skip-remote-deleted':
      return 'removed remotely, still local - not deleted'
    case 'skip-multiline':
      return 'multi-line value, not managed'
    case 'needs-compare':
      return 'first sync for this key - `cf sync run` compares it (a dry run will not decrypt)'
    default:
      return ''
  }
}

function printPlan(plan: BindingPlan, verbose: boolean): void {
  const label = `${plan.project.id}/${plan.binding.file}`
  // A binding may name its own workspace, which overrides the project default
  // and is the whole point in a monorepo mapping each app to its own. Reading
  // only the project field printed "undefined/dev" for those.
  const scope = `${plan.binding.workspace ?? plan.project.workspace}/${plan.binding.environment}`
  const actionable = countActionable(plan)
  // Not actionable - nothing to do about them - but a dry run that stays
  // silent about keys it declined to compare is misreporting.
  const unresolved = plan.actions.filter((a) => a.type === 'needs-compare').length

  if (actionable === 0 && unresolved === 0 && !verbose) return

  output.print(
    `${chalk.bold(label)} ${chalk.dim(`<-> ${scope}`)}${plan.creating ? chalk.yellow(' (file will be created)') : ''}`,
  )
  for (const action of plan.actions) {
    if (!verbose && action.type.startsWith('skip-')) continue
    // First contact usually means every key at once - a fresh registration
    // has no baseline for any of them. One line each, carrying the same
    // sentence, buries the pulls and conflicts that need a decision. Collapse
    // to a count below, and list them under --verbose.
    if (!verbose && action.type === 'needs-compare') continue
    const style = ACTION_STYLE[action.type] ?? chalk.white
    const note = describeAction(action)
    output.print(
      `    ${style(`${ACTION_GLYPH[action.type]} ${action.key}`)}${note ? chalk.dim(`  ${note}`) : ''}`,
    )
  }

  if (unresolved > 0 && !verbose) {
    output.print(
      `    ${chalk.cyan(`?? ${unresolved} key(s) awaiting first comparison`)}` +
        chalk.dim(` - ${chalk.cyan('cf sync run')} resolves them (a dry run will not decrypt)`),
    )
  }
  if (actionable === 0 && unresolved === 0) output.print(chalk.dim('    in sync'))
}

type PassOptions = {
  projectId?: string
  push: boolean
  dryRun: boolean
  verbose: boolean
  quiet: boolean
  /** Skip signatures already logged this process, so a fortnight of polls
   * does not print the same "new local key" line 20,000 times. */
  loggedSkips?: Set<string>
  /** Someone is at a terminal, so `capture: prompt` keys can be asked about. */
  interactive?: boolean
  /** Projects to sync, when the caller already read the registry. */
  projects?: SyncProject[]
}

type PassSummary = {
  pulled: number
  pushed: number
  created: number
  conflicts: number
  failures: number
  /** Bindings refused with 401 - a login problem, not a transient one. */
  authFailures: number
  /** Bindings attempted, so "every binding failed auth" can be told apart from "one did". */
  bindings: number
  /** Groups of files refused because they are bound to one environment. */
  collisions: number
  /** Files whose new keys were not uploaded because the plan's secret limit is reached. */
  planLimited: number
  changed: boolean
  /** The first binding failure as a short code, for the device report. Never the message. */
  errorCode?: DeviceErrorCode | undefined
}

/**
 * Asks which new keys to create, for bindings in `capture: prompt`.
 * Everything is pre-selected: the developer just typed these lines, so the
 * common answer is yes, and deselecting a scratch variable is one keypress.
 */
async function askWhichToCreate(label: string, keys: string[]): Promise<string[]> {
  const { chosen } = await prompts(
    {
      type: 'multiselect',
      name: 'chosen',
      message: `[${label}] new local keys - create in CryptFlare?`,
      choices: keys.map((key) => ({ title: key, value: key, selected: true })),
      instructions: false,
      hint: 'space toggles, enter confirms',
    },
    { onCancel: () => ({ chosen: [] }) },
  )
  return isStringArray(chosen) ? chosen : []
}

/**
 * Files whose new keys the plan has no room for, and when to try again.
 * Until then the file is synced as if capture were off: existing keys still
 * move both ways, and no create is sent only to be refused again.
 */
const captureBlockedUntil = new Map<string, number>()

export async function runPass(opts: PassOptions): Promise<PassSummary> {
  const projects = opts.projects ?? selectProjects(opts.projectId)
  const summary: PassSummary = {
    pulled: 0,
    pushed: 0,
    created: 0,
    conflicts: 0,
    failures: 0,
    authFailures: 0,
    bindings: 0,
    collisions: 0,
    planLimited: 0,
    changed: false,
  }
  if (projects.length === 0) return summary

  const client = getClient()
  const state = loadState()
  let stateDirty = false

  const canAsk = Boolean(opts.interactive) && Boolean(process.stdin.isTTY)

  for (const project of projects) {
    const manifestCapture = loadManifestCapture(project)

    // Two files in one environment would overwrite each other on every pass.
    // Refuse those, say which, and sync the rest of the project.
    const collisions = findBindingCollisions(project.bindings, project.workspace)
    const collided = collidingFiles(collisions)
    summary.collisions += collisions.length
    for (const collision of collisions) {
      const signature = `${project.id}:collision:${collision.target}:${collision.files.join(',')}`
      if (opts.loggedSkips?.has(signature)) continue
      opts.loggedSkips?.add(signature)
      output.printError(chalk.red(`[${project.id}] ${describeCollision(collision)}`))
    }

    for (const binding of project.bindings) {
      if (collided.has(binding.file)) continue
      const label = `${project.id}/${binding.file}`
      summary.bindings++
      const captureBlocked = (captureBlockedUntil.get(label) ?? 0) > Date.now()
      try {
        // A dry run reports; it must not consume the reveal budget the real
        // pass needs, so first-contact keys come back as `needs-compare`.
        const plan = await planBinding(client, project, binding, state, {
          reveal: !opts.dryRun,
          capture: captureBlocked ? 'off' : resolveCapture(binding, manifestCapture),
        })

        if (opts.dryRun) {
          printPlan(plan, opts.verbose)
          continue
        }

        const result = await applyPlan(client, plan, state, {
          push: opts.push,
          ...(canAsk ? { approveCreate: (keys: string[]) => askWhichToCreate(label, keys) } : {}),
        })
        stateDirty = true
        // The plan-limit line already said why these were not created.
        if (captureBlocked)
          result.skipped = result.skipped.filter((skip) => skip.type !== 'skip-new-local')
        summary.pulled += result.pulled.length
        summary.pushed += result.pushed.length
        summary.created += result.created.length
        summary.failures += result.failed.length > 0 ? 1 : 0
        summary.conflicts += result.conflicts.length
        summary.changed ||= result.changed
        logResult(label, bindingFilePath(project, binding), result, opts)
      } catch (err) {
        if (isPlanLimitError(err)) {
          // Asking again every minute cannot succeed and buries the log.
          // Say it once, sync the rest of this file as usual, and try the
          // new keys again in an hour in case the plan changed.
          summary.planLimited++
          captureBlockedUntil.set(label, Date.now() + ONBOARD_RETRY_MS)
          const signature = `${label}:plan-limit`
          if (!opts.loggedSkips?.has(signature)) {
            opts.loggedSkips?.add(signature)
            output.printError(
              chalk.yellow(
                `[${label}] new keys were not uploaded: ${errorMessage(err)} ${upgradeHint()}. Trying again every hour.`,
              ),
            )
          }
          continue
        }
        summary.failures++
        summary.errorCode ??= classifyError(err)
        if (errorStatus(err) === 401) summary.authFailures++
        // One unreachable workspace must not stop the other projects. Log and
        // carry on; the next pass retries from the same baseline.
        output.printError(chalk.red(`[${label}] ${errorMessage(err)}`))
      }
    }
  }

  if (stateDirty) saveState(state)
  return summary
}

function logResult(label: string, filePath: string, result: ApplyResult, opts: PassOptions): void {
  if (result.conflicts.length > 0) {
    output.printError(
      chalk.red(
        `[${label}] CONFLICT on ${result.conflicts.join(', ')} - remote won, local saved to ${result.conflictFile}`,
      ),
    )
  }
  if (result.pulled.length > 0) {
    output.printError(
      chalk.blue(
        `[${label}] pulled ${result.pulled.length} -> ${filePath} (${result.pulled.join(', ')})`,
      ),
    )
  }
  if (result.pushed.length > 0) {
    output.printError(
      chalk.green(`[${label}] pushed ${result.pushed.length} (${result.pushed.join(', ')})`),
    )
  }
  if (result.created.length > 0) {
    output.printError(
      chalk.green(`[${label}] created ${result.created.length} new (${result.created.join(', ')})`),
    )
  }
  for (const failure of result.failed) {
    output.printError(chalk.red(`[${label}] ${failure.key}: not written - ${failure.reason}`))
  }

  for (const skip of result.skipped) {
    const signature = `${label}:${skip.type}:${skip.key}`
    if (opts.loggedSkips) {
      if (opts.loggedSkips.has(signature)) continue
      opts.loggedSkips.add(signature)
    }
    output.printError(chalk.yellow(`[${label}] ${skip.key}: ${describeAction(skip)}`))
  }

  if (!result.changed && !opts.quiet && result.skipped.length === 0) {
    output.printError(chalk.dim(`[${label}] no change`))
  }
}
