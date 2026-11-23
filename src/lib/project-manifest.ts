/**
 * `.cryptflare.json` - the committed, per-repository sync manifest.
 *
 * The sync registry (`~/.config/cryptflare-nodejs/sync.json`) is machine-local, so the
 * knowledge of which file maps to which workspace lived only on the machine
 * where it was set up. A fresh clone - a new laptop, or a new teammate - had no
 * way to discover it, and setting up a six-app monorepo meant thirteen commands
 * and remembering six workspace slugs.
 *
 * This manifest is committed alongside the code so the mapping travels with the
 * repository:
 *
 *   git clone …
 *   cf sync init          # reads .cryptflare.json, pulls every file, registers
 *
 * ## It contains no secrets
 *
 * Only names: file paths, workspace slugs, environment slugs, pod slugs. That
 * is why it is safe to commit, and why it must never grow a field that holds a
 * value. The files it points AT hold the secrets and stay gitignored.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { readCaptureMode, type CaptureMode } from '@/lib/capture'
import { errorMessage, isRecord, isStringArray } from '@/lib/guards'

/** Conventional filename at the repository root. */
export const MANIFEST_FILENAME = '.cryptflare.json'

export type ManifestBinding = {
  /** Path to the env-shaped file, relative to the manifest's directory. */
  file: string
  /** Workspace slug. Falls back to the manifest-level `workspace`. */
  workspace?: string
  /** Environment slug. Falls back to the manifest-level `environment`. */
  environment?: string
  /** Optional pod (secret folder) within the environment. */
  pod?: string
  /**
   * What to do with a new local key. Falls back to the manifest-level
   * `capture`, then to `off`. See `./capture.ts`.
   */
  capture?: CaptureMode
  /**
   * The file holds `cf:v1` ciphertext instead of plaintext. `cf sync` then
   * encrypts what it writes, and `cf run` decrypts it in memory. See
   * `docs/guides/encrypted-env-files.md`.
   */
  encrypted?: boolean
}

export type ProjectManifest = {
  version: 1
  /** Project id used when registering. Defaults to the directory name. */
  id?: string
  /** Organisation ID. Falls back to the CLI default. */
  org?: string
  /** Default workspace for bindings that do not name one. */
  workspace?: string
  /** Default environment for bindings that do not name one. */
  environment?: string
  /** Default capture policy for bindings that do not set their own. */
  capture?: CaptureMode
  /**
   * Opt-in to having bindings added automatically.
   *
   * `true` means the sync service may append a binding when a new env file
   * appears in the repository (a new `apps/worker/.dev.vars`, a new
   * `.env.production`). It only ever appends: an existing binding is never
   * renamed, removed or rewritten, whoever wrote it.
   *
   * It is written by `cf sync auto` and by `cf sync init` when they generate
   * the manifest. A manifest written by hand does not have it, and absence
   * means "this file is mine, do not edit it": nothing is ever added. Set it
   * to `true` to opt a hand-written manifest in, or remove it (or set
   * `false`) to take a generated one back under manual control.
   */
  autoDiscover?: boolean
  /**
   * Env files that must never be bound automatically, as paths relative to
   * the manifest. Only read when `autoDiscover` is on. This is how to say
   * "leave this one file alone" without turning discovery off for the rest.
   */
  ignore?: string[]
  bindings: ManifestBinding[]
}

/** A binding after parsing: the manifest-level defaults are filled in. */
export type ResolvedManifestBinding = ManifestBinding & { workspace: string; environment: string }

/** A parsed manifest. Every binding names its workspace and environment. */
export type LoadedManifest = Omit<ProjectManifest, 'bindings'> & {
  bindings: ResolvedManifestBinding[]
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManifestError'
  }
}

const MANIFEST_VERSION = 1

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_FILENAME)
}

export function hasManifest(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot))
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestError(`${path} must be a non-empty string when present`)
  }
  return value
}

