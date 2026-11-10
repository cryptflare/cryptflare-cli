/**
 * Picks the workspace and environment for a command from the repository's
 * `.cryptflare.json`, so `cf run`, `cf env` and `cf secret` work in a bound
 * project without `-w` and `-e` on every invocation.
 *
 * The manifest already says which file belongs to which environment. A
 * command run inside the repository is almost always about the file nearest
 * to where you are standing, so that is the binding chosen: the one whose
 * directory contains the current directory, deepest first.
 */

import { dirname, relative, resolve, sep } from 'node:path';

import { hasManifest, loadManifest, type ManifestBinding, type ProjectManifest } from './project-manifest.js';

export type ProjectTarget = {
  org?: string;
  workspace: string;
  environment: string;
  pod?: string;
  /** The bound file this target came from, relative to the project root. */
  file: string;
};

export class ProjectContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectContextError';
  }
}

/**
 * Walks up from `startDir` to the nearest directory holding a manifest.
 * Returns `null` when there is none - the command is not in a bound project.
 */
export function findManifestRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (hasManifest(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function toTarget(manifest: ProjectManifest, binding: ManifestBinding): ProjectTarget {
  // `parseManifest` guarantees both are set on every binding.
  const workspace = binding.workspace ?? manifest.workspace ?? '';
  const environment = binding.environment ?? manifest.environment ?? '';
  return {
    ...(manifest.org ? { org: manifest.org } : {}),
    workspace,
    environment,
    ...(binding.pod ? { pod: binding.pod } : {}),
    file: binding.file,
  };
}

/** Directory of a bound file as path segments relative to the root; `[]` for the root itself. */
function bindingDirSegments(file: string): string[] {
  const dir = dirname(file.replace(/\\/g, '/'));
  return dir === '.' ? [] : dir.split('/');
}

function cwdSegments(root: string, cwd: string): string[] {
  const rel = relative(root, resolve(cwd));
  return rel === '' ? [] : rel.split(sep);
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((segment, i) => segment === of[i]);
}

/**
 * Files that mean "local development" by convention, most specific first.
 *
 * When one directory binds several environments - `.env` beside
 * `.env.production` is the usual shape - a command with no flags has to mean
 * one of them. It means the development file. Guessing the other way would
 * point `cf run` or `cf secret set` at production by accident; this way
 * production always has to be asked for by name.
 */
const DEVELOPMENT_FILES = ['.env.local', '.env.development', '.env', '.dev.vars', '.envrc'] as const;

/**
 * The index of a file in {@link DEVELOPMENT_FILES}, or -1 when its name does
 * not mark it as a development file.
 */
export function developmentFileRank(file: string): number {
  const name = file.replace(/\\/g, '/').split('/').pop() ?? file;
  return (DEVELOPMENT_FILES as readonly string[]).indexOf(name);
}

/**
 * Narrows several candidates to the one conventional development file, when
 * exactly one of them outranks the rest. Returns `null` when the names do
 * not settle it, so the caller reports the ambiguity instead of guessing.
 */
export function pickDevelopmentFile<T extends { file: string }>(candidates: readonly T[]): T | null {
  const ranked = candidates
    .map((candidate) => ({ candidate, rank: developmentFileRank(candidate.file) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  const [best, next] = ranked;
  if (!best || (next && next.rank === best.rank)) return null;
  return best.candidate;
}

export type TargetQuery = {
  /** Directory the command was run from. */
  cwd: string;
  /** `--binding <file>`: name the bound file outright. */
  binding?: string | undefined;
  /** `--env <slug>`: narrow to bindings of this environment. */
  environment?: string | undefined;
  /** `--workspace <slug>`: narrow to bindings of this workspace. */
  workspace?: string | undefined;
};

/**
 * Chooses one binding of a manifest for a command.
 *
 * @returns `null` when no binding applies to the current directory, so the
 *   caller can fall back to flags and global defaults.
 * When one directory binds several environments, the conventional
 * development file wins (see {@link DEVELOPMENT_FILES}); production is never
 * chosen implicitly.
 *
 * @throws ProjectContextError when `--binding` names a file the manifest does
 *   not bind, or when several bindings fit equally well and neither the query
 *   nor the file names tell them apart.
 */
export function selectTarget(manifest: ProjectManifest, root: string, query: TargetQuery): ProjectTarget | null {
  if (query.binding) {
    const wanted = query.binding.replace(/\\/g, '/').replace(/^\.\//, '');
    const match = manifest.bindings.find((b) => b.file.replace(/\\/g, '/') === wanted);
    if (!match) {
      throw new ProjectContextError(
        `No binding for "${query.binding}" in this project. Bound files: ${manifest.bindings.map((b) => b.file).join(', ')}`,
      );
    }
    return toTarget(manifest, match);
  }

  const here = cwdSegments(root, query.cwd);
  const candidates = manifest.bindings
    .map((binding) => ({ target: toTarget(manifest, binding), dir: bindingDirSegments(binding.file) }))
    .filter(({ dir }) => isPrefix(dir, here))
    .filter(({ target }) => !query.environment || target.environment === query.environment)
    .filter(({ target }) => !query.workspace || target.workspace === query.workspace);

  if (candidates.length === 0) return null;

  const deepest = Math.max(...candidates.map(({ dir }) => dir.length));
  const nearest = candidates.filter(({ dir }) => dir.length === deepest).map(({ target }) => target);

  // Several files in one directory may share a scope (`.env` and `.env.local`
  // both on dev). That is one answer, not an ambiguity.
  const scopes = new Map(nearest.map((t) => [`${t.workspace}/${t.environment}/${t.pod ?? ''}`, t]));
  const [only] = [...scopes.values()];
  if (scopes.size === 1 && only) return only;

  // Several environments bound in one directory: take the development file
  // unless the caller narrowed the choice themselves.
  const development = query.environment || query.workspace ? null : pickDevelopmentFile(nearest);
  if (development) return development;

  const options = nearest.map((t) => `${t.file} -> ${t.workspace}/${t.environment}`).join('\n    ');
  throw new ProjectContextError(
    `This directory has bindings for more than one environment:\n    ${options}\n`
      + '  Pass --env <slug> or --binding <file> to choose.',
  );
}

/**
 * Resolves the target for a command run from `cwd`, or `null` when the
 * directory is not inside a project with a manifest.
 */
export function resolveProjectTarget(query: TargetQuery): ProjectTarget | null {
  const root = findManifestRoot(query.cwd);
  if (!root) {
    if (query.binding) {
      throw new ProjectContextError(`--binding needs a .cryptflare.json, and none was found above ${query.cwd}.`);
    }
    return null;
  }
  return selectTarget(loadManifest(root), root, query);
}

/**
 * Organisation and workspace for a command whose environment the manifest
 * does not bind - `cf run --env production` in a project that only binds
 * development files, say.
 *
 * The environment is the caller's to name, but the project still knows which
 * organisation and workspace it lives in. The workspace is the one every
 * binding around the current directory agrees on, or the manifest default.
 */
export function resolveProjectDefaults(cwd: string): { org?: string; workspace?: string } {
  const root = findManifestRoot(cwd);
  if (!root) return {};
  const manifest = loadManifest(root);

  const here = cwdSegments(root, cwd);
  const enclosing = manifest.bindings
    .map((binding) => ({ target: toTarget(manifest, binding), dir: bindingDirSegments(binding.file) }))
    .filter(({ dir }) => isPrefix(dir, here));
  const deepest = Math.max(-1, ...enclosing.map(({ dir }) => dir.length));
  const workspaces = new Set(
    enclosing.filter(({ dir }) => dir.length === deepest).map(({ target }) => target.workspace),
  );
  const [onlyWorkspace] = [...workspaces];
  const workspace = workspaces.size === 1 ? onlyWorkspace : manifest.workspace;

  return {
    ...(manifest.org ? { org: manifest.org } : {}),
    ...(workspace ? { workspace } : {}),
  };
}
