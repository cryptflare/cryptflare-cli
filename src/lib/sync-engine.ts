/**
 * Three-way reconcile between one local env file and one remote environment.
 *
 * Split into `planBinding` (pure decision, no writes) and `applyPlan` (effects)
 * so `--dry-run` prints exactly the plan that would have executed rather than a
 * separately-derived approximation of it.
 *
 * ## Push policy: guarded
 *
 * A key is only pushed when it already exists remotely. A key that appears in
 * the local file for the first time is reported and skipped, never created.
 * The service runs unattended for weeks; the cost of a wrong auto-create is a
 * scratch variable landing in a shared vault where every teammate then pulls
 * it, while the cost of skipping is one log line and a manual `cf push` later.
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

import { applyEnvChanges, parseEnvContent, renderEnvFile, toValueMap } from './env-file.js';
import { bindingFilePath, bindingKey, type SyncBinding, type SyncProject } from './sync-registry.js';
import { macMatches, macValue, type BindingState, type SyncState } from './sync-state.js';

export type SyncAction =
  /** Remote version advanced (or the key is new to this file) - write locally. */
  | { type: 'pull'; key: string; remoteVersion: number }
  /** Local value changed and the key exists remotely - rotate a new version. */
  | { type: 'push'; key: string }
  /** Both sides moved since the last pass. Remote wins; local is preserved. */
  | { type: 'conflict'; key: string; remoteVersion: number }
  /** New local key. Guarded policy: reported, never auto-created remotely. */
  | { type: 'skip-new-local'; key: string }
  /** Key removed locally but still remote. Never auto-deletes the secret. */
  | { type: 'skip-local-deleted'; key: string }
  /** Key removed remotely but still local. Never auto-deletes the line. */
  | { type: 'skip-remote-deleted'; key: string }
  /** Multi-line quoted value the writer will not risk rewriting. */
  | { type: 'skip-multiline'; key: string };

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
type Scope = { organisation?: string; workspace: string; environment: string; podId?: string };

function scopeFor(project: SyncProject, binding: SyncBinding): Scope {
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

export function countActionable(plan: BindingPlan): number {
  return plan.actions.filter((a) => a.type === 'pull' || a.type === 'push' || a.type === 'conflict').length;
}

/**
 * Decides what should happen for one binding without touching anything.
 *
 * Costs exactly one `secrets.list` call - remote change detection reads the
 * `version` field the list endpoint already returns, so no value is decrypted
 * until {@link applyPlan} knows which keys actually need pulling.
 */
export async function planBinding(
  client: CryptFlare,
  project: SyncProject,
  binding: SyncBinding,
  state: SyncState,
): Promise<BindingPlan> {
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
        const value = (await client.secrets.reveal({ ...scope, key: secretKey })).value;
        revealed.set(secretKey, value);
        if (value !== localValue) actions.push({ type: 'conflict', key: secretKey, remoteVersion });
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
    else actions.push({ type: 'skip-new-local', key: secretKey });
  }

  return { key, project, binding, filePath, creating, actions, remoteVersions, localValues, revealed };
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
  opts: { push: boolean } = { push: true },
): Promise<ApplyResult> {
  const scope = scopeFor(plan.project, plan.binding);
  const pulls = plan.actions.filter((a): a is Extract<SyncAction, { type: 'pull' }> => a.type === 'pull');
  const conflicts = plan.actions.filter((a): a is Extract<SyncAction, { type: 'conflict' }> => a.type === 'conflict');
  const pushes = opts.push ? plan.actions.filter((a) => a.type === 'push') : [];
  const skipped = plan.actions.filter((a) => a.type.startsWith('skip-'));

  const result: ApplyResult = {
    pulled: [],
    pushed: [],
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
  for (const action of [...pulls, ...conflicts]) {
    // Adoption already revealed some of these while planning; do not pay for
    // the decrypt (or the audit-log entry) twice.
    const cached = plan.revealed.get(action.key);
    const value = cached ?? (await client.secrets.reveal({ ...scope, key: action.key })).value;
    incoming.set(action.key, value);
    result.pulled.push(action.key);
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
  } else if (pushes.length > 1) {
    await client.secrets.batchUpdate({
      ...scope,
      secrets: pushes.map((p) => ({ key: p.key, value: plan.localValues.get(p.key) ?? '' })),
    });
    result.pushed.push(...pushes.map((p) => p.key));
  }
  if (pushes.length > 0) result.changed = true;

  // 5. Re-baseline. The local side is always re-read from disk - the writer
  //    may have skipped a multi-line key, so the file is the authority. The
  //    remote side only needs re-listing when a push bumped versions; a
  //    pull-only or no-op pass can reuse the versions from planning, which
  //    halves the API calls in the steady state. A concurrent remote write
  //    that lands in that window is picked up by the next pass.
  await rebaseline(client, plan, state, scope, { relist: result.pushed.length > 0 });

  return result;
}

async function rebaseline(
  client: CryptFlare,
  plan: BindingPlan,
  state: SyncState,
  scope: Scope,
  opts: { relist: boolean },
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
      keys[k] = { remoteVersion: version, localMac: macValue(state.salt, localValue) };
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
