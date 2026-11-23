/** Applies a `BindingPlan`: pulls, guarded pushes, batched creates, then rebaselines the merge state. */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import type { CryptFlare } from '@cryptflare/sdk'
import { applyEnvChanges, parseEnvContent, renderEnvFile, toValueMap } from '@/lib/env-file'
import { decryptValues, encryptValues } from '@/lib/local-env/sync-codec'
import { macValue, type SyncState } from '@/lib/sync-state'
import { revealSecrets } from '@/lib/reveal'
import { chunk } from '@/lib/secret-validation'
import { scopeFor } from '@/lib/sync-engine/plan'
import type { ApplyResult, BindingPlan, Scope, SyncAction } from '@/lib/sync-engine/plan'

export type ApplyOptions = {
  /** `false` pulls only: no rotations and no creations. */
  push: boolean
  /**
   * Asked which `confirm-create` keys to create. Omitted when nobody is there
   * to ask (the background service), in which case none are created.
   */
  approveCreate?: (keys: string[]) => Promise<string[]>
}

/**
 * Executes a plan and rewrites the merge base.
 *
 * Order matters: the local file is written before secrets are pushed, so a
 * crash mid-pass leaves the developer's environment correct and the push
 * simply retried next pass. State is only committed after both halves land -
 * a partial pass re-plans from the previous baseline rather than recording
 * work it did not finish.
 */
