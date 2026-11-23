/**
 * Name and value heuristics for encrypted local env files: which values are
 * public by construction, which look secret, which are only references.
 */

import { BROWSER_PUBLIC_PREFIXES } from '@/lib/local-env/contract'

/** `ConnectionStrings.Default` -> `CONNECTIONSTRINGS_DEFAULT`, the CryptFlare key form. */
export function toUpperSnake(name: string): string {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  return /^[A-Z]/.test(snake) ? snake : `K_${snake}`
}

/** Whether a bundler ships this variable to every browser (`NEXT_PUBLIC_`, `VITE_`, ...). */
export function isBrowserPublic(name: string): boolean {
  return BROWSER_PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix))
}

const SECRET_WORD =
  /(key|secret|token|passw(or)?d|passwd|pwd|pass|credential|connection_?string|dsn|private|auth|cert|salt|signing|webhook)/i

/** Whether the last segment of a name looks like it holds a secret. */
export function looksSecretName(name: string): boolean {
  const last = name.split('.').pop() ?? name
  // .NET keeps connection strings under a section: `ConnectionStrings.Default`.
  return SECRET_WORD.test(last) || /connection_?strings?(\.|$)/i.test(name)
}

/** Shannon entropy in bits per character. */
export function entropy(value: string): number {
  if (value.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/** Long, random-looking strings: generated keys and tokens. */
export function looksHighEntropy(value: string): boolean {
  return value.length >= 20 && !/\s/.test(value) && entropy(value) >= 3.8
}

/** `${VAR}`, `$VAR`: the value points elsewhere and holds nothing itself. */
export function isReference(value: string): boolean {
  return /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value.trim())
}

/** Placeholders a template uses in place of a value. */
export function isPlaceholder(value: string): boolean {
  return /^(<.*>|changeme|change-me|xxx+|todo|your[-_].*|\*+|replace[-_]?me)$/i.test(value.trim())
}
