/**
 * Picks up env files that appear in a repository after it was set up.
 *
 * Setup reads the repository once. A file created later - a new
 * `apps/worker/.dev.vars` in a monorepo, a first `.env.production` - was not
 * synced until someone edited `.cryptflare.json` by hand. This looks again on
 * each pass and binds what is new.
 *
 * ## What it will and will not touch
 *
 * - Only repositories whose manifest says `"autoDiscover": true`. `cf sync
 *   auto` and `cf sync init` write that when they generate a manifest. A
 *   manifest written by hand does not have it and is never edited.
 * - It only appends. A binding that exists is never renamed, removed or
 *   rewritten, whether a person or this tool wrote it.
 * - A file listed under `"ignore"` in the manifest is never bound.
 * - A new file is named by the same rules as the first ones
 *   (`planNewBindings`), and a file that names a stage other than development
 *   gets `capture: off`, so its keys are reported and not uploaded.
 *
 * The environment is created before the binding is written, so a file the
 * plan has no room for is not left bound to something that does not exist.
 */

import { resolve } from 'node:path';

import type { CryptFlare } from '@cryptflare/sdk';

import { collidingFiles, findBindingCollisions } from './binding-collisions.js';
import type { CaptureMode } from './capture.js';
import { findEnvFiles, planNewBindings } from './discover.js';
import { provisionWithinPlan, type PlanAllowance, type PlanResource } from './plan-allowance.js';
import { appendManifestBindings, hasManifest, loadManifest } from './project-manifest.js';
import type { ScopeCache } from './provision.js';
import { bindingFilePath, loadRegistry, saveRegistry, type SyncBinding, type SyncProject, type SyncRegistry } from './sync-registry.js';

/** How long a file that could not be bound is left alone before another try. */
export const REDISCOVER_RETRY_MS = 3_600_000;

export type NewBinding = {
  file: string;
  workspace: string;
  environment: string;
  pod?: string;
  capture?: CaptureMode;
  /** The manifest already lists it (a teammate committed it); only this machine's registry lacks it. */
  inManifest: boolean;
};

/**
 * Env files in a registered repository that are not synced yet.
 *
 * Reads file names and the manifest only, never the contents of an env file,
 * and makes no request.
 *
 * @param registry Used to leave alone a file another registered project already binds.
 */
export function findNewBindings(project: SyncProject, registry: SyncRegistry): NewBinding[] {
  if (!hasManifest(project.path)) return [];
  let manifest;
  try {
    manifest = loadManifest(project.path);
  } catch {
    // Broken mid-edit. Leave it to its author; the next pass looks again.
    return [];
  }
  if (manifest.autoDiscover !== true) return [];

  const claimed = new Set(
    registry.projects.flatMap((other) => other.bindings.map((binding) => bindingFilePath(other, binding))),
  );
  const ignored = new Set(manifest.ignore ?? []);
  const files = findEnvFiles(project.path).filter((file) => !ignored.has(file));
  const unclaimed = (file: string) => !claimed.has(bindingFilePath(project, { file, environment: '' }));

  // Bindings that collide inside the manifest are refused by the sync pass;
  // adding them here would only register something that is never synced.
  const colliding = collidingFiles(findBindingCollisions(manifest.bindings, manifest.workspace));
  const onDisk = new Set(files);

  const found: NewBinding[] = [];
  for (const binding of manifest.bindings) {
    if (!onDisk.has(binding.file) || !unclaimed(binding.file) || colliding.has(binding.file)) continue;
    found.push({
      file: binding.file,
      workspace: binding.workspace!,
      environment: binding.environment!,
      ...(binding.pod ? { pod: binding.pod } : {}),
      ...(binding.capture ? { capture: binding.capture } : {}),
      inManifest: true,
    });
  }

  const workspace = manifest.workspace ?? project.workspace ?? manifest.bindings[0]?.workspace;
  if (!workspace) return found;
  for (const planned of planNewBindings(manifest.bindings, files)) {
    if (!unclaimed(planned.file)) continue;
    found.push({
      file: planned.file,
      workspace,
      environment: planned.environment,
      capture: planned.capture,
      inManifest: false,
    });
  }
  return found;
}

