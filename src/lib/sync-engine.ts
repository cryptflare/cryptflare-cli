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

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';

import type { CryptFlare } from '@cryptflare/sdk';

import { DEFAULT_CAPTURE_MODE, type CaptureMode } from './capture.js';
import { applyEnvChanges, parseEnvContent, renderEnvFile, toValueMap } from './env-file.js';
import { bindingFilePath, bindingKey, type SyncBinding, type SyncProject } from './sync-registry.js';
import { macMatches, macValue, type BindingState, type SyncState } from './sync-state.js';
import { revealSecrets } from './reveal.js';
import { chunk, validateSecrets } from './secret-validation.js';

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
  | { type: 'needs-compare'; key: string; remoteVersion: number };

export type BindingPlan = {
  key: string;
  project: SyncProject;
  binding: SyncBinding;
  filePath: string;
  /** `true` when the env file does not exist yet and will be created. */
  creating: boolean;
  actions: SyncAction[];
  /** Remote key -> current version, captured during planning. */
  remoteVersions: Map<string, number>;
  /** Local key -> value, captured during planning. */
  localValues: Map<string, string>;
  /** Values revealed during first-contact adoption, reused by `applyPlan`. */
  revealed: Map<string, string>;
};

export type ApplyResult = {
  pulled: string[];
  pushed: string[];
  /** New local keys created remotely this pass. */
  created: string[];
  /** Keys the server refused to write, with the reason it gave. */
  failed: Array<{ key: string; reason: string }>;
  conflicts: string[];
  skipped: SyncAction[];
  /** Path of the sidecar written when conflicts occurred. */
  conflictFile?: string;
  changed: boolean;
};

/**
 * `podId` is consumed by `secrets.list` (filters the listing) and
 * `secrets.create` (places the new secret). `reveal` and `rotate` address a
 * secret by key alone, which is unambiguous because the server enforces
 * `unique(environment_id, key)` - pods are an organisational folder, not a
 * namespace. Passing it to those calls is harmless; they ignore it.
 */
export type Scope = { organisation?: string; workspace: string; environment: string; podId?: string };

export function scopeFor(project: SyncProject, binding: SyncBinding): Scope {
  // A binding may name its own workspace, which is how one repository maps
  // several apps to several workspaces. The registry guarantees at load time
  // that at least one of the two is set.
  const workspace = binding.workspace ?? project.workspace;
  if (!workspace) {
    throw new Error(`Binding ${binding.file} has no workspace and project ${project.id} sets no default.`);
  }
  return {
    ...(project.org ? { organisation: project.org } : {}),
    workspace,
    environment: binding.environment,
    ...(binding.pod ? { podId: binding.pod } : {}),
  };
}

const ACTIONABLE: ReadonlySet<SyncAction['type']> = new Set(['pull', 'push', 'conflict', 'create', 'confirm-create']);

export function countActionable(plan: BindingPlan): number {
  return plan.actions.filter((a) => ACTIONABLE.has(a.type)).length;
}

