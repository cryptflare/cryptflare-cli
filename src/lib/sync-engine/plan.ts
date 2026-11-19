/**
 * Three-way reconcile between one local env file and one remote environment.
 *
 * Split into `planBinding` (pure decision, no writes) and `applyPlan` (effects)
 * so `--dry-run` prints exactly the plan that would have executed rather than a
 * separately-derived approximation of it.
 *
 * ## Push policy: guarded, with opt-in capture
 *
 * A changed value is pushed only when its key already exists remotely. What
 * happens to a key that appears in the local file for the first time is the
 * binding's capture mode (see `./capture.ts`):
 *
 * - `off` (default): reported and skipped, never created. The service runs
 *   unattended for weeks; a wrong auto-create is a scratch variable landing
 *   in a shared vault where every teammate then pulls it.
 * - `prompt`: created only when the caller supplies a way to ask and the
 *   answer is yes. Unattended, that is the same as `off`.
 * - `auto`: created. This is what makes "paste the key into .env" the whole
 *   workflow, and it is turned on per binding for the environments where a
 *   new line in the file really does mean a new secret.
 *
 * A new key is validated against the server's rules before anything is sent,
 * so an empty value or a lower-case name is reported, not half-uploaded.
 *
 * Deletion is never propagated in either direction. Removing a line from a
 * local file must not delete an org's secret, and a secret deleted server-side
 * must not silently empty a running dev environment.
 *
 * ## Conflicts
 *
 * When both sides changed a key since the last pass, remote wins and the local
 * value is written to a sidecar `.cf-conflict-<stamp>` file first. Remote wins
 * because it is the shared, audited, recoverable copy - and because the losing
 * side is preserved on disk either way.
 *
 * The first pass over an already-populated file has no merge base, so "changed"
 * is undefined on both sides. Rather than guess, adoption compares the actual
 * values once: identical means adopt silently, different means a real conflict
 * the developer needs to see. Run `cf push` before registering a project whose
 * local file is the authoritative copy.
 */

import { existsSync, readFileSync } from 'node:fs'
import type { CryptFlare } from '@cryptflare/sdk'
import { DEFAULT_CAPTURE_MODE, type CaptureMode } from '@/lib/capture'
import { parseEnvContent, toValueMap } from '@/lib/env-file'
import {
  bindingFilePath,
  bindingKey,
  type SyncBinding,
  type SyncProject,
} from '@/lib/sync-registry'
import { macMatches, macValue, type BindingState, type SyncState } from '@/lib/sync-state'
import { revealSecrets } from '@/lib/reveal'
import { validateSecrets } from '@/lib/secret-validation'

export type SyncAction =
  /** Remote version advanced (or the key is new to this file) - write locally. */
  | { type: 'pull'; key: string; remoteVersion: number }
  /** Local value changed and the key exists remotely - rotate a new version. */
  | { type: 'push'; key: string }
  /** Both sides moved since the last pass. Remote wins; local is preserved. */
  | { type: 'conflict'; key: string; remoteVersion: number }
  /** New local key under capture `auto` - create it remotely. */
  | { type: 'create'; key: string }
  /** New local key under capture `prompt` - create it only if approved. */
  | { type: 'confirm-create'; key: string }
  /** New local key under capture `off`: reported, never created remotely. */
  | { type: 'skip-new-local'; key: string }
  /** New local key the server would reject (empty value, bad name). */
  | { type: 'skip-invalid-local'; key: string; reason: string }
  /** Key removed locally but still remote. Never auto-deletes the secret. */
  | { type: 'skip-local-deleted'; key: string }
  /** Key removed remotely but still local. Never auto-deletes the line. */
  | { type: 'skip-remote-deleted'; key: string }
  /** Multi-line quoted value the writer will not risk rewriting. */
  | { type: 'skip-multiline'; key: string }
  /**
   * First contact on a key that exists on both sides, reported by a planner
   * that was told not to decrypt. Deciding between "already in sync" and
   * "genuinely diverged" needs the remote value, so the answer is deferred to
   * the next real pass rather than bought with a reveal during a dry run.
   */
  | { type: 'needs-compare'; key: string; remoteVersion: number }