function readCapture(value: unknown, path: string): CaptureMode | undefined {
  try {
    return readCaptureMode(value, path)
  } catch (err) {
    throw new ManifestError(errorMessage(err))
  }
}

export function parseManifest(raw: unknown): LoadedManifest {
  if (!isRecord(raw)) {
    throw new ManifestError(`${MANIFEST_FILENAME} must contain a JSON object`)
  }
  const obj = raw

  if (obj['version'] !== MANIFEST_VERSION) {
    throw new ManifestError(
      `unsupported version ${JSON.stringify(obj['version'])}; expected ${MANIFEST_VERSION}`,
    )
  }

  const bindingsRaw = obj['bindings']
  if (!Array.isArray(bindingsRaw) || bindingsRaw.length === 0) {
    throw new ManifestError('"bindings" must be a non-empty array')
  }

  const defaultWorkspace = optionalString(obj['workspace'], 'workspace')
  const defaultEnvironment = optionalString(obj['environment'], 'environment')
  const defaultCapture = readCapture(obj['capture'], 'capture')

  const bindings = bindingsRaw.map((entry, i) => {
    const at = `bindings[${i}]`
    if (!isRecord(entry)) {
      throw new ManifestError(`${at} must be an object`)
    }
    const b = entry

    const file = optionalString(b['file'], `${at}.file`)
    if (!file) throw new ManifestError(`${at}.file is required`)
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      // The manifest is committed, so a malicious or careless entry would
      // otherwise let `cf sync init` write outside the repository on every
      // machine that clones it.
      throw new ManifestError(
        `${at}.file must be a relative path inside the project (got "${file}")`,
      )
    }

    const workspace = optionalString(b['workspace'], `${at}.workspace`) ?? defaultWorkspace
    if (!workspace) {
      throw new ManifestError(`${at} has no workspace and no top-level "workspace" default is set`)
    }
    const environment = optionalString(b['environment'], `${at}.environment`) ?? defaultEnvironment
    if (!environment) {
      throw new ManifestError(
        `${at} has no environment and no top-level "environment" default is set`,
      )
    }

    const pod = optionalString(b['pod'], `${at}.pod`)
    const capture = readCapture(b['capture'], `${at}.capture`) ?? defaultCapture
    const encrypted = b['encrypted']
    if (encrypted !== undefined && typeof encrypted !== 'boolean') {
      throw new ManifestError(`${at}.encrypted must be true or false when present`)
    }
    return {
      file,
      workspace,
      environment,
      ...(pod ? { pod } : {}),
      ...(capture ? { capture } : {}),
      ...(encrypted ? { encrypted } : {}),
    }
  })

  const autoDiscover = obj['autoDiscover']
  if (autoDiscover !== undefined && typeof autoDiscover !== 'boolean') {
    throw new ManifestError('"autoDiscover" must be true or false when present')
  }
  const ignoreRaw = obj['ignore']
  if (
    ignoreRaw !== undefined &&
    (!isStringArray(ignoreRaw) || ignoreRaw.some((entry) => entry.trim() === ''))
  ) {
    throw new ManifestError('"ignore" must be an array of file paths when present')
  }
  const ignore = ignoreRaw ?? []
  const id = optionalString(obj['id'], 'id')
  const org = optionalString(obj['org'], 'org')

  const seen = new Set<string>()
  for (const b of bindings) {
    if (seen.has(b.file)) {
      // Two bindings for one file means two environments racing to own the
      // same bytes on every sync pass.
      throw new ManifestError(`"${b.file}" is bound more than once`)
    }
    seen.add(b.file)
  }

  return {
    version: MANIFEST_VERSION,
    ...(id ? { id } : {}),
    ...(org ? { org } : {}),
    ...(defaultWorkspace ? { workspace: defaultWorkspace } : {}),
    ...(defaultEnvironment ? { environment: defaultEnvironment } : {}),
    ...(defaultCapture ? { capture: defaultCapture } : {}),
    ...(autoDiscover !== undefined ? { autoDiscover } : {}),
    ...(ignore.length > 0 ? { ignore } : {}),
    bindings,
  }
}

