/**
 * The part of `cf env migrate`'s plan that needs the API: which workspace
 * the new bindings go to, and whether the organisation's plan has room for
 * the workspaces and environments the plan would create.
 *
 * It runs for the dry run too, so a file that cannot fit is reported up
 * front with the flag that would make it fit, instead of being listed as
 * "encrypt" and refused on apply. It creates nothing.
 */

import type { CryptFlare } from '@cryptflare/sdk'

import { isRecord, readString } from '@/lib/guards'
import {
  findValueConflicts,
  groupedEnvironment,
  type Grouping,
} from '@/lib/local-env/migrate-grouping'
import { markConflicts, type FilePlan, type MigrationPlan } from '@/lib/local-env/migrate-plan'
import { loadPlanAllowance, upgradeHint, type PlanAllowance } from '@/lib/plan-allowance'
import { knownEnvironments, newScopeCache, type ScopeCache } from '@/lib/provision'

export type RemoteOptions = {
  /** `-w` as given: a slug or an id. */
  workspace?: string
  /** `--create-workspace`: a `-w` that does not exist may be created. */
  createWorkspace?: boolean
  /** The grouping in force, for the suggestions. */
  group: Grouping
}

export type RemoteCheck = { allowance: PlanAllowance | null; cache: ScopeCache }

type Workspace = { id?: string; slug: string }

async function listWorkspaces(client: CryptFlare, org: string): Promise<Workspace[]> {
  const raw: unknown = await client.workspaces.list({ organisation: org })
  const items: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw['data'])
      ? (raw['data'] as unknown[])
      : []
  return items.flatMap((item) => {
    const slug = readString(item, 'slug')
    const id = readString(item, 'id')
    return slug ? [{ slug, ...(id ? { id } : {}) }] : []
  })
}

/** Picks the workspace for files not bound yet, or throws when `-w` names none that exists. */
function chooseWorkspace(plan: MigrationPlan, list: Workspace[], opts: RemoteOptions): string {
  const slugs = list.map((ws) => ws.slug)
  const existing = slugs.length > 0 ? slugs.join(', ') : 'none'
  if (opts.workspace) {
    const found = list.find((ws) => ws.slug === opts.workspace || ws.id === opts.workspace)
    if (found) return found.slug
    if (opts.createWorkspace) {
      plan.notes.push(`Workspace "${opts.workspace}" does not exist yet and will be created.`)
      return opts.workspace
    }
    throw new Error(
      `Workspace "${opts.workspace}" does not exist in this organisation (existing: ${existing}). ` +
        'Pass an existing one with -w, or add --create-workspace to create it.',
    )
  }
  if (slugs.includes(plan.workspace)) return plan.workspace
  const only = list.length === 1 ? list[0] : undefined
  if (plan.workspaceFromFolder && only) {
    plan.notes.push(
      `No workspace "${plan.workspace}" (the folder name): using "${only.slug}", the organisation's only workspace. ` +
        `Pass -w ${plan.workspace} --create-workspace to create a new one instead.`,
    )
    return only.slug
  }
  plan.notes.push(
    `Workspace "${plan.workspace}" will be created (existing: ${existing}; -w <slug> uses one of them).`,
  )
  return plan.workspace
}

/** Files that will make the API create something: everything apply provisions. */
function provisioned(plan: MigrationPlan): FilePlan[] {
  return plan.files.filter((file) => file.format.style !== 'registry' || file.push.size > 0)
}

type Fit = { workspaces: number; environments: number }

/** New workspaces and environments the files need, given what exists. */
async function needed(
  client: CryptFlare,
  org: string,
  files: ReadonlyArray<{ workspace: string; environment: string }>,
  cache: ScopeCache,
): Promise<Fit> {
  const newWs = new Set<string>()
  const newEnv = new Set<string>()
  for (const file of files) {
    const exists = cache.workspaces?.has(file.workspace) ?? false
    if (!exists) newWs.add(file.workspace)
    const envs = exists
      ? await knownEnvironments(client, org, file.workspace, cache)
      : new Set<string>()
    if (!envs.has(file.environment)) newEnv.add(`${file.workspace}/${file.environment}`)
  }
  return { workspaces: newWs.size, environments: newEnv.size }
}

function fits(fit: Fit, allowance: PlanAllowance): boolean {
  return (
    fit.workspaces <= allowance.remaining.workspaces &&
    fit.environments <= allowance.remaining.environments
  )
}

