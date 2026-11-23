/**
 * JSON secrets files: Firebase `.runtimeconfig.json`, generic `secrets.json`
 * and .NET user secrets / `appsettings.Development.json`.
 *
 * A small scanner records the span of every string value with its key path
 * (`ConnectionStrings.Default`, `servers.0.password`). It accepts the `//`
 * and block comments and trailing commas .NET configuration allows, and
 * leaves every byte outside a string value untouched.
 */

import { toUpperSnake } from '@/lib/local-env/names'
import { baseName } from '@/lib/local-env/formats/env-formats'
import type { FileFormat, ParsedFile } from '@/lib/local-env/formats/types'

const NAMES = new Set([
  '.runtimeconfig.json',
  'secrets.json',
  'appsettings.development.json',
  'appsettings.local.json',
])

class JsonScanError extends Error {
  readonly code = 'local_env.json_scan'
  constructor(message: string) {
    super(message)
    this.name = 'JsonScanError'
  }
}

type Scanner = { text: string; pos: number; out: ParsedFile }

function lineAt(text: string, pos: number): number {
  let line = 1
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function skipBlank(s: Scanner): void {
  for (;;) {
    const rest = s.text.slice(s.pos)
    const blank = /^\s+/.exec(rest)
    if (blank) {
      s.pos += blank[0].length
      continue
    }
    if (rest.startsWith('//')) {
      const end = s.text.indexOf('\n', s.pos)
      s.pos = end === -1 ? s.text.length : end
      continue
    }
    if (rest.startsWith('/*')) {
      const end = s.text.indexOf('*/', s.pos + 2)
      if (end === -1) throw new JsonScanError('unterminated comment')
      s.pos = end + 2
      continue
    }
    return
  }
}

function readString(s: Scanner): { value: string; start: number; end: number } {
  const start = s.pos
  const match = /^"(?:[^"\\\n]|\\.)*"/.exec(s.text.slice(start))
  if (!match) throw new JsonScanError(`bad string at line ${lineAt(s.text, start)}`)
  let decoded: unknown
  try {
    decoded = JSON.parse(match[0])
  } catch {
    throw new JsonScanError(`bad escape at line ${lineAt(s.text, start)}`)
  }
  if (typeof decoded !== 'string') throw new JsonScanError('bad string')
  s.pos = start + match[0].length
  return { value: decoded, start, end: s.pos }
}

function expect(s: Scanner, ch: string): void {
  skipBlank(s)
  if (s.text.charAt(s.pos) !== ch) {
    throw new JsonScanError(`expected "${ch}" at line ${lineAt(s.text, s.pos)}`)
  }
  s.pos++
}

function readValue(s: Scanner, path: string): void {
  skipBlank(s)
  const ch = s.text.charAt(s.pos)
  if (ch === '"') {
    const str = readString(s)
    s.out.entries.push({
      name: path,
      value: str.value,
      start: str.start,
      end: str.end,
      quote: 'double',
      line: lineAt(s.text, str.start),
    })
  } else if (ch === '{' || ch === '[') {
    readContainer(s, path, ch === '{')
  } else {
    const scalar = /^[^,\]}\s/]+/.exec(s.text.slice(s.pos))
    if (!scalar) throw new JsonScanError(`unexpected "${ch}" at line ${lineAt(s.text, s.pos)}`)
    s.pos += scalar[0].length
  }
}

function readContainer(s: Scanner, path: string, isObject: boolean): void {
  const close = isObject ? '}' : ']'
  s.pos++
  for (let index = 0; ; index++) {
    skipBlank(s)
    if (s.text.charAt(s.pos) === close) {
      s.pos++
      return
    }
    let childPath = `${path}${path ? '.' : ''}${index}`
    if (isObject) {
      const key = readString(s)
      childPath = `${path}${path ? '.' : ''}${key.value}`
      expect(s, ':')
    }
    readValue(s, childPath)
    skipBlank(s)
    if (s.text.charAt(s.pos) === ',') s.pos++
    else if (s.text.charAt(s.pos) !== close) {
      throw new JsonScanError(`expected "," or "${close}" at line ${lineAt(s.text, s.pos)}`)
    }
  }
}

function parseJson(content: string): ParsedFile {
  const out: ParsedFile = { entries: [], unmanaged: [] }
  const s: Scanner = { text: content, pos: 0, out }
  try {
    readValue(s, '')
  } catch (err) {
    // A file that does not scan is reported, never half-rewritten.
    if (!(err instanceof JsonScanError)) throw err
    return { entries: [], unmanaged: [{ name: '(file)', line: 1, reason: err.message }] }
  }
  return out
}

export const jsonFormat: FileFormat = {
  id: 'json',
  label: 'JSON secrets (Firebase, .NET user secrets)',
  injection: 'materialize',
  style: 'structured',
  matches: (path) => NAMES.has(baseName(path)),
  parse: parseJson,
  render: (value) => JSON.stringify(value),
  envName: (entry) => toUpperSnake(entry.name),
}
