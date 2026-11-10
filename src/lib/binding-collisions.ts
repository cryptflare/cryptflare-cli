/**
 * Finds env files of one project that are bound to the same place.
 *
 * The server keys a secret by environment and key. Two files bound to one
 * environment therefore share every key: whichever is synced second sees the
 * other file's value as a remote change and takes it, so the two files
 * overwrite each other on every pass. Nothing about that is recoverable by
 * retrying, so the colliding files are refused and the rest carry on.
 *
 * A pod is a separate place inside an environment, so two files in one
 * environment and different pods do not collide.
 *
 * Only files of the same project are compared. Two checkouts of one
 * repository bind the same environments on purpose, exactly as two machines
 * do.
 */

import { MANIFEST_FILENAME } from './project-manifest.js';

/** The fields of a binding that decide where its secrets live. */
export type BoundFile = {
  file: string;
  workspace?: string | undefined;
  environment?: string | undefined;
  pod?: string | undefined;
};

export type BindingCollision = {
  /** `workspace/environment`, with `/pod` when one is named. */
  target: string;
  /** Every file bound there, in the order they were listed. Always two or more. */
  files: string[];
};

/**
 * @param bindings The bindings of one project.
 * @param defaultWorkspace Workspace for bindings that do not name their own.
 */
export function findBindingCollisions(
  bindings: readonly BoundFile[],
  defaultWorkspace?: string | undefined,
): BindingCollision[] {
  const byTarget = new Map<string, string[]>();
  for (const binding of bindings) {
    const target = [binding.workspace ?? defaultWorkspace ?? '', binding.environment ?? '']
      .concat(binding.pod ? [binding.pod] : [])
      .join('/');
    byTarget.set(target, [...(byTarget.get(target) ?? []), binding.file]);
  }
  return [...byTarget]
    .filter(([, files]) => files.length > 1)
    .map(([target, files]) => ({ target, files }));
}

/** The files named by any of the collisions. */
export function collidingFiles(collisions: readonly BindingCollision[]): Set<string> {
  return new Set(collisions.flatMap((collision) => collision.files));
}

/** One sentence naming every file and the environment they share. */
export function describeCollision(collision: BindingCollision): string {
  const names = collision.files.map((file) => `"${file}"`);
  const list = names.length === 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} are ${names.length === 2 ? 'both' : 'all'} bound to environment ${collision.target}. `
    + 'Secrets are stored per environment and key, so these files would overwrite each other on every pass. '
    + `None of them is synced until each has its own environment (or pod) in ${MANIFEST_FILENAME}, `
    + 'followed by `cf sync init` in the repository.';
}

/**
 * Throws when bindings collide. For the places where bindings are being
 * added by a person, and refusing the whole change is the clear answer.
 */
export function assertNoBindingCollisions(bindings: readonly BoundFile[], defaultWorkspace?: string | undefined): void {
  const collisions = findBindingCollisions(bindings, defaultWorkspace);
  if (collisions.length > 0) throw new Error(collisions.map(describeCollision).join('\n'));
}
