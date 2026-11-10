/**
 * Wakes the sync loop when a bound env file changes on disk.
 *
 * The loop polls, and backs off to ten minutes when nothing is happening. So
 * a key pasted into `.env` could sit there for ten minutes before anything
 * noticed. Watching the files closes that gap: an edit wakes the loop within
 * a second, and polling stays as the fallback for what a watcher cannot see.
 *
 * It watches each file's **directory**, not the file. Editors and this CLI
 * replace a file by writing a temporary one and renaming it over the
 * original, which a watch on the file itself loses at the first save.
 *
 * Watching is best effort. Some filesystems do not deliver events at all
 * (a Windows drive mounted in WSL, some network mounts); there the watcher
 * simply never fires and the loop runs on its poll interval as before.
 */

import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';

/** Quiet period after the last event before waking, so one save is one pass. */
export const WAKE_DEBOUNCE_MS = 750;

export type FileWake = {
  /**
   * Resolves on the next change to a watched file, or at once if one happened
   * since the last wait. One-shot: call again to wait again.
   */
  next: () => Promise<void>;
  /** How many directories are actually being watched. Zero means polling only. */
  watching: number;
  close: () => void;
};

/** A directory to watch for any file whose name passes a test, not just known names. */
export type DirectoryWatch = {
  directory: string;
  matches: (name: string) => boolean;
};

/**
 * Starts watching the given files.
 *
 * @param paths Absolute paths of the files to watch.
 * @param debounceMs Quiet period before a change wakes the waiter.
 * @param directories Directories in which a file that does not exist yet
 *   should also wake the loop, such as a new env file beside a bound one.
 */
export function watchFiles(
  paths: readonly string[],
  debounceMs: number = WAKE_DEBOUNCE_MS,
  directories: readonly DirectoryWatch[] = [],
): FileWake {
  const namesByDirectory = new Map<string, Set<string>>();
  for (const path of paths) {
    const names = namesByDirectory.get(dirname(path)) ?? new Set<string>();
    names.add(basename(path));
    namesByDirectory.set(dirname(path), names);
  }
  const matchersByDirectory = new Map<string, Array<(name: string) => boolean>>();
  for (const { directory, matches } of directories) {
    matchersByDirectory.set(directory, [...(matchersByDirectory.get(directory) ?? []), matches]);
    if (!namesByDirectory.has(directory)) namesByDirectory.set(directory, new Set());
  }

  const watchers: FSWatcher[] = [];
  let waiters: Array<() => void> = [];
  let timer: NodeJS.Timeout | undefined;
  // A change that lands while nobody is waiting - the loop is in the middle
  // of a pass - must not be lost: the next wait returns at once instead.
  let missed = false;

  const wake = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const pending = waiters;
      waiters = [];
      if (pending.length === 0) missed = true;
      for (const resolve of pending) resolve();
    }, debounceMs);
    // A pending wake must not keep the process alive once the loop stops.
    timer.unref?.();
  };

  for (const [directory, names] of namesByDirectory) {
    try {
      const watcher = watch(directory, { persistent: false }, (_event, filename) => {
        // Some platforms report no filename; treat that as "something here
        // changed" rather than miss the edit.
        if (filename === null) return wake();
        const name = String(filename);
        if (names.has(name) || (matchersByDirectory.get(directory) ?? []).some((matches) => matches(name))) wake();
      });
      // A directory removed mid-run, or a filesystem that gives up, must not
      // take the loop down with it. Polling still covers the files.
      watcher.on('error', () => watcher.close());
      watchers.push(watcher);
    } catch {
      // The directory does not exist yet, or this filesystem cannot be
      // watched. Polling covers it.
    }
  }

  return {
    next: () => new Promise<void>((resolve) => {
      if (missed) {
        missed = false;
        resolve();
        return;
      }
      waiters.push(resolve);
    }),
    watching: watchers.length,
    close: () => {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
      waiters = [];
    },
  };
}
