import { chmodSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'

/**
 * Replaces a file atomically, keeping its permission bits. Renamed into place
 * so an editor, a running dev server or `cf sync` never reads half a file.
 */
export function writeFileAtomic(path: string, content: string, newFileMode = 0o600): void {
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : newFileMode
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, { encoding: 'utf-8', mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}
