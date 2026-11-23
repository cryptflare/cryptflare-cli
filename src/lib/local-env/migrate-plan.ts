/**
 * Plans `cf env migrate`: every local-secrets file of a repository, the
 * environment each belongs to, what will be encrypted, what will be pushed,
 * and what git knows about it. Reads files; changes nothing.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { planBindings, planNewBindings } from '@/lib/discover'
import { gitFileStates, type GitFileState } from '@/lib/git-state'
import { decide, type EntryDecision } from '@/lib/local-env/codec'
import type { FileFormat } from '@/lib/local-env/formats'
import {
  findValueConflicts,
  groupedEnvironment,
  type Grouping,
  type ValueConflict,
} from '@/lib/local-env/migrate-grouping'
import { scanRepository, type RepositoryScan } from '@/lib/local-env/scan'
import { hasManifest, loadManifest } from '@/lib/project-manifest'
import { validateSecrets } from '@/lib/secret-validation'
import { toSlug } from '@/lib/slug'

export type FilePlan = {
  rel: string
  format: FileFormat
  workspace: string
  environment: string
  pod?: string
  /** Not in the manifest yet: the binding is proposed by this plan. */
  newBinding: boolean
  /** Names by what encryption will do with them. */
  decisions: Map<EntryDecision, string[]>
  /** Values to make sure exist in CryptFlare, by CryptFlare key. */
  push: Map<string, string>
  /** Names that cannot be stored as they are (not UPPER_SNAKE_CASE, too long). */
  invalid: Array<{ key: string; reason: string }>
  unmanaged: Array<{ name: string; line: number; reason: string }>
  duplicates: string[]
  git: GitFileState
  /** Some version of this path was committed at some point. */
  inHistory: boolean
  /** Variables another file of the same environment defines differently. */
  conflicts: ValueConflict[]
  /** Why the plan cannot take this file over (a plan limit), when it cannot. */
  blocked?: { resource: 'workspaces' | 'environments'; message: string }
}

export type MigrationPlan = {
  root: string
  workspace: string
  /** The workspace was derived from the folder name, not chosen or bound. */
  workspaceFromFolder: boolean
  org?: string
  manifestExists: boolean
  files: FilePlan[]
  scan: RepositoryScan
  /** Lines from the remote check: workspace choice, plan limits. */
  notes: string[]
  /** Flags that would make the plan fit, when it does not. */
  suggestions: string[]
}

export type PlanOptions = {
  includePublic?: boolean
  allValues?: boolean
  moveRegistryTokens?: boolean
  /** `-w`: workspace slug or id for files not bound yet. */
  workspace?: string
  /** `-e`: one environment for every file not bound yet (implies `single`). */
  environment?: string
  /** `--group`: how files not bound yet map to environments. */
  group?: Grouping
}

