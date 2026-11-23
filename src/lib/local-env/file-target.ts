/**
 * Works out which environment a local file belongs to, and its format.
 *
 * A file bound in `.cryptflare.json` uses its binding. An unbound file needs
 * `-w` and `-e`: guessing from the nearest binding could encrypt one app's
 * file under another app's key, which only fails later, at decrypt time.
 */

import { dirname, relative, resolve, sep } from 'node:path'

import { getOrg } from '@/lib/config'
import { LOCAL_ENV_ERROR_CODES, LocalEnvError } from '@/lib/local-env/errors'
import { detectFormat, formatById, type FileFormat, type FormatId } from '@/lib/local-env/formats'
import type { KeyScope } from '@/lib/local-env/keyring'
import { findManifestRoot } from '@/lib/project-context'
import { loadManifest } from '@/lib/project-manifest'

export type FileTarget = {
  /** Absolute path. */
  path: string
  /** Path relative to the manifest root (or the cwd when there is none), forward slashes. */
  rel: string
  root: string | null
  format: FileFormat
  scope: KeyScope
  pod?: string
  /** The manifest binding says `"encrypted": true`. */
  encryptedBinding: boolean
}

export type TargetOptions = {
  workspace?: string | undefined
  env?: string | undefined
  org?: string | undefined
  /** `--format <id>`: for a file whose name no format claims. */
  format?: string | undefined
}

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

function pickFormat(rel: string, explicit: string | undefined): FileFormat {
  if (explicit) return formatById(explicit as FormatId)
  const format = detectFormat(rel)
  if (!format) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.UNSUPPORTED,
      `${rel}: no format claims this file name (templates such as .env.example are never encrypted). ` +
        'Pass --format dotenv|toml|json|tfvars to name one.',
    )
  }
  return format
}

/** Resolves one file to its scope and format. */
export function resolveFileTarget(file: string, opts: TargetOptions = {}): FileTarget {
  const path = resolve(file)
  const root = findManifestRoot(dirname(path))
  const rel = toPosix(relative(root ?? process.cwd(), path))
  const format = pickFormat(rel, opts.format)

  const manifest = root ? loadManifest(root) : null
  const binding = manifest?.bindings.find((candidate) => candidate.file === rel)
  const org = opts.org ?? manifest?.org ?? getOrg()
  const workspace = opts.workspace ?? binding?.workspace
  const environment = opts.env ?? binding?.environment

  if (!org || !workspace || !environment) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.NO_SCOPE,
      `${rel}: not bound in .cryptflare.json. Bind it (cf env migrate), or pass -w <workspace> -e <environment>` +
        (org ? '.' : ' and select an organisation (cf org select).'),
    )
  }
  return {
    path,
    rel,
    root,
    format,
    scope: { org, workspace, environment },
    ...(binding?.pod ? { pod: binding.pod } : {}),
    encryptedBinding: binding?.encrypted === true,
  }
}
