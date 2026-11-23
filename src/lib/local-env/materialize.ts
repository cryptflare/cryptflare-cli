/**
 * Plaintext for tools that read a secrets file themselves (Streamlit,
 * Dynaconf, Terraform, docker-compose), for the life of one child process.
 *
 * In place: the ciphertext is copied to `<file>.cf-restore` first, the
 * plaintext is written over the file with mode 0600, and the ciphertext goes
 * back when the child exits or cf is signalled. A sidecar left by a hard kill
 * is restored by the next `cf run`, `cf env status` or `cf env encrypt`.
 *
 * Temp: plaintext copies in a private directory under the OS temp dir, removed
 * on exit, for tools that take a path (`--env-file`, `-var-file`).
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export const RESTORE_SUFFIX = '.cf-restore'

export type MaterializeTarget = {
  /** Absolute path of the encrypted file. */
  path: string
  /** Content as it is on disk (ciphertext). */
  original: string
  /** The same file with every value decrypted. */
  plaintext: string
}

const PRIVATE = 0o600

/**
 * Puts back any file a previous materialisation did not restore.
 *
 * @returns The files that were restored.
 */
export function restoreLeftovers(paths: readonly string[]): string[] {
  const restored: string[] = []
  for (const path of paths) {
    const sidecar = `${path}${RESTORE_SUFFIX}`
    if (!existsSync(sidecar)) continue
    renameSync(sidecar, path)
    restored.push(path)
  }
  return restored
}

/**
 * Writes plaintext in place. The returned function restores every file and
 * is safe to call more than once.
 */
export function materializeInPlace(targets: readonly MaterializeTarget[]): () => void {
  const done: Array<{ path: string; original: string; mode: number }> = []
  const restore = () => {
    for (const item of done.splice(0)) {
      writeFileSync(item.path, item.original, 'utf-8')
      chmodSync(item.path, item.mode)
      rmSync(`${item.path}${RESTORE_SUFFIX}`, { force: true })
    }
  }
  try {
    for (const target of targets) {
      const mode = statSync(target.path).mode & 0o777
      writeFileSync(`${target.path}${RESTORE_SUFFIX}`, target.original, {
        encoding: 'utf-8',
        mode: PRIVATE,
      })
      done.push({ path: target.path, original: target.original, mode })
      chmodSync(target.path, PRIVATE)
      writeFileSync(target.path, target.plaintext, 'utf-8')
    }
  } catch (err) {
    restore()
    throw err
  }
  return restore
}

/**
 * Writes plaintext copies into a fresh private temp directory.
 *
 * @returns The copy for each original path, and a cleanup that removes the
 *   directory (safe to call more than once).
 */
export function materializeTemp(targets: readonly MaterializeTarget[]): {
  copies: Map<string, string>
  cleanup: () => void
} {
  const dir = mkdtempSync(join(tmpdir(), 'cf-run-'))
  chmodSync(dir, 0o700)
  const copies = new Map<string, string>()
  targets.forEach((target, i) => {
    const copy = join(dir, `${i}-${basename(target.path)}`)
    writeFileSync(copy, target.plaintext, { encoding: 'utf-8', mode: PRIVATE })
    copies.set(target.path, copy)
  })
  return { copies, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
