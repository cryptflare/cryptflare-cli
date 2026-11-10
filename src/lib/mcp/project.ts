/**
 * Finds the sync project a local tool call is about.
 *
 * A registered project (one that has been through `cf sync init`) is used as
 * registered, so tool calls and the background service share one merge base.
 * A repository with a manifest that was never registered still works: the
 * project is built from the manifest, under the id `init` would have given it.
 */

import { basename, resolve, sep } from 'node:path';

import { findManifestRoot, pickDevelopmentFile } from '../project-context.js';
import { loadManifest } from '../project-manifest.js';
import type { SyncBinding, SyncProject, SyncRegistry } from '../sync-registry.js';

function contains(parent: string, child: string): boolean {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base + sep);
}

function fromManifest(root: string): SyncProject {
  const manifest = loadManifest(root);
  return {
    id: manifest.id ?? basename(root),
    path: root,
    ...(manifest.org ? { org: manifest.org } : {}),
    ...(manifest.workspace ? { workspace: manifest.workspace } : {}),
    enabled: true,
    bindings: manifest.bindings.map((b): SyncBinding => ({
      file: b.file,
      // `parseManifest` guarantees an environment on every binding.
      environment: b.environment ?? '',
      ...(b.pod ? { pod: b.pod } : {}),
      ...(b.workspace && b.workspace !== manifest.workspace ? { workspace: b.workspace } : {}),
    })),
  };
}

/**
 * @throws Error when `cwd` is in neither a registered project nor a
 *   directory tree with a `.cryptflare.json`.
 */
export function resolveLocalProject(cwd: string, registry: SyncRegistry): SyncProject {
  const root = findManifestRoot(cwd);

  const registered = registry.projects
    .filter((project) => (root ? resolve(project.path) === root : contains(project.path, cwd)))
    // Deepest path first, so a nested registered project wins over its parent.
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (registered) return registered;

  if (root) return fromManifest(root);

  throw new Error(
    `${cwd} is not inside a CryptFlare project. Add a .cryptflare.json (run \`cf sync init --write\` `
      + 'in a registered project, or write one by hand), then try again.',
  );
}

/**
 * Picks one binding of a project: the named file, or the binding nearest
 * `cwd` when no file is given.
 *
 * @throws Error when the file is not bound, or when several bindings sit at
 *   the same depth and none was named.
 */
export function selectBinding(project: SyncProject, cwd: string, file?: string): SyncBinding {
  if (file) {
    const wanted = file.replace(/\\/g, '/').replace(/^\.\//, '');
    const match = project.bindings.find((b) => b.file.replace(/\\/g, '/') === wanted);
    if (!match) {
      throw new Error(`"${file}" is not a bound file. Bound files: ${project.bindings.map((b) => b.file).join(', ')}`);
    }
    return match;
  }

  const enclosing = project.bindings
    .map((binding) => ({ binding, dir: resolve(project.path, binding.file, '..') }))
    .filter(({ dir }) => contains(dir, cwd));
  const deepest = Math.max(-1, ...enclosing.map(({ dir }) => dir.length));
  const nearest = enclosing.filter(({ dir }) => dir.length === deepest).map(({ binding }) => binding);

  const [only] = nearest;
  if (nearest.length === 1 && only) return only;

  // `.env` beside `.env.production`: an unqualified tool call means the
  // development file. Production has to be named.
  const development = pickDevelopmentFile(nearest);
  if (development) return development;

  const candidates = (nearest.length > 0 ? nearest : project.bindings).map((b) => b.file).join(', ');
  throw new Error(`More than one bound file applies here. Pass \`file\` as one of: ${candidates}`);
}