export async function applyPlan(
  client: CryptFlare,
  plan: BindingPlan,
  state: SyncState,
  opts: ApplyOptions = { push: true },
): Promise<ApplyResult> {
  const scope = scopeFor(plan.project, plan.binding)

  if (plan.unsupportedFormat) {
    return {
      pulled: [],
      pushed: [],
      created: [],
      failed: [],
      conflicts: [],
      skipped: [],
      changed: false,
    }
  }

  // A `needs-compare` plan came from a planner that was told not to decrypt,
  // so it does not know whether those keys agree. Applying it would rebaseline
  // them as if they did, permanently hiding a real divergence. Refuse rather
  // than record a merge base that was never verified.
  const unresolved = plan.actions.filter((a) => a.type === 'needs-compare')
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot apply a plan built without reveal: ${unresolved.length} key(s) were never compared ` +
        `(${unresolved
          .slice(0, 3)
          .map((a) => a.key)
          .join(', ')}${unresolved.length > 3 ? ', ...' : ''}). ` +
        'Re-plan with reveal enabled.',
    )
  }

  const pulls = plan.actions.filter(
    (a): a is Extract<SyncAction, { type: 'pull' }> => a.type === 'pull',
  )
  const conflicts = plan.actions.filter(
    (a): a is Extract<SyncAction, { type: 'conflict' }> => a.type === 'conflict',
  )
  const pushes = opts.push ? plan.actions.filter((a) => a.type === 'push') : []
  const skipped = plan.actions.filter((a) => a.type.startsWith('skip-'))
  const creates = opts.push ? await resolveCreates(plan, opts, skipped) : []

  const result: ApplyResult = {
    pulled: [],
    pushed: [],
    created: [],
    failed: [],
    conflicts: conflicts.map((c) => c.key),
    skipped,
    changed: false,
  }

  // 1. Preserve the losing side of every conflict before anything overwrites it.
  if (conflicts.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const conflictFile = `${plan.filePath}.cf-conflict-${stamp}`
    const preserved = new Map<string, string>()
    for (const c of conflicts) preserved.set(c.key, plan.localValues.get(c.key) ?? '')
    writeFileSync(
      conflictFile,
      renderEnvFile(
        plan.encrypted
          ? await encryptValues(client, scope, preserved, plan.fileValues ?? new Map())
          : preserved,
        `# Local values that lost a CryptFlare sync conflict at ${new Date().toISOString()}`,
      ),
      { encoding: 'utf-8', mode: 0o600 },
    )
    result.conflictFile = conflictFile
  }

  // 2. Reveal only the keys that actually need to come down.
  const incoming = new Map<string, string>()
  const wanted = [...pulls, ...conflicts].map((a) => a.key)
  // Adoption already revealed some of these while planning; do not pay for
  // the decrypt (or the audit-log entry) twice.
  const needed = wanted.filter((key) => !plan.revealed.has(key))
  const fetched =
    needed.length > 0 ? await revealSecrets(client, scope, needed) : new Map<string, string>()

  for (const key of wanted) {
    const value = plan.revealed.get(key) ?? fetched.get(key)
    // Absent means the key disappeared between planning and applying. Skip it
    // rather than writing an empty value over a good local one.
    if (value === undefined) continue
    incoming.set(key, value)
    result.pulled.push(key)
  }

  // 3. Write the local file.
  if (incoming.size > 0 || plan.creating) {
    const updates = new Map<string, string>()
    const additions = new Map<string, string>()
    // Encrypted mode: what is written is ciphertext; the values stay plaintext in memory.
    const written = plan.encrypted
      ? await encryptValues(client, scope, incoming, plan.fileValues ?? new Map())
      : incoming
    for (const [k, v] of written) {
      if (plan.localValues.has(k)) updates.set(k, v)
      else additions.set(k, v)
    }

    if (plan.creating) {
      writeAtomic(plan.filePath, renderEnvFile(written, '# Generated by CryptFlare (cf sync)'))
    } else {
      const original = readFileSync(plan.filePath, 'utf-8')
      const { content } = applyEnvChanges(original, updates, additions)
      if (content !== original) writeAtomic(plan.filePath, content)
    }
    result.changed = incoming.size > 0
  }

  // 4. Push local edits up. Batched when there is more than one.
  const only = pushes.length === 1 ? pushes[0] : undefined
  if (only) {
    await client.secrets.rotate({
      ...scope,
      key: only.key,
      value: plan.localValues.get(only.key) ?? '',
    })
    result.pushed.push(only.key)
  } else {
    for (const batch of chunk(pushes)) {
      const response = await client.secrets.batchUpdate({
        ...scope,
        secrets: batch.map((p) => ({ key: p.key, value: plan.localValues.get(p.key) ?? '' })),
      })
      const outcome = settle(
        response,
        batch.map((p) => p.key),
        'updated',
      )
      result.pushed.push(...outcome.done)
      result.failed.push(...outcome.failed)
    }
  }

  // 4b. Create the new local keys capture allowed.
  for (const batch of chunk(creates)) {
    const response = await client.secrets.batchCreate({
      ...scope,
      secrets: batch.map((key) => ({
        key,
        value: plan.localValues.get(key) ?? '',
        ...(scope.podId ? { podId: scope.podId } : {}),
      })),
    })
    const outcome = settle(response, batch, 'created')
    result.created.push(...outcome.done)
    result.failed.push(...outcome.failed)
  }
  if (result.pushed.length > 0 || result.created.length > 0) result.changed = true

  // 5. Re-baseline. The local side is always re-read from disk - the writer
  //    may have skipped a multi-line key, so the file is the authority. The
  //    remote side only needs re-listing when a push bumped versions; a
  //    pull-only or no-op pass can reuse the versions from planning, which
  //    halves the API calls in the steady state. A concurrent remote write
  //    that lands in that window is picked up by the next pass.
  await rebaseline(client, plan, state, scope, {
    relist: result.pushed.length > 0 || result.created.length > 0,
    written: new Set(incoming.keys()),
  })

  return result
}

/**
 * Which new local keys to create: every `create`, plus the `confirm-create`
 * keys the caller approved. Unapproved ones are reported as skipped, so the
 * log says why a key the developer just typed did not go anywhere.
 */
async function resolveCreates(
  plan: BindingPlan,
  opts: ApplyOptions,
  skipped: SyncAction[],
): Promise<string[]> {
  const automatic = plan.actions.filter((a) => a.type === 'create').map((a) => a.key)
  const pending = plan.actions.filter((a) => a.type === 'confirm-create').map((a) => a.key)
  if (pending.length === 0) return automatic

  const approved = new Set(opts.approveCreate ? await opts.approveCreate(pending) : [])
  for (const key of pending) {
    if (!approved.has(key)) skipped.push({ type: 'skip-new-local', key })
  }
  return [...automatic, ...pending.filter((key) => approved.has(key))]
}

