/**
 * Applies a {@link MigrationPlan}: creates the workspace and environments,
 * makes sure every value is in CryptFlare, rewrites each file as ciphertext,
 * and records the bindings with `"encrypted": true`.
 *
 * Values go up before any file is rewritten, so a failure leaves the file as
 * it was rather than encrypted for an environment that never got the values.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { CryptFlare } from '@cryptflare/sdk'

import { errorMessage, isRecord } from '@/lib/guards'
import { replaceSpans } from '@/lib/local-env/codec'
import { encryptFile, type EncryptFileResult } from '@/lib/local-env/encrypt-file'
import { writeFileAtomic } from '@/lib/local-env/file-io'
import { Keyring } from '@/lib/local-env/keyring'
import {
  blockers,
  missingIgnores,
  type FilePlan,
  type MigrationPlan,
  type PlanOptions,
} from '@/lib/local-env/migrate-plan'
import { manifestPath, renderManifest, type ManifestBinding } from '@/lib/project-manifest'
import { ensureScope, newScopeCache, seedFromValues, type ScopeCache } from '@/lib/provision'

/** The line `cf env migrate` appends to an encrypted `.envrc`. */
export const DIRENV_HOOK = 'eval "$(cf env decrypt .envrc --format shell)"'

export type FileOutcome =
  | { rel: string; status: 'encrypted'; pushed: number; result: EncryptFileResult }
  | { rel: string; status: 'tokens-moved'; pushed: number; names: string[] }
  | { rel: string; status: 'skipped'; reason: string }
  | { rel: string; status: 'failed'; reason: string }

export type MigrationOutcome = { files: FileOutcome[]; manifest: string | null; ignored: string[] }

function addDirenvHook(path: string): void {
  const content = readFileSync(path, 'utf-8')
  if (content.includes('cf env decrypt')) return
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const sep = content === '' || content.endsWith('\n') ? '' : eol
  writeFileAtomic(
    path,
    `${content}${sep}# Decrypts the cf:v1 values above (CryptFlare)${eol}${DIRENV_HOOK}${eol}`,
  )
}

/** Replaces registry tokens with `${VAR}` references. */
function moveTokens(root: string, file: FilePlan): string[] {
  const path = join(root, file.rel)
  const content = readFileSync(path, 'utf-8')
  const parsed = file.format.parse(content)
  const edits = parsed.entries
    .filter((entry) => !entry.value.startsWith('${'))
    .map((entry) => ({
      start: entry.start,
      end: entry.end,
      text: file.format.render(`\${${file.format.envName(entry)}}`, entry),
      name: file.format.envName(entry),
    }))
  writeFileAtomic(path, replaceSpans(content, edits))
  return edits.map((edit) => edit.name)
}

/** Marks bindings encrypted, adding the new ones; edits the parsed JSON so unknown fields survive. */
function writeBindings(plan: MigrationPlan, org: string | undefined): string | null {
  const bindings = plan.files.filter((file) => file.format.style !== 'registry')
  if (bindings.length === 0) return null
  const path = manifestPath(plan.root)

  if (!existsSync(path)) {
    const manifest = {
      version: 1 as const,
      id: plan.workspace,
      ...(org ? { org } : {}),
      workspace: plan.workspace,
      bindings: bindings.map(
        (file): ManifestBinding => ({
          file: file.rel,
          workspace: file.workspace,
          environment: file.environment,
          encrypted: true,
        }),
      ),
    }
    writeFileSync(path, renderManifest(manifest), 'utf-8')
    return path
  }

  const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'))
  const entries =
    isRecord(raw) && Array.isArray(raw['bindings']) ? (raw['bindings'] as unknown[]) : null
  if (!isRecord(raw) || !entries) throw new Error(`${path}: "bindings" is not an array`)
  for (const file of bindings) {
    const existing = entries.find((entry) => isRecord(entry) && entry['file'] === file.rel)
    if (isRecord(existing)) existing['encrypted'] = true
    else
      entries.push({
        file: file.rel,
        ...(file.workspace !== raw['workspace'] ? { workspace: file.workspace } : {}),
        environment: file.environment,
        encrypted: true,
      })
  }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8')
  renameSync(tmp, path)
  return path
}

function addIgnores(plan: MigrationPlan): string[] {
  const lines = missingIgnores(plan)
  if (lines.length === 0) return []
  const path = join(plan.root, '.gitignore')
  const current = existsSync(path) ? readFileSync(path, 'utf-8') : ''
  const sep = current === '' || current.endsWith('\n') ? '' : '\n'
  appendFileSync(
    path,
    `${sep}# CryptFlare encrypted env files (cf env migrate)\n${lines.join('\n')}\n`,
  )
  return lines
}

async function applyFile(
  client: CryptFlare,
  keyring: Keyring,
  plan: MigrationPlan,
  file: FilePlan,
  ctx: { org: string; cache: ScopeCache; opts: PlanOptions },
): Promise<FileOutcome> {
  const scope = { organisation: ctx.org, workspace: file.workspace, environment: file.environment }
  if (file.format.style === 'registry' && !ctx.opts.moveRegistryTokens) {
    return {
      rel: file.rel,
      status: 'skipped',
      reason: 'registry token: pass --move-registry-tokens to move it',
    }
  }
  await ensureScope(client, scope, ctx.cache)
  const { created, updated } = await seedFromValues(client, scope, file.push)
  if (file.format.style === 'registry') {
    return {
      rel: file.rel,
      status: 'tokens-moved',
      pushed: created + updated,
      names: moveTokens(plan.root, file),
    }
  }
  const target = {
    path: join(plan.root, file.rel),
    rel: file.rel,
    root: plan.root,
    format: file.format,
    scope: { org: ctx.org, workspace: file.workspace, environment: file.environment },
    encryptedBinding: true,
  }
  const result = await encryptFile(target, keyring, ctx.opts)
  if (file.format.id === 'envrc') addDirenvHook(target.path)
  return { rel: file.rel, status: 'encrypted', pushed: created + updated, result }
}

/**
 * Applies the plan. Each file is attempted; failures are collected, not thrown.
 *
 * @param cache The scope cache of the remote check, so the workspaces it listed are not listed again.
 * @throws Before anything changes, when the plan has blockers (conflicting values, no plan room).
 */
export async function applyMigration(
  client: CryptFlare,
  plan: MigrationPlan,
  org: string,
  opts: PlanOptions = {},
  cache: ScopeCache = newScopeCache(),
): Promise<MigrationOutcome> {
  const problems = blockers(plan)
  if (problems.length > 0)
    throw new Error(`Nothing changed. The plan cannot be applied: ${problems.join('; ')}`)
  const keyring = new Keyring(client)
  const ctx = { org, cache, opts }
  const files: FileOutcome[] = []
  for (const file of plan.files) {
    try {
      files.push(await applyFile(client, keyring, plan, file, ctx))
    } catch (err) {
      files.push({ rel: file.rel, status: 'failed', reason: errorMessage(err) })
    }
  }
  const done = new Set(files.filter((f) => f.status === 'encrypted').map((f) => f.rel))
  const manifest = writeBindings(
    { ...plan, files: plan.files.filter((file) => done.has(file.rel)) },
    org,
  )
  return { files, manifest, ignored: addIgnores(plan) }
}
