/**
 * Finds every local-secrets file in a repository for `cf env migrate` and
 * `cf env status`: the formats the registry knows, templates (never
 * touched), and files that look secret-bearing but no format claims, listed
 * for a person to review.
 */

import { readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, relative, sep } from 'node:path'

import {
  detectFormat,
  isLeftoverPath,
  isTemplatePath,
  type FileFormat,
} from '@/lib/local-env/formats'
import { looksHighEntropy, looksSecretName } from '@/lib/local-env/names'
import {
  isComposeFile,
  isKustomizeFile,
  readReferences,
  type YamlFinding,
} from '@/lib/local-env/references'

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.output',
  '.turbo',
  '.wrangler',
  '.venv',
  'venv',
  '__pycache__',
  'vendor',
  'target',
  '.terraform',
  '.cache',
  '.pnpm-store',
  'bower_components',
])

const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|go\.sum|[^/]*\.lock)$/i
const SECRET_FILE =
  /(^|\/)([^/]*(secret|credential)[^/]*|[^/]*\.(pem|p12|pfx|jks|keystore|ppk)|id_(rsa|ed25519|ecdsa)[^/]*|service[-_]?account[^/]*\.json|[^/]*\.key)$/i
const CONFIG_FILE = /\.(json|ya?ml|toml|ini|cfg|conf|properties|xml|env)$/i
const ASSIGNMENT = /^\s*["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*["']?([^"'\s,#]+)/
const MAX_SEARCH_DEPTH = 6
const MAX_SNIFF_BYTES = 64 * 1024

export type ScannedFile = { rel: string; format: FileFormat }
export type ReviewItem = { rel: string; reason: string }

export type RepositoryScan = {
  files: ScannedFile[]
  templates: string[]
  review: ReviewItem[]
  /** Literal secrets in docker-compose `environment:` maps. */
  composeInline: Array<YamlFinding & { rel: string }>
}

function walk(root: string): string[] {
  const found: string[] = []
  const visit = (dir: string, depth: number) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // Unreadable directory: nothing of ours to find there.
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_SEARCH_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) visit(full, depth + 1)
      } else if (entry.isFile()) {
        found.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  visit(root, 0)
  return found.sort()
}

function sniff(root: string, rel: string): string | null {
  const path = join(root, rel)
  try {
    if (statSync(path).size > MAX_SNIFF_BYTES) return null
    return readFileSync(path, 'utf-8')
  } catch {
    return null
  }
}

/** A secret-looking name with a high-entropy literal value, in an unclaimed config file. */
function secretAssignment(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line)
    if (!match) continue
    const [, name = '', value = ''] = match
    if (looksSecretName(name) && looksHighEntropy(value))
      return `${name} holds a high-entropy value`
  }
  return null
}

/** Scans a repository. Reads only small config files, never lockfiles or dependencies. */
export function scanRepository(root: string): RepositoryScan {
  const all = walk(root).filter((rel) => !LOCKFILE.test(rel) && !isLeftoverPath(rel))
  const referenced = new Set<string>()
  const composeInline: RepositoryScan['composeInline'] = []

  for (const rel of all) {
    const name = rel.split('/').pop() ?? rel
    if (!isComposeFile(name) && !isKustomizeFile(name)) continue
    const content = sniff(root, rel)
    if (content === null) continue
    const refs = readReferences(rel, content)
    for (const file of refs.envFiles) referenced.add(file)
    composeInline.push(...refs.inlineSecrets.map((finding) => ({ ...finding, rel })))
  }

  const scan: RepositoryScan = { files: [], templates: [], review: [], composeInline }
  for (const rel of all) {
    const format = detectFormat(rel, referenced)
    if (format) {
      scan.files.push({ rel, format })
      continue
    }
    if (isTemplatePath(rel)) {
      if (detectFormat(rel.replace(/\.(example|sample|template|tpl|dist|defaults|hbs)/i, ''))) {
        scan.templates.push(rel)
      }
      continue
    }
    if (SECRET_FILE.test(rel)) {
      scan.review.push({ rel, reason: 'file name suggests a key or credentials' })
      continue
    }
    if (CONFIG_FILE.test(rel)) {
      const content = sniff(root, rel)
      const reason = content === null ? null : secretAssignment(content)
      if (reason) scan.review.push({ rel, reason })
    }
  }
  return scan
}
