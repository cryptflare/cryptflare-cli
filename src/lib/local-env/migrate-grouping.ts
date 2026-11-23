/**
 * How `cf env migrate` maps files to environments, and the check that two
 * files sharing one environment do not define one variable differently.
 *
 * Secrets are stored per (environment, key), so two files in one environment
 * share every name. Same name and same value is fine: one secret. Same name
 * and different values would make one file's value silently replace the
 * other's, in CryptFlare and in `cf run`, so it is refused before anything
 * is pushed. Namespacing (rewriting `API_KEY` to `WEB_API_KEY`) was ruled
 * out: the app reads the original name, and the AAD binds it.
 */

import { appOf, stageOf } from '@/lib/discover'

/** `per-file`: one environment per file (the `cf sync init` rules). */
export const GROUPINGS = ['per-file', 'per-app', 'single'] as const

export type Grouping = (typeof GROUPINGS)[number]

/** The environment `--group single` uses when `-e` names none. */
export const SINGLE_DEFAULT_ENVIRONMENT = 'dev'

/** Whether a string is a {@link Grouping}. */
export function isGrouping(value: string): value is Grouping {
  return (GROUPINGS as readonly string[]).includes(value)
}

/**
 * The environment of a file under a grouping other than `per-file`.
 *
 * `per-app` is `<app>-<stage>`: every dev file of `apps/web` shares `web-dev`,
 * while `.env.production` keeps its own `web-production`, so production and
 * development values never share an environment by accident.
 */
export function groupedEnvironment(
  rel: string,
  grouping: Exclude<Grouping, 'per-file'>,
  environment?: string,
): string {
  if (grouping === 'single') return environment ?? SINGLE_DEFAULT_ENVIRONMENT
  const directory = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  return `${appOf(directory)}-${stageOf(name)}`
}

/** What a file contributes to the collision check. */
export type ConflictInput = {
  rel: string
  workspace: string
  environment: string
  push: ReadonlyMap<string, string>
}

export type ValueConflict = {
  /** Variable name. Never a value. */
  name: string
  /** `workspace/environment`. */
  target: string
  /** The files that define it differently, in plan order. */
  files: string[]
}

/** Names defined with different values by two or more files of one environment. */
export function findValueConflicts(files: readonly ConflictInput[]): ValueConflict[] {
  // target -> name -> value -> files
  const byTarget = new Map<string, Map<string, Map<string, string[]>>>()
  for (const file of files) {
    const target = `${file.workspace}/${file.environment}`
    const names = byTarget.get(target) ?? new Map<string, Map<string, string[]>>()
    byTarget.set(target, names)
    for (const [name, value] of file.push) {
      const values = names.get(name) ?? new Map<string, string[]>()
      names.set(name, values)
      values.set(value, [...(values.get(value) ?? []), file.rel])
    }
  }
  const conflicts: ValueConflict[] = []
  for (const [target, names] of byTarget) {
    for (const [name, values] of names) {
      if (values.size < 2) continue
      conflicts.push({ name, target, files: [...new Set([...values.values()].flat())] })
    }
  }
  return conflicts
}

/** One sentence for a conflict: names, files and the way out. Never a value. */
export function describeConflict(conflict: ValueConflict): string {
  return (
    `${conflict.name} has different values in ${conflict.files.join(' and ')}, ` +
    `which would share environment ${conflict.target}. ` +
    'Make the values equal, or give the files their own environments (--group per-file or per-app)'
  )
}
