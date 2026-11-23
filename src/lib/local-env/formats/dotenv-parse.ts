/**
 * Span-tracking parser for dotenv-shaped files (`.env*`, `.dev.vars`,
 * `.envrc`, `.flaskenv`, compose `env_file` targets).
 *
 * Unlike `lib/env-file.ts`, which the sync engine uses and which refuses
 * multi-line values, this records the exact span of every value, including
 * quoted values that run over several lines, so the encrypter can replace a
 * value without touching a byte around it. CRLF files keep their `\r`: it is
 * outside every span.
 */

import { renderValue } from '@/lib/env-file'
import { isEncryptedValue } from '@/lib/local-env/value-crypto'
import type { FileEntry, ParsedFile, QuoteStyle } from '@/lib/local-env/formats/types'

const ASSIGNMENT = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*/

const QUOTES: Record<string, QuoteStyle> = { '"': 'double', "'": 'single', '`': 'backtick' }

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t' }

/** Resolves the escapes a double-quoted dotenv value may hold. */
function decodeDouble(raw: string): string {
  return raw.replace(/\\(.)/gs, (_match, ch: string) => ESCAPES[ch] ?? ch)
}

/** Index of the closing quote for a value opening at `open`, or -1. */
function closingQuote(content: string, open: number, quote: string): number {
  for (let i = open + 1; i < content.length; i++) {
    const ch = content.charAt(i)
    if (quote === '"' && ch === '\\') {
      i++
      continue
    }
    if (ch === quote) return i
  }
  return -1
}

function lineEndFrom(content: string, from: number): number {
  const end = content.indexOf('\n', from)
  return end === -1 ? content.length : end
}

function countLines(content: string, from: number, to: number): number {
  let n = 0
  for (let i = from; i < to; i++) if (content.charCodeAt(i) === 10) n++
  return n
}

/** Parses dotenv content into entries with spans. Duplicate keys are kept, in order. */
export function parseDotenv(content: string): ParsedFile {
  const parsed: ParsedFile = { entries: [], unmanaged: [] }
  let pos = 0
  let line = 1

  while (pos < content.length) {
    const lineEnd = lineEndFrom(content, pos)
    const text = content.slice(pos, lineEnd)
    const match = ASSIGNMENT.exec(text)
    let next = lineEnd + 1

    if (match && !text.trimStart().startsWith('#')) {
      const name = match[3] ?? ''
      const start = pos + match[0].length
      const opener = content.charAt(start)
      const quote = QUOTES[opener]

      if (quote) {
        const close = closingQuote(content, start, opener)
        if (close === -1) {
          parsed.unmanaged.push({ name, line, reason: 'unterminated quote' })
        } else {
          const inner = content.slice(start + 1, close)
          parsed.entries.push({
            name,
            value: quote === 'double' ? decodeDouble(inner) : inner,
            start,
            end: close + 1,
            quote,
            line,
          })
          next = lineEndFrom(content, close) + 1
        }
      } else {
        const rest = content.slice(start, lineEnd).replace(/\r$/, '')
        const hash = rest.search(/[ \t]#/)
        const token = (hash === -1 ? rest : rest.slice(0, hash)).trimEnd()
        parsed.entries.push({
          name,
          value: token,
          start,
          end: start + token.length,
          quote: 'none',
          line,
        })
      }
    }

    line += countLines(content, pos, Math.min(next, content.length))
    pos = next
  }
  return parsed
}

/**
 * A double-quoted dotenv value that {@link decodeDouble} reads back unchanged.
 * `$` and backticks stay as they are: the original file had them unescaped,
 * and the tool reading it (dotenv-expand, a shell) decides what they mean.
 */
function renderDouble(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
  return `"${escaped}"`
}

/**
 * Renders a dotenv value in the quote style the entry had, so encrypting
 * and then decrypting a file gives back the file as it was written. Ciphertext
 * needs no quoting. Plaintext that the original style cannot hold (a `'`
 * inside single quotes, a line break outside double quotes, a space with no
 * quotes) goes through the shell-safe writer the sync engine uses.
 */
export function renderDotenv(value: string, entry: FileEntry): string {
  if (isEncryptedValue(value) || value.startsWith('${')) {
    if (entry.quote === 'double') return `"${value}"`
    if (entry.quote === 'single') return `'${value}'`
    return value
  }
  if (entry.quote === 'double') return renderDouble(value)
  if (entry.quote === 'single' && !/['\n]/.test(value)) return `'${value}'`
  return renderValue(value)
}
