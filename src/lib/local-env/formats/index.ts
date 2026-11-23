/**
 * The format registry. Order matters only where two formats could claim one
 * path; the first match wins. A new format is one module plus one line here.
 */

import {
  composeEnvFormat,
  devVarsFormat,
  dotenvFormat,
  envrcFormat,
} from '@/lib/local-env/formats/env-formats'
import { jsonFormat } from '@/lib/local-env/formats/json'
import { railsMasterKeyFormat } from '@/lib/local-env/formats/rails-master-key'
import { registryAuthFormat } from '@/lib/local-env/formats/registry-auth'
import { tfvarsFormat } from '@/lib/local-env/formats/tfvars'
import { tomlFormat } from '@/lib/local-env/formats/toml'
import type { FileFormat, FormatId } from '@/lib/local-env/formats/types'

export type { FileEntry, FileFormat, FormatId, InjectionMode, ParsedFile } from './types'

export const FORMATS: readonly FileFormat[] = [
  devVarsFormat,
  envrcFormat,
  dotenvFormat,
  tomlFormat,
  jsonFormat,
  tfvarsFormat,
  railsMasterKeyFormat,
  registryAuthFormat,
  composeEnvFormat,
]

/** Committed on purpose with placeholder values, or left behind by a tool. */
const TEMPLATE =
  /\.(example|sample|template|tpl|dist|defaults|hbs)(\.[a-z]+)?$|(^|\/)example\.[^/]*$/i
const LEFTOVER = /(\.cf-conflict-.*|\.cf-restore|\.tmp-\d+|\.bak|\.orig|\.old|\.swp|~)$/i

/** Whether a path is a template (`.env.example`, `secrets.sample.toml`), never encrypted. */
export function isTemplatePath(path: string): boolean {
  return TEMPLATE.test(path)
}

/** Whether a path is a backup, a sidecar or a temporary. */
export function isLeftoverPath(path: string): boolean {
  return LEFTOVER.test(path)
}

/**
 * The format for a path, or `null` when no format claims it.
 *
 * @param referenced Paths a docker-compose or kustomize file names as a
 *   dotenv source; those are read by the tool, so they are materialised.
 */
export function detectFormat(
  path: string,
  referenced: ReadonlySet<string> = new Set(),
): FileFormat | null {
  const normal = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isTemplatePath(normal) || isLeftoverPath(normal)) return null
  if (referenced.has(normal)) return composeEnvFormat
  return FORMATS.find((format) => format.matches(normal)) ?? null
}

export function formatById(id: FormatId): FileFormat {
  const format = FORMATS.find((candidate) => candidate.id === id)
  if (!format) throw new Error(`Unknown format ${id}`)
  return format
}

/** Formats the sync engine may read and write as dotenv. */
export function isSyncableFormat(format: FileFormat | null): boolean {
  return format === null || format.style === 'env'
}