export type BindingPlan = {
  key: string
  project: SyncProject
  binding: SyncBinding
  filePath: string
  /** `true` when the env file does not exist yet and will be created. */
  creating: boolean
  actions: SyncAction[]
  /** Remote key -> current version, captured during planning. */
  remoteVersions: Map<string, number>
  /** Local key -> value, captured during planning. */
  localValues: Map<string, string>
  /** Values revealed during first-contact adoption, reused by `applyPlan`. */
  revealed: Map<string, string>
}

export type ApplyResult = {
  pulled: string[]
  pushed: string[]
  /** New local keys created remotely this pass. */
  created: string[]
  /** Keys the server refused to write, with the reason it gave. */
  failed: Array<{ key: string; reason: string }>
  conflicts: string[]
  skipped: SyncAction[]
  /** Path of the sidecar written when conflicts occurred. */
  conflictFile?: string
  changed: boolean
}

/**
 * `podId` is consumed by `secrets.list` (filters the listing) and
 * `secrets.create` (places the new secret). `reveal` and `rotate` address a
 * secret by key alone, which is unambiguous because the server enforces
 * `unique(environment_id, key)` - pods are an organisational folder, not a
 * namespace. Passing it to those calls is harmless; they ignore it.
 */
export type Scope = {
  organisation?: string
  workspace: string
  environment: string
  podId?: string
}

export function scopeFor(project: SyncProject, binding: SyncBinding): Scope {
  // A binding may name its own workspace, which is how one repository maps
  // several apps to several workspaces. The registry guarantees at load time
  // that at least one of the two is set.
  const workspace = binding.workspace ?? project.workspace
  if (!workspace) {
    throw new Error(
      `Binding ${binding.file} has no workspace and project ${project.id} sets no default.`,
    )
  }
  return {
    ...(project.org ? { organisation: project.org } : {}),
    workspace,
    environment: binding.environment,
    ...(binding.pod ? { podId: binding.pod } : {}),
  }
}

const ACTIONABLE: ReadonlySet<SyncAction['type']> = new Set([
  'pull',
  'push',
  'conflict',
  'create',
  'confirm-create',
])

export function countActionable(plan: BindingPlan): number {
  return plan.actions.filter((a) => ACTIONABLE.has(a.type)).length
}

/** Decides what a new local key becomes under the binding's capture mode. */
function planNewLocalKey(key: string, value: string, capture: CaptureMode): SyncAction {
  if (capture === 'off') return { type: 'skip-new-local', key }
  const [problem] = validateSecrets(new Map([[key, value]]))
  if (problem) return { type: 'skip-invalid-local', key, reason: problem.reason }
  return capture === 'auto' ? { type: 'create', key } : { type: 'confirm-create', key }
}

/**
 * Decides what should happen for one binding without touching anything.
 *
 * Change detection reads the `version` field `secrets.list` already returns,
 * so steady-state planning costs one request and decrypts nothing. The one
 * exception is first contact - a key on both sides with no merge base, where
 * only the values can distinguish "already in sync" from "diverged".
 *
 * `reveal: false` suppresses even that, reporting `needs-compare` instead.
 * Reveal is rate limited to 30/min per credential, and a dry run across a
 * dozen freshly registered files exhausted it in one pass - `cf sync status`
 * failed with "Too many requests to reveal-secret" and planned nothing.
 * A read-only command must not spend a budget the real pass needs.
 */