export type RediscoverReport = {
  project: SyncProject;
  /** Files now bound and registered. */
  added: NewBinding[];
  /** Files the plan has no room for. */
  refused: Array<NewBinding & { resource: PlanResource }>;
  /** Files that could not be bound for another reason. */
  failed: Array<NewBinding & { message: string }>;
  allowance: PlanAllowance | null;
};

export type RediscoverOptions = {
  /**
   * Files that could not be bound, and when each may be tried again. Kept by
   * the caller across passes so a plan limit or a missing permission is asked
   * about once an hour, not once a minute.
   */
  retryAt?: Map<string, number>;
  now?: number;
  registryPath?: string;
  scopeCache: ScopeCache;
};

const retryKey = (project: SyncProject, file: string) => `${resolve(project.path)}::${file}`;

/**
 * Binds the new env files of the given projects: creates each environment,
 * appends the binding to the manifest, and registers it for sync.
 *
 * Values are not uploaded here. The sync pass that follows does that, under
 * each binding's capture mode.
 *
 * @returns One report per project that had something new, whatever became of it.
 */
export async function rediscoverProjects(
  client: CryptFlare,
  projects: readonly SyncProject[],
  options: RediscoverOptions,
): Promise<RediscoverReport[]> {
  const now = options.now ?? Date.now();
  const retryAt = options.retryAt ?? new Map<string, number>();
  const reports: RediscoverReport[] = [];
  // One allowance per organisation, counted down across its repositories.
  const allowances = new Map<string, PlanAllowance | null>();

  for (const project of projects) {
    const registry = loadRegistry(options.registryPath);
    const candidates = findNewBindings(project, registry)
      .filter((binding) => (retryAt.get(retryKey(project, binding.file)) ?? 0) <= now);
    if (candidates.length === 0) continue;

    const orgKey = project.org ?? '';
    const outcome = await provisionWithinPlan(client, project.org, candidates, options.scopeCache, {
      ...(allowances.has(orgKey) ? { allowance: allowances.get(orgKey) ?? null } : {}),
    });
    allowances.set(orgKey, outcome.allowance);

    const byFile = new Map(candidates.map((binding) => [binding.file, binding]));
    const report: RediscoverReport = {
      project,
      added: [],
      refused: outcome.refused.map((item) => ({ ...byFile.get(item.file)!, resource: item.resource })),
      failed: outcome.failed.map((item) => ({ ...byFile.get(item.file)!, message: item.message })),
      allowance: outcome.allowance,
    };
    for (const item of [...report.refused, ...report.failed]) {
      retryAt.set(retryKey(project, item.file), now + REDISCOVER_RETRY_MS);
    }

    const ready = outcome.ready.map((item) => byFile.get(item.file)!);
    if (ready.length > 0) {
      try {
        appendManifestBindings(project.path, ready.filter((binding) => !binding.inManifest));

        // Re-read: setup of another repository may have saved since.
        const latest = loadRegistry(options.registryPath);
        const entry = latest.projects.find((candidate) => candidate.id === project.id);
        if (entry) {
          const bound = new Set(entry.bindings.map((binding) => binding.file));
          for (const binding of ready) {
            if (bound.has(binding.file)) continue;
            entry.bindings.push({
              file: binding.file,
              environment: binding.environment,
              ...(binding.pod ? { pod: binding.pod } : {}),
              ...(binding.workspace !== entry.workspace ? { workspace: binding.workspace } : {}),
            } satisfies SyncBinding);
            report.added.push(binding);
          }
          if (report.added.length > 0) saveRegistry(latest, options.registryPath);
        }
      } catch (err) {
        for (const binding of ready) {
          retryAt.set(retryKey(project, binding.file), now + REDISCOVER_RETRY_MS);
          report.failed.push({ ...binding, message: (err as Error).message ?? String(err) });
        }
      }
    }

    reports.push(report);
  }
  return reports;
}