type BatchResponse = {
  status?: string
  results?: Array<{
    key: string
    status: string
    reason?: string | undefined
    error?: string | undefined
  }> | null
}

/**
 * Splits a batch response into the keys that were written and the ones that
 * were not.
 *
 * An API that predates synchronous batches answers with a queued job and no
 * per-item results. There is nothing to inspect, so every key is taken as
 * written - which is what the engine always assumed against those servers.
 * The re-list that follows is what actually establishes the new baseline.
 */
function settle(
  response: BatchResponse,
  keys: string[],
  wanted: 'created' | 'updated',
): { done: string[]; failed: Array<{ key: string; reason: string }> } {
  const results = response.results
  if (!results || results.length === 0) return { done: keys, failed: [] }

  const byKey = new Map(results.map((r) => [r.key, r]))
  const done: string[] = []
  const failed: Array<{ key: string; reason: string }> = []
  for (const key of keys) {
    const item = byKey.get(key)
    if (!item || item.status === wanted) {
      done.push(key)
    } else if (item.reason !== 'already_exists') {
      // `already_exists` is a race with another writer, not a failure: the
      // next pass meets the key as first contact and compares the values.
      failed.push({ key, reason: item.error ?? item.reason ?? item.status })
    }
  }
  return { done, failed }
}

async function rebaseline(
  client: CryptFlare,
  plan: BindingPlan,
  state: SyncState,
  scope: Scope,
  opts: { relist: boolean; written: ReadonlySet<string> },
): Promise<void> {
  let finalVersions = plan.remoteVersions
  if (opts.relist) {
    finalVersions = new Map<string, number>()
    for await (const secret of await client.secrets.list(scope)) {
      finalVersions.set(secret.key, secret.version)
    }
  }
  const onDisk = existsSync(plan.filePath)
    ? toValueMap(parseEnvContent(readFileSync(plan.filePath, 'utf-8')))
    : new Map<string, string>()
  // The merge base is kept on plaintext (as a MAC), so an encrypted file is
  // decrypted before it is compared: fresh ciphertext is not a local edit.
  const finalLocal = plan.encrypted ? await decryptValues(client, scope, onDisk) : onDisk

  const prior = state.bindings[plan.key]?.keys ?? {}
  const keys: Record<string, { remoteVersion: number; localMac: string }> = {}

  for (const [k, version] of finalVersions) {
    const localValue = finalLocal.get(k)
    if (localValue !== undefined) {
      // A value that changed on disk while this pass was running was never
      // compared or pushed. Recording it as the baseline would mark an edit
      // nobody uploaded as "in sync" and lose it for good, so the baseline
      // stays on the value this pass actually worked with and the next pass
      // sees the edit. Keys this pass wrote are different: there the file is
      // the authority, since the writer may have declined to rewrite one.
      const planned = plan.localValues.get(k)
      const editedMeanwhile =
        !opts.written.has(k) && planned !== undefined && planned !== localValue
      keys[k] = {
        remoteVersion: version,
        localMac: macValue(state.salt, editedMeanwhile ? planned : localValue),
      }
      continue
    }
    // Remote-only. If we have never baselined this key, leave it absent so the
    // next pass pulls it in. If we HAVE baselined it, the developer deleted the
    // line - carry the prior entry forward as a tombstone. Dropping it here
    // would make the next pass see a brand-new remote key and re-add the line
    // the developer just removed, forever.
    const carried = prior[k]
    if (carried) keys[k] = carried
  }

  // Local-only keys the previous pass knew about (deleted server-side). Carry
  // them forward too, so the skip stays labelled "remote deleted" instead of
  // degrading into "new local key" on the next pass.
  for (const [k, entry] of Object.entries(prior)) {
    if (!finalVersions.has(k) && finalLocal.has(k)) keys[k] = entry
  }

  state.bindings[plan.key] = { lastSyncAt: new Date().toISOString(), keys }
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, path)
}