/** Marks each file the plan has no room for, in plan order, as apply would meet them. */
async function markBlocked(
  client: CryptFlare,
  org: string,
  plan: MigrationPlan,
  allowance: PlanAllowance,
  cache: ScopeCache,
): Promise<void> {
  const room = { ...allowance.remaining }
  const made = new Set<string>()
  const why = (resource: keyof Fit) => {
    const limit = allowance.limits[resource]
    const inUse = limit - allowance.remaining[resource]
    const taken = allowance.remaining[resource] > 0 ? ', and the files above take the rest' : ''
    return `the ${allowance.plan} plan allows ${limit} ${resource}, ${inUse} in use${taken}`
  }
  for (const file of provisioned(plan)) {
    const wsExists = (cache.workspaces?.has(file.workspace) ?? false) || made.has(file.workspace)
    const envs =
      wsExists && cache.workspaces?.has(file.workspace)
        ? await knownEnvironments(client, org, file.workspace, cache)
        : new Set<string>()
    const envKey = `${file.workspace}/${file.environment}`
    const envExists = envs.has(file.environment) || made.has(envKey)
    if (!wsExists && room.workspaces <= 0) {
      file.blocked = {
        resource: 'workspaces',
        message: `no room for workspace "${file.workspace}": ${why('workspaces')}`,
      }
      continue
    }
    if (!envExists && room.environments <= 0) {
      file.blocked = {
        resource: 'environments',
        message: `no room for environment "${file.environment}": ${why('environments')}`,
      }
      continue
    }
    if (!wsExists) {
      room.workspaces -= 1
      made.add(file.workspace)
    }
    if (!envExists) {
      room.environments -= 1
      made.add(envKey)
    }
  }
}

/** The first set of flags under which every file fits and no names conflict. */
async function suggest(
  client: CryptFlare,
  org: string,
  plan: MigrationPlan,
  allowance: PlanAllowance,
  cache: ScopeCache,
  opts: RemoteOptions,
): Promise<string[]> {
  const files = provisioned(plan)
  const ws = opts.workspace ? ` -w ${plan.workspace}` : ''
  const target = files.find((file) => file.newBinding)?.workspace ?? plan.workspace
  const existingEnvs =
    cache.workspaces?.has(target) === true
      ? [...(await knownEnvironments(client, org, target, cache))]
      : []
  const candidates: Array<{ flags: string; group: Exclude<Grouping, 'per-file'>; env?: string }> = [
    ...(opts.group === 'per-file' ? [{ flags: '--group per-app', group: 'per-app' as const }] : []),
    ...existingEnvs.map((env) => ({ flags: `-e ${env}`, group: 'single' as const, env })),
    { flags: '-e dev', group: 'single' as const, env: 'dev' },
  ]
  for (const candidate of candidates) {
    const regrouped = files.map((file) =>
      file.newBinding
        ? { ...file, environment: groupedEnvironment(file.rel, candidate.group, candidate.env) }
        : file,
    )
    if (findValueConflicts(regrouped).length > 0) continue
    if (fits(await needed(client, org, regrouped, cache), allowance))
      return [`cf env migrate${ws} ${candidate.flags}`]
  }
  return [upgradeHint()]
}

/**
 * Resolves the workspace for files not bound yet and checks the plan's room.
 * Mutates `plan`: workspace, conflicts, `blocked`, notes and suggestions.
 *
 * @throws When `-w` names a workspace that does not exist and creation was not allowed.
 */
export async function checkRemote(
  client: CryptFlare,
  org: string,
  plan: MigrationPlan,
  opts: RemoteOptions,
): Promise<RemoteCheck> {
  const list = await listWorkspaces(client, org)
  const cache = newScopeCache()
  cache.workspaces = new Set(list.map((ws) => ws.slug))

  const workspace = chooseWorkspace(plan, list, opts)
  plan.workspace = workspace
  for (const file of plan.files) if (file.newBinding) file.workspace = workspace
  markConflicts(plan)

  const allowance = await loadPlanAllowance(client, org)
  if (!allowance) {
    plan.notes.push('Plan limits could not be read; a limit that is reached is reported on apply.')
    return { allowance, cache }
  }
  const fit = await needed(client, org, provisioned(plan), cache)
  const show = (n: number) => (n === Infinity ? 'unlimited' : String(n))
  const usedOf = (resource: keyof Fit) =>
    `${show(allowance.limits[resource] - allowance.remaining[resource])}/${show(allowance.limits[resource])}`
  plan.notes.push(
    `Plan ${allowance.plan}: ${usedOf('workspaces')} workspaces and ${usedOf('environments')} environments used. ` +
      `This migration needs ${fit.workspaces} new workspace(s) and ${fit.environments} new environment(s).`,
  )
  if (fits(fit, allowance)) return { allowance, cache }
  await markBlocked(client, org, plan, allowance, cache)
  plan.suggestions = await suggest(client, org, plan, allowance, cache, opts)
  return { allowance, cache }
}
