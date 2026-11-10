/**
 * Finds repositories that should be set up without anyone asking.
 *
 * The goal is that a `.env`, `.dev.vars` or `.envrc` is taken care of from
 * the moment it exists: no command per project, no remembering. A person
 * names one or more root directories once (`cf sync auto ~/code`), and from
 * then on every git repository under a root that has env files is given a
 * manifest, uploaded to its own workspace, and kept in sync.
 *
 * That is a deliberate, standing consent to upload, which is why it only
 * ever applies under the roots that were named. Nothing outside them is
 * looked at, and with no roots this does nothing at all.
 *
 * This module only decides *which* directories qualify. Setting one up is
 * `cf sync init --create --yes`, the same path a person would run by hand.
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';

import { findEnvFiles } from './discover.js';
import { hasManifest } from './project-manifest.js';
import type { SyncRegistry } from './sync-registry.js';

/** How far below a root a repository may sit: `~/code/org/repo` is depth 2. */
export const REPOSITORY_SEARCH_DEPTH = 3;

/** Directories that hold other people's code or build output, never a project of yours. */
const SKIPPED = new Set(['node_modules', 'vendor', 'dist', 'build', '.cache', '.venv', 'venv', 'target']);

/**
 * Git repositories under a root. A repository is not searched for
 * repositories nested inside it: a checkout vendored into another project is
 * part of that project, not one of its own.
 */
export function findRepositories(root: string, maxDepth: number = REPOSITORY_SEARCH_DEPTH): string[] {
  const found: string[] = [];

  const walk = (directory: string, depth: number) => {
    if (existsSync(join(directory, '.git'))) {
      found.push(directory);
      return;
    }
    if (depth >= maxDepth) return;

    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // Unreadable: nothing to set up there.
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && !SKIPPED.has(entry.name)) {
        walk(join(directory, entry.name), depth + 1);
      }
    }
  };

  walk(resolve(root), 0);
  return found.sort();
}

export type PendingRepository = {
  path: string;
  /**
   * `adopt`: it already carries a manifest (a fresh clone) - pull its files
   * and register. `create`: it has env files and no manifest - write one,
   * create the remote side, upload.
   */
  action: 'adopt' | 'create';
};

/**
 * Repositories under the registry's roots that are not registered yet and
 * have something to set up. A repository with neither a manifest nor an env
 * file is left alone: there is nothing of it to manage.
 */
export function pendingRepositories(registry: SyncRegistry): PendingRepository[] {
  const registered = new Set(registry.projects.map((project) => resolve(project.path)));
  const pending: PendingRepository[] = [];
  const seen = new Set<string>();

  for (const root of registry.roots ?? []) {
    for (const path of findRepositories(root)) {
      if (registered.has(path) || seen.has(path)) continue;
      seen.add(path);
      if (hasManifest(path)) pending.push({ path, action: 'adopt' });
      else if (findEnvFiles(path).length > 0) pending.push({ path, action: 'create' });
    }
  }
  return pending;
}
