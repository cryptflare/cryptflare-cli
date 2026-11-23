/**
 * Reads and rewrites one file's values through its format: what to encrypt,
 * the rewrite itself (spans only), and decryption to a value map or to a
 * plaintext copy of the file.
 */

import { LOCAL_ENV_ERROR_CODES, LocalEnvError } from '@/lib/local-env/errors'
import type { FileEntry, FileFormat, ParsedFile } from '@/lib/local-env/formats'
import {
  isBrowserPublic,
  isPlaceholder,
  isReference,
  looksHighEntropy,
  looksSecretName,
} from '@/lib/local-env/names'
import {
  decryptValue,
  encryptValue,
  isEncryptedValue,
  keyRefOf,
  type LocalKey,
} from '@/lib/local-env/value-crypto'

/** What happens to one value when the file is encrypted. */
export type EntryDecision =
  | 'encrypt'
  | 'encrypted'
  | 'public'
  | 'empty'
  | 'reference'
  | 'not-secret'
  | 'registry-token'

export type EncryptOptions = {
  /** Encrypt browser-public names (`NEXT_PUBLIC_`, `VITE_`) too. */
  includePublic?: boolean
  /** Structured formats: encrypt every string, not only secret-looking ones. */
  allValues?: boolean
}

/** Decides what encryption does with an entry. Pure. */
export function decide(
  format: FileFormat,
  entry: FileEntry,
  opts: EncryptOptions = {},
): EntryDecision {
  if (isEncryptedValue(entry.value)) return 'encrypted'
  if (entry.value === '') return 'empty'
  if (isReference(entry.value)) return 'reference'
  if (format.style === 'registry') return 'registry-token'
  if (!opts.includePublic && isBrowserPublic(format.envName(entry))) return 'public'
  if (format.style === 'structured' && !opts.allValues) {
    const secretish = looksSecretName(entry.name) || looksHighEntropy(entry.value)
    if (!secretish || isPlaceholder(entry.value)) return 'not-secret'
  }
  return 'encrypt'
}

/** Replaces spans, last first so earlier offsets stay valid. */
export function replaceSpans(
  content: string,
  edits: ReadonlyArray<{ start: number; end: number; text: string }>,
): string {
  let out = content
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`
  }
  return out
}

/** Every key ref the file's values are encrypted under. */
export function keyRefsIn(parsed: ParsedFile): Set<string> {
  const refs = new Set<string>()
  for (const entry of parsed.entries) {
    const ref = keyRefOf(entry.value)
    if (ref) refs.add(ref)
  }
  return refs
}

/** Highest key version used in the file, or 0 for a plaintext file. */
export function highestVersion(parsed: ParsedFile): number {
  return Math.max(0, ...[...keyRefsIn(parsed)].map((ref) => Number(ref.split('.')[0])))
}

function keyFor(keys: ReadonlyMap<string, LocalKey>, value: string, name: string): LocalKey {
  const ref = keyRefOf(value) ?? ''
  const key = keys.get(ref)
  if (!key) {
    throw new LocalEnvError(
      LOCAL_ENV_ERROR_CODES.WRONG_KEY,
      `${name}: no key for ${ref || 'a malformed value'}`,
    )
  }
  return key
}

export type EncryptResult = {
  content: string
  encrypted: string[]
  decisions: Map<FileEntry, EntryDecision>
}

/**
 * Encrypts a file's values in place.
 *
 * @param key Key the new ciphertext is written under.
 * @param existing Keys for values already encrypted. With `rotate`, every
 *   encrypted value is decrypted with these and re-encrypted under `key`.
 */
export function encryptContent(
  content: string,
  format: FileFormat,
  key: LocalKey,
  opts: EncryptOptions & { rotate?: boolean; existing?: ReadonlyMap<string, LocalKey> } = {},
): EncryptResult {
  const parsed = format.parse(content)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const encrypted: string[] = []
  const decisions = new Map<FileEntry, EntryDecision>()

  for (const entry of parsed.entries) {
    const decision = decide(format, entry, opts)
    decisions.set(entry, decision)
    let plaintext: string | null = null
    if (decision === 'encrypt') plaintext = entry.value
    else if (decision === 'encrypted' && opts.rotate && keyRefOf(entry.value) !== key.keyRef) {
      plaintext = decryptValue(
        entry.value,
        entry.name,
        keyFor(opts.existing ?? new Map(), entry.value, entry.name),
      )
    }
    if (plaintext === null) continue
    edits.push({
      start: entry.start,
      end: entry.end,
      text: format.render(encryptValue(plaintext, entry.name, key), entry),
    })
    encrypted.push(entry.name)
  }
  return { content: replaceSpans(content, edits), encrypted, decisions }
}

export type DecryptResult = {
  /** Every value, decrypted where encrypted, keyed by env name. Last occurrence wins. */
  values: Map<string, string>
  /** Names whose values were encrypted. */
  decrypted: string[]
  /** The file with every encrypted value replaced by its plaintext. */
  plaintext: string
}

/** Decrypts every `cf:v1` value of a file with the given keys. */
export function decryptContent(
  content: string,
  format: FileFormat,
  keys: ReadonlyMap<string, LocalKey>,
): DecryptResult {
  const parsed = format.parse(content)
  const values = new Map<string, string>()
  const decrypted: string[] = []
  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const entry of parsed.entries) {
    let value = entry.value
    if (isEncryptedValue(value)) {
      value = decryptValue(value, entry.name, keyFor(keys, value, entry.name))
      decrypted.push(entry.name)
      edits.push({ start: entry.start, end: entry.end, text: format.render(value, entry) })
    }
    values.set(format.envName(entry), value)
  }
  return { values, decrypted, plaintext: replaceSpans(content, edits) }
}
