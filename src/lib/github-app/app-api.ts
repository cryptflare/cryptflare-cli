/**
 * The GitHub REST calls `cf dynamic github connect` makes from this machine.
 *
 * Only two kinds: exchanging the manifest code for the new App (no auth, the
 * code is the proof), and reading the App's installations as the App itself
 * (a JWT signed locally with its private key). No GitHub token of the
 * person's is used, and the private key never leaves memory except in the
 * request that hands it to CryptFlare.
 */

import { createSign } from 'node:crypto'

import { GITHUB_APP_DYNAMIC } from '@/lib/github-app/contract'

const REQUEST_TIMEOUT_MS = 30_000
const JWT_BACKDATE_SECONDS = 60
const JWT_LIFETIME_SECONDS = 540

export type CreatedApp = {
  id: string
  slug: string
  name: string
  owner: string
  htmlUrl: string
  /** PEM. Held in memory only. */
  privateKey: string
}

export type AppInstallation = {
  id: number
  account: string
  permissions: Record<string, string>
  repositorySelection: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/** Signs the RS256 JWT GitHub accepts from an App, with the key GitHub issued (PKCS#1 or PKCS#8). */
export function signAppJwt(
  appId: string,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64url(
    JSON.stringify({
      iat: nowSeconds - JWT_BACKDATE_SECONDS,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
      iss: appId,
    }),
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${payload}`)
  return `${header}.${payload}.${signer.sign(privateKey).toString('base64url')}`
}

async function github(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${GITHUB_APP_DYNAMIC.API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_APP_DYNAMIC.API_VERSION,
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    const hint =
      res.status === 401
        ? 'the App credentials were refused'
        : res.status === 404
          ? 'not found; the code may have expired (they last an hour) or been used already'
          : `HTTP ${res.status}`
    throw new Error(`GitHub ${init.method ?? 'GET'} ${path.split('?')[0]} failed: ${hint}`)
  }
  return res.json()
}

/** Trades the one-time manifest code for the new App, its id and private key. */
export async function convertManifestCode(code: string): Promise<CreatedApp> {
  const body = await github(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
  })
  if (!isRecord(body)) throw new Error('GitHub returned no App for the manifest code.')
  const owner = isRecord(body['owner']) ? text(body['owner']['login']) : undefined
  const id = typeof body['id'] === 'number' ? String(body['id']) : undefined
  const slug = text(body['slug'])
  const privateKey = text(body['pem'])
  if (!id || !slug || !privateKey || !owner) {
    throw new Error('GitHub returned an App without an id, slug, owner or private key.')
  }
  return {
    id,
    slug,
    owner,
    privateKey,
    name: text(body['name']) ?? slug,
    htmlUrl: text(body['html_url']) ?? `${GITHUB_APP_DYNAMIC.WEB_URL}/apps/${slug}`,
  }
}

const asApp = (appId: string, privateKey: string) => ({
  headers: { Authorization: `Bearer ${signAppJwt(appId, privateKey)}` },
})

/** The App's own slug, needed to send someone to its install page. */
export async function getAppSlug(appId: string, privateKey: string): Promise<string> {
  const body = await github('/app', asApp(appId, privateKey))
  const slug = isRecord(body) ? text(body['slug']) : undefined
  if (!slug) throw new Error('GitHub returned the App without a slug.')
  return slug
}

function readInstallation(value: unknown): AppInstallation | null {
  if (!isRecord(value) || typeof value['id'] !== 'number' || !isRecord(value['account'])) {
    return null
  }
  const account = text(value['account']['login'])
  if (!account) return null
  const permissions: Record<string, string> = {}
  if (isRecord(value['permissions'])) {
    for (const [name, level] of Object.entries(value['permissions'])) {
      if (typeof level === 'string') permissions[name] = level
    }
  }
  return {
    id: value['id'],
    account,
    permissions,
    repositorySelection: text(value['repository_selection']) ?? 'all',
  }
}

/** The App's installation on `githubOrg`, or null while it is not installed there. */
export async function findInstallation(
  appId: string,
  privateKey: string,
  githubOrg: string,
): Promise<AppInstallation | null> {
  const body = await github('/app/installations?per_page=100', asApp(appId, privateKey))
  const installations = Array.isArray(body) ? body.map(readInstallation) : []
  return (
    installations.find(
      (installation) => installation?.account.toLowerCase() === githubOrg.toLowerCase(),
    ) ?? null
  )
}
