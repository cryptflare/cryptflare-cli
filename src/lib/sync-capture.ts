/**
 * Works out the capture mode in force for a binding at sync time.
 *
 * The registry is a per-machine copy of the committed manifest, taken when
 * `cf sync init` ran. Reading capture only from the registry would mean
 * editing `.cryptflare.json` changed nothing until every machine re-ran
 * `init`. So the manifest is consulted on each pass, and the registry value
 * exists as a deliberate local override - "this repo says auto, but not on
 * this machine".
 */

import { DEFAULT_CAPTURE_MODE, type CaptureMode } from './capture.js';
import { hasManifest, loadManifest } from './project-manifest.js';
import type { SyncBinding, SyncProject } from './sync-registry.js';

/** Capture mode per bound file, as the project's committed manifest states it. */
export type ManifestCapture = ReadonlyMap<string, CaptureMode>;

/**
 * Reads the capture modes from a project's manifest.
 *
 * A missing or unreadable manifest yields no modes rather than an error: a
 * project registered by hand has none, and a manifest broken mid-edit must
 * not stop the files it describes from syncing.
 */
export function loadManifestCapture(project: Pick<SyncProject, 'path'>): ManifestCapture {
  const modes = new Map<string, CaptureMode>();
  if (!hasManifest(project.path)) return modes;
  try {
    for (const binding of loadManifest(project.path).bindings) {
      if (binding.capture) modes.set(binding.file, binding.capture);
    }
  } catch {
    return new Map();
  }
  return modes;
}

/** Registry override first, then the manifest, then the default (`off`). */
export function resolveCapture(binding: SyncBinding, manifestCapture: ManifestCapture): CaptureMode {
  return binding.capture ?? manifestCapture.get(binding.file) ?? DEFAULT_CAPTURE_MODE;
}
