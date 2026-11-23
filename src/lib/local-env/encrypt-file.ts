/**
 * Encrypts one file in place: the work behind `cf env encrypt` and the
 * rewrite step of `cf env migrate`.
 */

import { readFileSync } from 'node:fs'

import {
  encryptContent,
  highestVersion,
  keyRefsIn,
  replaceSpans,
  type EncryptOptions,
  type EntryDecision,
} from '@/lib/local-env/codec'
import type { FileTarget } from '@/lib/local-env/file-target'
import { writeFileAtomic } from '@/lib/local-env/file-io'
import type { Keyring } from '@/lib/local-env/keyring'
import { restoreLeftovers } from '@/lib/local-env/materialize'
import { encryptValue, isEncryptedValue } from '@/lib/local-env/value-crypto'

export type EncryptFileOptions = EncryptOptions & {
  /** Re-encrypt every value under the next key version. */
  rotate?: boolean
  /** Values to write instead of the file's own, by env name (`--from-vault`). */
  replacements?: ReadonlyMap<string, string>
  /** Plan only: compute the result, do not write. */
  dryRun?: boolean
}

export type EncryptFileResult = {
  rel: string
  version: number
  changed: boolean
  encrypted: string[]
  byDecision: Map<EntryDecision, string[]>
  unmanaged: Array<{ name: string; line: number; reason: string }>
  duplicates: string[]
}

function duplicatesOf(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const name of names) (seen.has(name) ? dup : seen).add(name)
  return [...dup]
}

/**
 * Rewrites values from `replacements` as ciphertext, whatever the file holds
 * now: the recovery path when old ciphertext no longer decrypts (a BYOK key
 * was replaced).
 */
function fromReplacements(
  content: string,
  target: FileTarget,
  opts: EncryptFileOptions,
  key: Parameters<typeof encryptValue>[2],
) {
  const parsed = target.format.parse(content)
  const encrypted: string[] = []
  const edits = parsed.entries.flatMap((entry) => {
    const value = opts.replacements?.get(target.format.envName(entry))
    if (value === undefined) return []
    encrypted.push(entry.name)
    return [
      {
        start: entry.start,
        end: entry.end,
        text: target.format.render(encryptValue(value, entry.name, key), entry),
      },
    ]
  })
  return { content: replaceSpans(content, edits), encrypted }
}

/** Encrypts one file. Reads keys for every version it already uses. */
export async function encryptFile(
  target: FileTarget,
  keyring: Keyring,
  opts: EncryptFileOptions = {},
): Promise<EncryptFileResult> {
  restoreLeftovers([target.path])
  const content = readFileSync(target.path, 'utf-8')
  const parsed = target.format.parse(content)
  const refs = keyRefsIn(parsed)
  const current = highestVersion(parsed)
  const version = opts.rotate || opts.replacements ? current + 1 : Math.max(current, 1)

  const key = await keyring.get(target.scope, version)
  let next: { content: string; encrypted: string[] }
  const byDecision = new Map<EntryDecision, string[]>()

  if (opts.replacements) {
    next = fromReplacements(content, target, opts, key)
  } else {
    // Checks every ref already in the file belongs to this environment, so a
    // file bound to the wrong environment is refused before it is mixed.
    const existing = await keyring.forRefs(target.scope, refs)
    const result = encryptContent(content, target.format, key, { ...opts, existing })
    for (const [entry, decision] of result.decisions) {
      byDecision.set(decision, [...(byDecision.get(decision) ?? []), entry.name])
    }
    next = result
  }

  const changed = next.content !== content
  if (changed && !opts.dryRun) writeFileAtomic(target.path, next.content)
  return {
    rel: target.rel,
    version,
    changed,
    encrypted: next.encrypted,
    byDecision,
    unmanaged: parsed.unmanaged,
    duplicates: duplicatesOf(parsed.entries.map((entry) => entry.name)),
  }
}

/** Counts for `cf env status`: no key, no network. */
export function inspectContent(content: string, target: Pick<FileTarget, 'format'>) {
  const parsed = target.format.parse(content)
  const encrypted = parsed.entries.filter((entry) => isEncryptedValue(entry.value)).length
  return {
    entries: parsed.entries.length,
    encrypted,
    plaintext: parsed.entries.filter(
      (entry) => !isEncryptedValue(entry.value) && entry.value !== '',
    ).length,
    unmanaged: parsed.unmanaged.length,
    refs: [...keyRefsIn(parsed)],
  }
}
