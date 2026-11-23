/**
 * TOML secrets files: Dynaconf's `.secrets.toml` / `settings.toml` and
 * Streamlit's `.streamlit/secrets.toml`.
 *
 * Only single-line string values (`key = "value"`, `key = 'value'`) are
 * managed, named by their table path (`database.password`). Numbers,
 * booleans, arrays, inline tables and multi-line strings pass through and
 * are reported as unmanaged.
 */

import { toUpperSnake } from '@/lib/local-env/names'
import { baseName } from '@/lib/local-env/formats/env-formats'
import type { FileEntry, FileFormat, ParsedFile } from '@/lib/local-env/formats/types'

const TABLE = /^[ \t]*\[([^[\]]+)\][ \t]*(#.*)?$/
const ARRAY_TABLE = /^[ \t]*\[\[([^[\]]+)\]\]/
const PAIR =
  /^([ \t]*)((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:[ \t]*\.[ \t]*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)[ \t]*=[ \t]*/

const NAMES = new Set([
  '.secrets.toml',
  'settings.toml',
  'settings.local.toml',
  '.secrets.local.toml',
])

function keyPath(raw: string): string {
  return raw
    .split('.')
    .map((part) => part.trim().replace(/^["']|["']$/g, ''))
    .join('.')
}

/** Decodes a TOML basic string body; JSON's escapes are a subset TOML accepts. */
function decodeBasic(body: string): string | null {
  try {
    const decoded: unknown = JSON.parse(`"${body}"`)
    return typeof decoded === 'string' ? decoded : null
  } catch {
    return null
  }
}

function parseToml(content: string): ParsedFile {
  const parsed: ParsedFile = { entries: [], unmanaged: [] }
  let table = ''
  let skipTable = false
  let offset = 0
  const lines = content.split('\n')

  lines.forEach((text, i) => {
    const lineStart = offset
    offset += text.length + 1
    const line = i + 1
    const arrayTable = ARRAY_TABLE.exec(text)
    if (arrayTable) {
      table = (arrayTable[1] ?? '').trim()
      skipTable = true
      return
    }
    const header = TABLE.exec(text)
    if (header) {
      table = keyPath(header[1] ?? '')
      skipTable = false
      return
    }
    const pair = PAIR.exec(text)
    if (!pair || text.trimStart().startsWith('#')) return
    const name = [table, keyPath(pair[2] ?? '')].filter(Boolean).join('.')
    if (skipTable) {
      parsed.unmanaged.push({ name, line, reason: 'inside an array of tables' })
      return
    }
    const start = lineStart + pair[0].length
    const rest = text.slice(pair[0].length).replace(/\r$/, '')
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      parsed.unmanaged.push({ name, line, reason: 'multi-line string' })
      return
    }
    const basic = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
    const literal = /^'([^']*)'/.exec(rest)
    if (basic) {
      const value = decodeBasic(basic[1] ?? '')
      if (value === null) parsed.unmanaged.push({ name, line, reason: 'unsupported escape' })
      else
        parsed.entries.push({
          name,
          value,
          start,
          end: start + basic[0].length,
          quote: 'double',
          line,
        })
    } else if (literal) {
      const value = literal[1] ?? ''
      parsed.entries.push({
        name,
        value,
        start,
        end: start + literal[0].length,
        quote: 'single',
        line,
      })
    } else if (rest.startsWith('[') || rest.startsWith('{')) {
      parsed.unmanaged.push({ name, line, reason: 'array or inline table' })
    }
  })
  return parsed
}

/** A TOML basic string. DEL is escaped too: TOML forbids raw control characters. */
function renderToml(value: string, entry: FileEntry): string {
  if (entry.quote === 'single' && !value.includes("'") && !/[\n\r]/.test(value)) return `'${value}'`
  return JSON.stringify(value).replace(/\u007f/g, '\\u007f')
}

export const tomlFormat: FileFormat = {
  id: 'toml',
  label: 'TOML secrets (Dynaconf, Streamlit)',
  injection: 'materialize',
  style: 'structured',
  matches: (path) =>
    NAMES.has(baseName(path)) || path.toLowerCase().endsWith('.streamlit/secrets.toml'),
  parse: parseToml,
  render: renderToml,
  envName: (entry) => toUpperSnake(entry.name),
}
