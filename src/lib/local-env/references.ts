/**
 * Dotenv files that docker-compose and kustomize read themselves, found by
 * reading their YAML line by line (no YAML values are ever rewritten), plus
 * literal secrets in compose `environment:` maps, which are only reported.
 */

import { posix } from 'node:path'

import { isReference, looksSecretName } from '@/lib/local-env/names'

export type YamlFinding = { name: string; line: number }

export type References = {
  /** Referenced dotenv files, relative to the repository root. */
  envFiles: string[]
  /** Literal secret-looking values in `environment:` maps: review by hand. */
  inlineSecrets: YamlFinding[]
}

const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i
const KUSTOMIZE = /^kustomization\.ya?ml$/i

export function isComposeFile(name: string): boolean {
  return COMPOSE.test(name)
}

export function isKustomizeFile(name: string): boolean {
  return KUSTOMIZE.test(name)
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/\s+#.*$/, '')
    .replace(/^["']|["']$/g, '')
}

/** Values of a key that holds a scalar, an inline list, or a block list (`- x`, `- path: x`). */
function listValues(lines: readonly string[], key: RegExp): string[] {
  const found: string[] = []
  lines.forEach((line, i) => {
    const match = key.exec(line)
    if (!match) return
    const inline = (match[1] ?? '').trim()
    if (inline.startsWith('[')) {
      found.push(
        ...inline
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map(unquote)
          .filter(Boolean),
      )
      return
    }
    if (inline) {
      found.push(unquote(inline))
      return
    }
    const base = indentOf(line)
    for (const next of lines.slice(i + 1)) {
      if (next.trim() === '' || next.trimStart().startsWith('#')) continue
      if (indentOf(next) <= base && !next.trimStart().startsWith('-')) break
      const item = /^\s*-\s*(?:path:\s*)?(.+)$/.exec(next)
      if (!item) {
        if (indentOf(next) <= base) break
        continue
      }
      found.push(unquote(item[1] ?? ''))
    }
  })
  return found
}

/** `environment:` entries with a literal, secret-looking value. */
function inlineSecretsOf(lines: readonly string[]): YamlFinding[] {
  const findings: YamlFinding[] = []
  lines.forEach((line, i) => {
    if (!/^\s*environment:\s*$/.test(line)) return
    const base = indentOf(line)
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? ''
      if (next.trim() === '') continue
      if (indentOf(next) <= base) break
      const pair = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*(.+)$/.exec(next)
      if (!pair) continue
      const value = unquote(pair[2] ?? '')
      if (value && !isReference(value) && !value.includes('${') && looksSecretName(pair[1] ?? '')) {
        findings.push({ name: pair[1] ?? '', line: j + 1 })
      }
    }
  })
  return findings
}

/**
 * Reads one compose or kustomize file.
 *
 * @param file Path of the YAML file relative to the repository root.
 */
export function readReferences(file: string, content: string): References {
  const dir = posix.dirname(file)
  const lines = content.split(/\r?\n/)
  const name = posix.basename(file)
  const raw = isKustomizeFile(name)
    ? listValues(lines, /^\s*-?\s*envs?:\s*(.*)$/)
    : listValues(lines, /^\s*env_file:\s*(.*)$/)
  const envFiles = raw
    .filter((value) => value && !value.includes('${'))
    .map((value) => posix.normalize(posix.join(dir, value)))
    .filter((value) => !value.startsWith('..'))
  return { envFiles, inlineSecrets: isKustomizeFile(name) ? [] : inlineSecretsOf(lines) }
}
