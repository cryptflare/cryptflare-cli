/**
 * What `cf run` needs from the encrypted local files of a project: the
 * values to inject, the files to materialise, and the wrangler files.
 *
 * Only files that hold at least one `cf:v1` value take part, so a project
 * with plaintext env files runs exactly as it did before.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { decryptContent, keyRefsIn } from '@/lib/local-env/codec'
import { LocalEnvError } from '@/lib/local-env/errors'
import { resolveFileTarget, type FileTarget } from '@/lib/local-env/file-target'
import { dotenvFormat } from '@/lib/local-env/formats/env-formats'
import { detectFormat } from '@/lib/local-env/formats'
import type { Keyring, KeyScope } from '@/lib/local-env/keyring'
import { restoreLeftovers, type MaterializeTarget } from '@/lib/local-env/materialize'
import { findManifestRoot } from '@/lib/project-context'
import { loadManifest } from '@/lib/project-manifest'

export type RunScope = { org: string; workspace: string; env: string; pod?: string }

export type LocalFilesPlan = {
  /** Decrypted (and plaintext) values of env-style files, by variable name. */
  env: Record<string, string>
  /** Files the tool reads itself, ready for `--materialize`. */
  materialize: Array<MaterializeTarget & { rel: string }>
  /** Bound `.dev.vars*` files that hold ciphertext, for the wrangler adapter. */
  devVars: Array<MaterializeTarget & { rel: string }>
  /** Files restored from a `.cf-restore` sidecar left by an earlier run. */
  restored: string[]
}

function isUnder(dir: string, cwd: string): boolean {
  const rel = relative(dir, cwd)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep))
}

/**
 * Bound files of the run's scope that enclose the cwd or sit below it.
 * Below counts because files of one environment belong to one app, and an
 * app keeps some in subfolders (`.streamlit/secrets.toml`, `config/master.key`).
 */
function boundFiles(cwd: string, scope: RunScope): FileTarget[] {
  const root = findManifestRoot(cwd)
  if (!root) return []
  const manifest = loadManifest(root)
  const org = manifest.org ?? scope.org
  return manifest.bindings
    .filter((b) => b.workspace === scope.workspace && b.environment === scope.env)
    .filter((b) => (b.pod ?? undefined) === scope.pod)
    .filter((b) => {
      const dir = dirname(join(root, b.file))
      return isUnder(dir, resolve(cwd)) || isUnder(resolve(cwd), dir)
    })
    .map((b) => ({
      path: join(root, b.file),
      rel: b.file,
      root,
      // Bound files with a name no format claims were bound by `cf sync` as dotenv.
      format: detectFormat(b.file) ?? dotenvFormat,
      scope: { org, workspace: b.workspace, environment: b.environment },
      ...(b.pod ? { pod: b.pod } : {}),
      encryptedBinding: b.encrypted === true,
    }))
}

function explicitFiles(files: readonly string[], scope: RunScope): FileTarget[] {
  return files.map((file) =>
    resolveFileTarget(file, { org: scope.org, workspace: scope.workspace, env: scope.env }),
  )
}

/**
 * Reads, and decrypts in memory, the encrypted files `cf run` should use.
 *
 * @param files `--file` paths. When empty, the bound files of `scope` around `cwd`.
 * @throws LocalEnvError or an API error when a key cannot be fetched or a
 *   value does not decrypt. Nothing partial is returned: the run must not
 *   start with half its configuration.
 */
export async function loadLocalFiles(args: {
  cwd: string
  scope: RunScope
  files: readonly string[]
  keyring: Keyring
}): Promise<LocalFilesPlan> {
  const targets =
    args.files.length > 0 ? explicitFiles(args.files, args.scope) : boundFiles(args.cwd, args.scope)
  const plan: LocalFilesPlan = { env: {}, materialize: [], devVars: [], restored: [] }
  plan.restored = restoreLeftovers(targets.map((t) => t.path))

  for (const target of targets) {
    if (!existsSync(target.path)) continue
    const content = readFileSync(target.path, 'utf-8')
    const refs = keyRefsIn(target.format.parse(content))
    if (refs.size === 0) continue

    const scope: KeyScope = target.scope
    let keys
    try {
      keys = await args.keyring.forRefs(scope, refs)
    } catch (err) {
      if (err instanceof LocalEnvError) {
        throw new LocalEnvError(err.code, `${target.rel}: ${err.message}`, { cause: err })
      }
      throw err
    }
    const decrypted = decryptContent(content, target.format, keys)

    const copy = {
      path: target.path,
      rel: target.rel,
      original: content,
      plaintext: decrypted.plaintext,
    }
    if (target.format.injection === 'materialize') {
      plan.materialize.push(copy)
      continue
    }
    if (target.format.injection === 'env')
      Object.assign(plan.env, Object.fromEntries(decrypted.values))
    if (target.format.id === 'dev-vars') plan.devVars.push(copy)
  }
  return plan
}
