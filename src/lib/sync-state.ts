/**
 * Last-known-good sync state - the three-way merge base.
 *
 * A two-way diff between a local `.env` and the remote environment cannot tell
 * "the server changed this" from "I changed this locally"; both just look like
 * "these differ". Recording what each side looked like at the end of the last
 * successful pass turns every subsequent comparison into a three-way merge, so
 * the engine can push local edits, pull remote edits, and detect the genuine
 * both-sides case instead of guessing.
 *
 * ## What is stored, and why it is not the value
 *
 * Remote side: the version number from `secrets.list`, which is metadata the
 * list endpoint already returns. Detecting a remote change therefore costs one
 * list call, not one `reveal` per secret per poll. That matters: the existing
 * `cf daemon` reveals every secret every 30s, which burns quota and writes an
 * audit-log entry per secret per poll forever.
 *
 * Local side: an HMAC-SHA256 of the value under a random per-file salt, never
 * the value itself. A bare SHA-256 would be a dictionary oracle for
 * low-entropy values (`DEBUG=true`, a port number, a dev password) - the same
 * reasoning that keeps value hashes out of the version-history diff UI. The
 * salt does not defend against someone who can already read this file, since
 * they can read the `.env` sitting next to it; it defends against the hashes
 * being precomputable or correlatable across machines and backups.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getConfigPath } from './config.js';

export type KeyState = {
  /** Version seen in `secrets.list` at the end of the last successful pass. */
  remoteVersion: number;
  /** HMAC of the local value at the end of the last successful pass. */
  localMac: string;
};

export type BindingState = {
  lastSyncAt: string;
  keys: Record<string, KeyState>;
};

export type SyncState = {
  version: 1;
  /** Hex salt for the local-value HMAC. Rotating it forces a full re-baseline. */
  salt: string;
  bindings: Record<string, BindingState>;
};

const STATE_VERSION = 1;

export function getStatePath(): string {
  return join(dirname(getConfigPath()), 'sync-state.json');
}

export function emptyState(): SyncState {
  return { version: STATE_VERSION, salt: randomBytes(32).toString('hex'), bindings: {} };
}

/**
 * Reads state, falling back to a fresh baseline on anything unreadable.
 *
 * A corrupt state file must not wedge the service. Losing the merge base is
 * recoverable - the next pass treats every key as unchanged-on-both-sides and
 * re-baselines - whereas a crash loop during a two-week absence is not.
 */
export function loadState(path = getStatePath()): SyncState {
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SyncState>;
    if (raw.version !== STATE_VERSION || typeof raw.salt !== 'string' || typeof raw.bindings !== 'object') {
      return emptyState();
    }
    return { version: STATE_VERSION, salt: raw.salt, bindings: (raw.bindings ?? {}) as Record<string, BindingState> };
  } catch {
    return emptyState();
  }
}

export function saveState(state: SyncState, path = getStatePath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

export function macValue(salt: string, value: string): string {
  return createHmac('sha256', Buffer.from(salt, 'hex')).update(value, 'utf-8').digest('hex');
}

/** Constant-time compare so state reads are not a timing side channel. */
export function macMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