/** Decides what a new local key becomes under the binding's capture mode. */
function planNewLocalKey(key: string, value: string, capture: CaptureMode): SyncAction {
  if (capture === 'off') return { type: 'skip-new-local', key };
  const [problem] = validateSecrets(new Map([[key, value]]));
  if (problem) return { type: 'skip-invalid-local', key, reason: problem.reason };
  return capture === 'auto' ? { type: 'create', key } : { type: 'confirm-create', key };
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
  const reveal = opts.reveal ?? true;
  const capture = opts.capture ?? binding.capture ?? DEFAULT_CAPTURE_MODE;
  const filePath = bindingFilePath(project, binding);
  const key = bindingKey(project, binding);
  const scope = scopeFor(project, binding);

  const remoteVersions = new Map<string, number>();
  for await (const secret of await client.secrets.list(scope)) {
    remoteVersions.set(secret.key, secret.version);
  }

  const creating = !existsSync(filePath);
  const parsed = creating ? null : parseEnvContent(readFileSync(filePath, 'utf-8'));
  const localValues = parsed ? toValueMap(parsed) : new Map<string, string>();
  const prior: BindingState | undefined = state.bindings[key];
  const actions: SyncAction[] = [];
  const revealed = new Map<string, string>();
  const firstContact: string[] = [];

  if (parsed) {
    for (const [entryKey, entry] of parsed.entries) {
      if (entry.multiline) actions.push({ type: 'skip-multiline', key: entryKey });
    }
  }

  const allKeys = new Set([...remoteVersions.keys(), ...localValues.keys()]);
  for (const secretKey of [...allKeys].sort()) {
    const remoteVersion = remoteVersions.get(secretKey);
    const localValue = localValues.get(secretKey);
    const priorKey = prior?.keys[secretKey];

    const remoteChanged = remoteVersion !== undefined && (!priorKey || priorKey.remoteVersion !== remoteVersion);
    const localChanged =
      localValue !== undefined && (!priorKey || !macMatches(priorKey.localMac, macValue(state.salt, localValue)));

    if (remoteVersion !== undefined && localValue !== undefined) {
      if (!priorKey) {
        // First contact: the key exists on both sides but there is no merge
        // base, so "changed" is undefined for both. Compare the actual values
        // once - equal means adopt silently (the overwhelmingly common case
        // when registering a project whose .env was already pushed), unequal
        // means a genuine unknowable divergence that the caller must see.
        if (!reveal) {
          actions.push({ type: 'needs-compare', key: secretKey, remoteVersion });
          continue;
        }
        // Deferred so every first-contact key is fetched in one request
        // rather than one round trip each.
        firstContact.push(secretKey);
        continue;
      }
      if (remoteChanged && localChanged) actions.push({ type: 'conflict', key: secretKey, remoteVersion });
      else if (remoteChanged) actions.push({ type: 'pull', key: secretKey, remoteVersion });
      else if (localChanged) actions.push({ type: 'push', key: secretKey });
      continue;
    }

    if (remoteVersion !== undefined) {
      // Present remotely, absent locally. No prior state means this file has
      // never seen the key, so bring it down. Prior state means the developer
      // deleted the line - leave both sides alone and say so.
      if (priorKey) actions.push({ type: 'skip-local-deleted', key: secretKey });
      else actions.push({ type: 'pull', key: secretKey, remoteVersion });
      continue;
    }

    if (priorKey) actions.push({ type: 'skip-remote-deleted', key: secretKey });
    else actions.push(planNewLocalKey(secretKey, localValue ?? '', capture));
  }

  // Adoption comparison, batched. Registering a project whose files were
  // already pushed is the common case, and it used to cost one request per
  // key before anything had even been decided.
  if (firstContact.length > 0) {
    const values = await revealSecrets(client, scope, firstContact);
    for (const secretKey of firstContact) {
      const value = values.get(secretKey);
      // A key listed but not returned vanished between the two calls; leave
      // it for the next pass rather than guessing.
      if (value === undefined) continue;
      revealed.set(secretKey, value);
      if (value !== localValues.get(secretKey)) {
        actions.push({ type: 'conflict', key: secretKey, remoteVersion: remoteVersions.get(secretKey)! });
      }
    }
  }

  return { key, project, binding, filePath, creating, actions, remoteVersions, localValues, revealed };
}

