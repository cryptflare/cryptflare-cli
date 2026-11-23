/**
 * Package-registry credentials in `.npmrc` and `.yarnrc.yml`.
 *
 * These are never encrypted in place: npm and Yarn would send the ciphertext
 * as the token. Both expand `${VAR}` from the environment, so the token moves
 * to CryptFlare and the file points at the variable `cf run` provides.
 */

import { baseName } from '@/lib/local-env/formats/env-formats'
import type { FileEntry, FileFormat, ParsedFile } from '@/lib/local-env/formats/types'

/** `//registry.npmjs.org/:_authToken=...`, `_auth=...`, `//host/:_password=...`. */
const NPMRC = /^([ \t]*)((?:\/\/[^\s=]*:)?(_authToken|_auth|_password))[ \t]*=[ \t]*/
/** `npmAuthToken: ...`, `npmAuthIdent: ...` at any depth. */
const YARNRC = /^([ \t]*)(npmAuthToken|npmAuthIdent)[ \t]*:[ \t]*/

function hostOf(name: string): string {
  const host = /^\/\/([^/:]+)/.exec(name)?.[1]
  return host ?? ''
}

function parseRegistry(content: string, pattern: RegExp): ParsedFile {
  const parsed: ParsedFile = { entries: [], unmanaged: [] }
  let offset = 0
  content.split('\n').forEach((text, i) => {
    const lineStart = offset
    offset += text.length + 1
    const match = pattern.exec(text)
    if (!match || text.trimStart().startsWith('#')) return
    const raw = text.slice(match[0].length).replace(/\r$/, '').trimEnd()
    const quoted = /^(["'])(.*)\1$/.exec(raw)
    const value = quoted ? (quoted[2] ?? '') : raw
    if (value === '') return
    const start = lineStart + match[0].length
    parsed.entries.push({
      name: match[2] ?? '',
      value,
      start,
      end: start + raw.length,
      quote: quoted ? (quoted[1] === '"' ? 'double' : 'single') : 'none',
      line: i + 1,
    })
  })
  return parsed
}

/** `NPM_TOKEN` for the public registry, `NPM_TOKEN_<HOST>` for any other. */
function tokenVariable(entry: FileEntry): string {
  const host = hostOf(entry.name)
  if (host === '' || host === 'registry.npmjs.org' || host === 'registry.yarnpkg.com') {
    return 'NPM_TOKEN'
  }
  return `NPM_TOKEN_${host.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

export const registryAuthFormat: FileFormat = {
  id: 'registry-auth',
  label: 'package registry token',
  injection: 'none',
  style: 'registry',
  matches: (path) => ['.npmrc', '.yarnrc.yml'].includes(baseName(path)),
  parse: (content) =>
    parseRegistry(content, /npmAuth(Token|Ident)[ \t]*:/.test(content) ? YARNRC : NPMRC),
  render: (value, entry) => {
    if (entry.quote === 'double') return `"${value}"`
    return entry.quote === 'single' ? `'${value}'` : value
  },
  envName: tokenVariable,
}
