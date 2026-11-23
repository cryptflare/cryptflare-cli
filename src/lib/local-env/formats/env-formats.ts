/**
 * The dotenv family: `.env*`, `.flaskenv`, wrangler's `.dev.vars*`, direnv's
 * `.envrc`, and dotenv files named by docker-compose or kustomize.
 *
 * All four share one parser and one renderer; they differ in which paths they
 * claim and in how `cf run` delivers the values.
 */

import { parseDotenv, renderDotenv } from '@/lib/local-env/formats/dotenv-parse'
import type { FileEntry, FileFormat } from '@/lib/local-env/formats/types'

export function baseName(path: string): string {
  return (path.split('/').pop() ?? path).toLowerCase()
}

const envName = (entry: FileEntry): string => entry.name

/** `.env`, `.env.local`, `.env.development`, `.env.<name>`, `.env.<name>.local`, `.flaskenv`. */
export const dotenvFormat: FileFormat = {
  id: 'dotenv',
  label: 'dotenv',
  injection: 'env',
  style: 'env',
  matches: (path) => {
    const name = baseName(path)
    return name === '.env' || name.startsWith('.env.') || name === '.flaskenv'
  },
  parse: parseDotenv,
  render: renderDotenv,
  envName,
}

/** Wrangler's `.dev.vars` and `.dev.vars.<env>`. */
export const devVarsFormat: FileFormat = {
  id: 'dev-vars',
  label: 'wrangler .dev.vars',
  injection: 'env',
  style: 'env',
  matches: (path) => {
    const name = baseName(path)
    return name === '.dev.vars' || name.startsWith('.dev.vars.')
  },
  parse: parseDotenv,
  render: renderDotenv,
  envName,
}

/** direnv's `.envrc`: a shell script whose `export KEY=value` lines are managed. */
export const envrcFormat: FileFormat = {
  id: 'envrc',
  label: 'direnv .envrc',
  injection: 'env',
  style: 'env',
  matches: (path) => baseName(path) === '.envrc',
  parse: parseDotenv,
  render: renderDotenv,
  envName,
}

/**
 * A dotenv file that docker-compose (`env_file:`) or kustomize
 * (`secretGenerator` `envs:`) reads itself. Never matched by name: the
 * reference scanner assigns it, whatever the file is called.
 */
export const composeEnvFormat: FileFormat = {
  id: 'compose-env',
  label: 'dotenv read by docker-compose / kustomize',
  injection: 'materialize',
  style: 'env',
  matches: () => false,
  parse: parseDotenv,
  render: renderDotenv,
  envName,
}
