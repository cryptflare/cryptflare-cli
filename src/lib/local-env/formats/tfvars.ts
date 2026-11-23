/**
 * Terraform variable files: `terraform.tfvars` and `*.auto.tfvars`.
 *
 * Only top-level `name = "string"` assignments are managed. Maps, lists,
 * heredocs and anything inside braces pass through untouched. Terraform gives
 * these files precedence over `TF_VAR_*`, so they are materialised, not
 * injected.
 */

import { toUpperSnake } from '@/lib/local-env/names'
import { baseName } from '@/lib/local-env/formats/env-formats'
import type { FileFormat, ParsedFile } from '@/lib/local-env/formats/types'

const PAIR = /^([ \t]*)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*=[ \t]*/
const HEREDOC = /^<<-?([A-Za-z_][A-Za-z0-9_]*)/

/** Net change in `{`/`[` depth over a line, ignoring brackets inside strings. */
function depthDelta(text: string): number {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/(#|\/\/).*$/, '')
  let delta = 0
  for (const ch of bare) {
    if (ch === '{' || ch === '[') delta++
    else if (ch === '}' || ch === ']') delta--
  }
  return delta
}

function decode(body: string): string | null {
  try {
    const decoded: unknown = JSON.parse(`"${body}"`)
    return typeof decoded === 'string' ? decoded : null
  } catch {
    return null
  }
}

function parseTfvars(content: string): ParsedFile {
  const parsed: ParsedFile = { entries: [], unmanaged: [] }
  let depth = 0
  let heredoc: string | null = null
  let offset = 0

  content.split('\n').forEach((text, i) => {
    const lineStart = offset
    offset += text.length + 1
    const line = i + 1
    if (heredoc !== null) {
      if (text.trim() === heredoc) heredoc = null
      return
    }
    const pair = depth === 0 ? PAIR.exec(text) : null
    depth = Math.max(0, depth + depthDelta(text))
    if (!pair) return
    const name = pair[2] ?? ''
    const rest = text.slice(pair[0].length).replace(/\r$/, '')
    const doc = HEREDOC.exec(rest)
    if (doc) {
      heredoc = doc[1] ?? ''
      parsed.unmanaged.push({ name, line, reason: 'heredoc' })
      return
    }
    const str = /^"((?:[^"\\]|\\.)*)"/.exec(rest)
    if (!str) {
      if (rest.startsWith('{') || rest.startsWith('[')) {
        parsed.unmanaged.push({ name, line, reason: 'map or list' })
      }
      return
    }
    const body = str[1] ?? ''
    const value = decode(body)
    if (value === null || /\$\{|%\{/.test(body)) {
      parsed.unmanaged.push({ name, line, reason: 'template or unsupported escape' })
      return
    }
    const start = lineStart + pair[0].length
    parsed.entries.push({ name, value, start, end: start + str[0].length, quote: 'double', line })
  })
  return parsed
}

/** An HCL string: JSON escapes, plus `${` and `%{` doubled so they stay literal. */
function renderTfvars(value: string): string {
  return JSON.stringify(value).replace(/\$\{/g, '$${').replace(/%\{/g, '%%{')
}

export const tfvarsFormat: FileFormat = {
  id: 'tfvars',
  label: 'Terraform variables',
  injection: 'materialize',
  style: 'structured',
  matches: (path) => {
    const name = baseName(path)
    return name === 'terraform.tfvars' || name.endsWith('.auto.tfvars')
  },
  parse: parseTfvars,
  render: renderTfvars,
  envName: (entry) => toUpperSnake(entry.name),
}