export async function planBinding(
  client: CryptFlare,
  project: SyncProject,
  binding: SyncBinding,
  state: SyncState,
  opts: { reveal?: boolean; capture?: CaptureMode } = {},
): Promise<BindingPlan> {
  const reveal = opts.reveal ?? true
  const capture = opts.capture ?? binding.capture ?? DEFAULT_CAPTURE_MODE
  const filePath = bindingFilePath(project, binding)
  const key = bindingKey(project, binding)
  const scope = scopeFor(project, binding)

  const remoteVersions = new Map<string, number>()
  for await (const secret of await client.secrets.list(scope)) {
    remoteVersions.set(secret.key, secret.version)
  }

  const creating = !existsSync(filePath)
  const parsed = creating ? null : parseEnvContent(readFileSync(filePath, 'utf-8'))
  const localValues = parsed ? toValueMap(parsed) : new Map<string, string>()
  const prior: BindingState | undefined = state.bindings[key]
  const actions: SyncAction[] = []
  const revealed = new Map<string, string>()
  const firstContact: string[] = []

  if (parsed) {
    for (const [entryKey, entry] of parsed.entries) {
      if (entry.multiline) actions.push({ type: 'skip-multiline', key: entryKey })
    }
  }

  const allKeys = new Set([...remoteVersions.keys(), ...localValues.keys()])
  for (const secretKey of [...allKeys].sort()) {
    const remoteVersion = remoteVersions.get(secretKey)
    const localValue = localValues.get(secretKey)
    const priorKey = prior?.keys[secretKey]

    const remoteChanged =
      remoteVersion !== undefined && (!priorKey || priorKey.remoteVersion !== remoteVersion)
    const localChanged =
      localValue !== undefined &&
      (!priorKey || !macMatches(priorKey.localMac, macValue(state.salt, localValue)))

    if (remoteVersion !== undefined && localValue !== undefined) {
      if (!priorKey) {
        // First contact: the key exists on both sides but there is no merge
        // base, so "changed" is undefined for both. Compare the actual values
        // once - equal means adopt silently (the overwhelmingly common case
        // when registering a project whose .env was already pushed), unequal
        // means a genuine unknowable divergence that the caller must see.
        if (!reveal) {
          actions.push({ type: 'needs-compare', key: secretKey, remoteVersion })
          continue
        }
        // Deferred so every first-contact key is fetched in one request
        // rather than one round trip each.
        firstContact.push(secretKey)
        continue
      }
      if (remoteChanged && localChanged)
        actions.push({ type: 'conflict', key: secretKey, remoteVersion })
      else if (remoteChanged) actions.push({ type: 'pull', key: secretKey, remoteVersion })
      else if (localChanged) actions.push({ type: 'push', key: secretKey })
      continue
    }

    if (remoteVersion !== undefined) {
      // Present remotely, absent locally. No prior state means this file has
      // never seen the key, so bring it down. Prior state means the developer
      // deleted the line - leave both sides alone and say so.
      if (priorKey) actions.push({ type: 'skip-local-deleted', key: secretKey })
      else actions.push({ type: 'pull', key: secretKey, remoteVersion })
      continue
    }

    if (priorKey) actions.push({ type: 'skip-remote-deleted', key: secretKey })
    else actions.push(planNewLocalKey(secretKey, localValue ?? '', capture))
  }

  // Adoption comparison, batched. Registering a project whose files were
  // already pushed is the common case, and it used to cost one request per
  // key before anything had even been decided.
  if (firstContact.length > 0) {
    const values = await revealSecrets(client, scope, firstContact)
    for (const secretKey of firstContact) {
      const value = values.get(secretKey)
      // A key listed but not returned vanished between the two calls; leave
      // it for the next pass rather than guessing.
      if (value === undefined) continue
      revealed.set(secretKey, value)
      const remoteVersion = remoteVersions.get(secretKey)
      if (value !== localValues.get(secretKey) && remoteVersion !== undefined) {
        actions.push({ type: 'conflict', key: secretKey, remoteVersion })
      }
    }
  }

  return {
    key,
    project,
    binding,
    filePath,
    creating,
    actions,
    remoteVersions,
    localValues,
    revealed,
  }
}