/** Whether git has ever recorded this path, on any branch. */
export function inGitHistory(root: string, rel: string): boolean {
  try {
    const out = execFileSync('git', ['log', '--all', '--format=%H', '-n', '1', '--', rel], {
      cwd: root,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim() !== ''
  } catch {
    return false // Not a repository, or no git: nothing recorded.
  }
}

function duplicatesOf(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const name of names) (seen.has(name) ? dup : seen).add(name)
  return [...dup]
}

const PUSHED: ReadonlySet<EntryDecision> = new Set(['encrypt', 'public', 'not-secret'])

function planFile(root: string, rel: string, format: FileFormat, opts: PlanOptions) {
  const parsed = format.parse(readFileSync(join(root, rel), 'utf-8'))
  const decisions = new Map<EntryDecision, string[]>()
  const push = new Map<string, string>()
  for (const entry of parsed.entries) {
    const decision = decide(format, entry, opts)
    decisions.set(decision, [...(decisions.get(decision) ?? []), entry.name])
    const moveToken = decision === 'registry-token' && opts.moveRegistryTokens
    // Structured files keep non-secret config local; env files push everything.
    const keep = format.style === 'structured' && decision === 'not-secret'
    if ((PUSHED.has(decision) && !keep) || moveToken) push.set(format.envName(entry), entry.value)
  }
  const invalid = validateSecrets(push)
  for (const problem of invalid) push.delete(problem.key)
  return {
    decisions,
    push,
    invalid,
    unmanaged: parsed.unmanaged,
    duplicates: duplicatesOf(parsed.entries.map((entry) => entry.name)),
  }
}

/** Builds the plan for a repository. */
export function planMigration(root: string, opts: PlanOptions = {}): MigrationPlan {
  const scan = scanRepository(root)
  const manifestExists = hasManifest(root)
  const manifest = manifestExists ? loadManifest(root) : null
  const workspaceFromFolder = !opts.workspace && !manifest?.workspace
  const workspace = opts.workspace ?? manifest?.workspace ?? (toSlug(basename(root)) || 'project')
  const group: Grouping = opts.environment ? 'single' : (opts.group ?? 'per-file')

  // Bindings: the manifest's own where it has them, the cf sync init naming
  // rules for the rest. Registry auth files are pushed to the root binding's
  // environment, since npm reads them from wherever it runs.
  const bound = new Map((manifest?.bindings ?? []).map((binding) => [binding.file, binding]))
  const fresh = scan.files.map((file) => file.rel).filter((rel) => !bound.has(rel))
  const proposed = new Map(
    (manifest ? planNewBindings(manifest.bindings, fresh) : planBindings(fresh)).map((item) => [
      item.file,
      item,
    ]),
  )
  const git = gitFileStates(
    root,
    scan.files.map((file) => file.rel),
  )

  const files = scan.files.map((file): FilePlan => {
    const binding = bound.get(file.rel)
    const environment =
      binding?.environment ??
      (group === 'per-file'
        ? (proposed.get(file.rel)?.environment ?? 'root-dev')
        : groupedEnvironment(file.rel, group, opts.environment))
    return {
      rel: file.rel,
      format: file.format,
      workspace: binding?.workspace ?? workspace,
      environment,
      ...(binding?.pod ? { pod: binding.pod } : {}),
      newBinding: !binding,
      ...planFile(root, file.rel, file.format, opts),
      git: git.get(file.rel) ?? 'unknown',
      inHistory: inGitHistory(root, file.rel),
      conflicts: [],
    }
  })

  // A registry token belongs with the env file beside it: `cf run` there
  // provides it, and the auth file itself is never bound (cf sync would read
  // `_auth=` as a dotenv line).
  for (const file of files.filter((item) => item.format.style === 'registry')) {
    const dir = file.rel.includes('/') ? file.rel.slice(0, file.rel.lastIndexOf('/') + 1) : ''
    const sibling = files.find(
      (item) =>
        item.format.style === 'env' &&
        item.rel.startsWith(dir) &&
        !item.rel.slice(dir.length).includes('/'),
    )
    if (sibling) {
      file.environment = sibling.environment
      file.workspace = sibling.workspace
    }
  }

  const plan: MigrationPlan = {
    root,
    workspace,
    workspaceFromFolder,
    ...(manifest?.org ? { org: manifest.org } : {}),
    manifestExists,
    files,
    scan,
    notes: [],
    suggestions: [],
  }
  markConflicts(plan)
  return plan
}

/**
 * Records, on each file, the variables another file of its environment
 * defines differently. Run again after the workspace is resolved.
 */
export function markConflicts(plan: MigrationPlan): void {
  const migrating = plan.files.filter(
    (file) => file.format.style !== 'registry' || file.push.size > 0,
  )
  const conflicts = findValueConflicts(migrating)
  for (const file of plan.files)
    file.conflicts = conflicts.filter((item) => item.files.includes(file.rel))
}

/** Problems that stop `--yes` before anything changes. */
export function blockers(plan: MigrationPlan): string[] {
  return plan.files.flatMap((file) => [
    ...file.conflicts.map((item) => `${file.rel}: ${item.name} conflicts`),
    ...(file.blocked ? [`${file.rel}: ${file.blocked.message}`] : []),
  ])
}

/** `.gitignore` lines the plan recommends that the root `.gitignore` lacks. */
export function missingIgnores(plan: MigrationPlan): string[] {
  const path = join(plan.root, '.gitignore')
  const lines = new Set(
    (existsSync(path) ? readFileSync(path, 'utf-8') : '').split(/\r?\n/).map((line) => line.trim()),
  )
  const wanted = ['*.cf-restore', '*.cf-conflict-*']
  for (const file of plan.files) {
    // Files the tool reads itself hold plaintext while `--materialize` runs.
    if (
      file.git === 'untracked' ||
      (file.format.injection === 'materialize' && file.git !== 'ignored')
    ) {
      wanted.push(file.rel)
    }
  }
  return [...new Set(wanted)].filter((line) => !lines.has(line))
}