export type ApplyOptions = {
  /** `false` pulls only: no rotations and no creations. */
  push: boolean;
  /**
   * Asked which `confirm-create` keys to create. Omitted when nobody is there
   * to ask (the background service), in which case none are created.
   */
  approveCreate?: (keys: string[]) => Promise<string[]>;
};

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
  const scope = scopeFor(plan.project, plan.binding);

  // A `needs-compare` plan came from a planner that was told not to decrypt,
  // so it does not know whether those keys agree. Applying it would rebaseline
  // them as if they did, permanently hiding a real divergence. Refuse rather
  // than record a merge base that was never verified.
  const unresolved = plan.actions.filter((a) => a.type === 'needs-compare');
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot apply a plan built without reveal: ${unresolved.length} key(s) were never compared `
        + `(${unresolved.slice(0, 3).map((a) => a.key).join(', ')}${unresolved.length > 3 ? ', ...' : ''}). `
        + 'Re-plan with reveal enabled.',
    );
  }

  const pulls = plan.actions.filter((a): a is Extract<SyncAction, { type: 'pull' }> => a.type === 'pull');
  const conflicts = plan.actions.filter((a): a is Extract<SyncAction, { type: 'conflict' }> => a.type === 'conflict');
  const pushes = opts.push ? plan.actions.filter((a) => a.type === 'push') : [];
  const skipped = plan.actions.filter((a) => a.type.startsWith('skip-'));
  const creates = opts.push ? await resolveCreates(plan, opts, skipped) : [];

  const result: ApplyResult = {
    pulled: [],
    pushed: [],
    created: [],
    failed: [],
    conflicts: conflicts.map((c) => c.key),
    skipped,
    changed: false,
  };

  // 1. Preserve the losing side of every conflict before anything overwrites it.
  if (conflicts.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictFile = `${plan.filePath}.cf-conflict-${stamp}`;
    const preserved = new Map<string, string>();
    for (const c of conflicts) preserved.set(c.key, plan.localValues.get(c.key) ?? '');
    writeFileSync(
      conflictFile,
      renderEnvFile(preserved, `# Local values that lost a CryptFlare sync conflict at ${new Date().toISOString()}`),
      { encoding: 'utf-8', mode: 0o600 },
    );
    result.conflictFile = conflictFile;
  }

  // 2. Reveal only the keys that actually need to come down.
  const incoming = new Map<string, string>();
  const wanted = [...pulls, ...conflicts].map((a) => a.key);
  // Adoption already revealed some of these while planning; do not pay for
  // the decrypt (or the audit-log entry) twice.
  const needed = wanted.filter((key) => !plan.revealed.has(key));
  const fetched = needed.length > 0
    ? await revealSecrets(client, scope, needed)
    : new Map<string, string>();

  for (const key of wanted) {
    const value = plan.revealed.get(key) ?? fetched.get(key);
    // Absent means the key disappeared between planning and applying. Skip it
    // rather than writing an empty value over a good local one.
    if (value === undefined) continue;
    incoming.set(key, value);
    result.pulled.push(key);
  }

  // 3. Write the local file.
  if (incoming.size > 0 || plan.creating) {
    const updates = new Map<string, string>();
    const additions = new Map<string, string>();
    for (const [k, v] of incoming) {
      if (plan.localValues.has(k)) updates.set(k, v);
      else additions.set(k, v);
    }

    if (plan.creating) {
      writeAtomic(plan.filePath, renderEnvFile(incoming, '# Generated by CryptFlare (cf sync)'));
    } else {
      const original = readFileSync(plan.filePath, 'utf-8');
      const { content } = applyEnvChanges(original, updates, additions);
      if (content !== original) writeAtomic(plan.filePath, content);
    }
    result.changed = incoming.size > 0;
  }

  // 4. Push local edits up. Batched when there is more than one.
  if (pushes.length === 1) {
    const only = pushes[0]!;
    await client.secrets.rotate({ ...scope, key: only.key, value: plan.localValues.get(only.key) ?? '' });
    result.pushed.push(only.key);
  } else {
    for (const batch of chunk(pushes)) {
      const response = await client.secrets.batchUpdate({
        ...scope,
        secrets: batch.map((p) => ({ key: p.key, value: plan.localValues.get(p.key) ?? '' })),
      });
      const outcome = settle(response, batch.map((p) => p.key), 'updated');
      result.pushed.push(...outcome.done);
      result.failed.push(...outcome.failed);
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
    });
    const outcome = settle(response, batch, 'created');
    result.created.push(...outcome.done);
    result.failed.push(...outcome.failed);
  }
  if (result.pushed.length > 0 || result.created.length > 0) result.changed = true;

  // 5. Re-baseline. The local side is always re-read from disk - the writer
  //    may have skipped a multi-line key, so the file is the authority. The
  //    remote side only needs re-listing when a push bumped versions; a
  //    pull-only or no-op pass can reuse the versions from planning, which
  //    halves the API calls in the steady state. A concurrent remote write
  //    that lands in that window is picked up by the next pass.
  await rebaseline(client, plan, state, scope, {
    relist: result.pushed.length > 0 || result.created.length > 0,
    written: new Set(incoming.keys()),
  });

  return result;
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
  const automatic = plan.actions.filter((a) => a.type === 'create').map((a) => a.key);
  const pending = plan.actions.filter((a) => a.type === 'confirm-create').map((a) => a.key);
  if (pending.length === 0) return automatic;

  const approved = new Set(opts.approveCreate ? await opts.approveCreate(pending) : []);
  for (const key of pending) {
    if (!approved.has(key)) skipped.push({ type: 'skip-new-local', key });
  }
  return [...automatic, ...pending.filter((key) => approved.has(key))];
}