export function loadManifest(projectRoot: string): LoadedManifest {
  const path = manifestPath(projectRoot)
  if (!existsSync(path)) {
    throw new ManifestError(
      `No ${MANIFEST_FILENAME} in ${projectRoot}. Create one with \`cf sync init --write\`.`,
    )
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    throw new ManifestError(`${path} is not valid JSON: ${errorMessage(err)}`)
  }
  try {
    return parseManifest(raw)
  } catch (err) {
    throw new ManifestError(`${path}: ${errorMessage(err)}`)
  }
}

/**
 * Serialises a manifest for committing. Bindings keep only the fields that
 * differ from the defaults, so a single-workspace project stays terse.
 */
export function renderManifest(manifest: ProjectManifest): string {
  const out: Record<string, unknown> = { version: MANIFEST_VERSION }
  if (manifest.id) out['id'] = manifest.id
  if (manifest.org) out['org'] = manifest.org
  if (manifest.workspace) out['workspace'] = manifest.workspace
  if (manifest.environment) out['environment'] = manifest.environment
  if (manifest.capture) out['capture'] = manifest.capture
  if (manifest.autoDiscover !== undefined) out['autoDiscover'] = manifest.autoDiscover
  if (manifest.ignore && manifest.ignore.length > 0) out['ignore'] = manifest.ignore

  out['bindings'] = manifest.bindings.map((b) => ({
    file: b.file,
    ...(b.workspace && b.workspace !== manifest.workspace ? { workspace: b.workspace } : {}),
    ...(b.environment && b.environment !== manifest.environment
      ? { environment: b.environment }
      : {}),
    ...(b.pod ? { pod: b.pod } : {}),
    ...(b.capture && b.capture !== manifest.capture ? { capture: b.capture } : {}),
    ...(b.encrypted ? { encrypted: true } : {}),
  }))

  return `${JSON.stringify(out, null, 2)}\n`
}

export function writeManifest(projectRoot: string, manifest: ProjectManifest): string {
  const path = manifestPath(projectRoot)
  writeFileSync(path, renderManifest(manifest), 'utf-8')
  return path
}

/**
 * Appends bindings to a manifest on disk, leaving everything already in it
 * exactly as it was.
 *
 * It edits the parsed JSON rather than re-rendering the manifest: rendering
 * would drop fields this version does not know and rewrite bindings a person
 * edited. Here the existing entries are passed through untouched and only new
 * ones are added at the end.
 *
 * Refuses (returns `[]`) unless the manifest opts in with `autoDiscover`, and
 * skips any file that is already bound.
 *
 * @returns The bindings that were actually written.
 */
export function appendManifestBindings(
  projectRoot: string,
  additions: readonly ManifestBinding[],
): ManifestBinding[] {
  if (additions.length === 0) return []
  const path = manifestPath(projectRoot)
  const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  // Validates the file as it is now, so a manifest broken mid-edit is not
  // written over.
  const manifest = parseManifest(raw)
  const entries = isRecord(raw) ? raw['bindings'] : undefined
  if (!Array.isArray(entries)) return []
  if (manifest.autoDiscover !== true) return []

  const bound = new Set(manifest.bindings.map((binding) => binding.file))
  const fresh = additions.filter((binding) => !bound.has(binding.file))
  if (fresh.length === 0) return []

  for (const binding of fresh) {
    entries.push({
      file: binding.file,
      ...(binding.workspace && binding.workspace !== manifest.workspace
        ? { workspace: binding.workspace }
        : {}),
      ...(binding.environment && binding.environment !== manifest.environment
        ? { environment: binding.environment }
        : {}),
      ...(binding.pod ? { pod: binding.pod } : {}),
      ...(binding.capture && binding.capture !== manifest.capture
        ? { capture: binding.capture }
        : {}),
    })
  }

  // Renamed into place so an editor or another `cf` never reads half a file.
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
  return fresh
}