type BatchResponse = {
  status?: string;
  results?: Array<{ key: string; status: string; reason?: string; error?: string }> | null;
};

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
  const results = response.results;
  if (!results || results.length === 0) return { done: keys, failed: [] };

  const byKey = new Map(results.map((r) => [r.key, r]));
  const done: string[] = [];
  const failed: Array<{ key: string; reason: string }> = [];
  for (const key of keys) {
    const item = byKey.get(key);
    if (!item || item.status === wanted) {
      done.push(key);
    } else if (item.reason !== 'already_exists') {
      // `already_exists` is a race with another writer, not a failure: the
      // next pass meets the key as first contact and compares the values.
      failed.push({ key, reason: item.error ?? item.reason ?? item.status });
    }
  }
  return { done, failed };
}

async function rebaseline(
  client: CryptFlare,
  plan: BindingPlan,
  state: SyncState,
  scope: Scope,
  opts: { relist: boolean; written: ReadonlySet<string> },
): Promise<void> {
  let finalVersions = plan.remoteVersions;
  if (opts.relist) {
    finalVersions = new Map<string, number>();
    for await (const secret of await client.secrets.list(scope)) {
      finalVersions.set(secret.key, secret.version);
    }
  }
  const finalLocal = existsSync(plan.filePath)
    ? toValueMap(parseEnvContent(readFileSync(plan.filePath, 'utf-8')))
    : new Map<string, string>();

  const prior = state.bindings[plan.key]?.keys ?? {};
  const keys: Record<string, { remoteVersion: number; localMac: string }> = {};

  for (const [k, version] of finalVersions) {
    const localValue = finalLocal.get(k);
    if (localValue !== undefined) {
      // A value that changed on disk while this pass was running was never
      // compared or pushed. Recording it as the baseline would mark an edit
      // nobody uploaded as "in sync" and lose it for good, so the baseline
      // stays on the value this pass actually worked with and the next pass
      // sees the edit. Keys this pass wrote are different: there the file is
      // the authority, since the writer may have declined to rewrite one.
      const planned = plan.localValues.get(k);
      const editedMeanwhile = !opts.written.has(k) && planned !== undefined && planned !== localValue;
      keys[k] = { remoteVersion: version, localMac: macValue(state.salt, editedMeanwhile ? planned : localValue) };
      continue;
    }
    // Remote-only. If we have never baselined this key, leave it absent so the
    // next pass pulls it in. If we HAVE baselined it, the developer deleted the
    // line - carry the prior entry forward as a tombstone. Dropping it here
    // would make the next pass see a brand-new remote key and re-add the line
    // the developer just removed, forever.
    const carried = prior[k];
    if (carried) keys[k] = carried;
  }

  // Local-only keys the previous pass knew about (deleted server-side). Carry
  // them forward too, so the skip stays labelled "remote deleted" instead of
  // degrading into "new local key" on the next pass.
  for (const [k, entry] of Object.entries(prior)) {
    if (!finalVersions.has(k) && finalLocal.has(k)) keys[k] = entry;
  }

  state.bindings[plan.key] = { lastSyncAt: new Date().toISOString(), keys };
}

function writeAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}
