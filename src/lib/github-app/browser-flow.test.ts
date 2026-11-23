/**
 * The local manifest server against a stubbed GitHub: the start page posts
 * to the organisation's new-App page, a redirect with the wrong state is
 * refused, and the right one is traded for the App and forwarded to its
 * install page.
 */
import { createVerify, generateKeyPairSync, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { signAppJwt } from '@/lib/github-app/app-api'
import { startManifestFlow, type ManifestFlow } from '@/lib/github-app/browser-flow'

const realFetch = globalThis.fetch
/** Random per run, so no key-shaped literal sits in the test. */
const RETURNED_KEY = `key-${randomUUID()}`
let flow: ManifestFlow | undefined

afterEach(() => {
  flow?.close()
  flow = undefined
  vi.unstubAllGlobals()
})

/** GitHub's conversion endpoint is stubbed; requests to the local server go through. */
function stubConversion(): string[] {
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init)
      seen.push(`${init?.method ?? 'GET'} ${url}`)
      return Response.json({
        id: 77,
        slug: 'cryptflare-acme',
        name: 'CryptFlare acme',
        owner: { login: 'acme' },
        pem: RETURNED_KEY,
        html_url: 'https://github.com/apps/cryptflare-acme',
      })
    }),
  )
  return seen
}

async function start(): Promise<ManifestFlow> {
  flow = await startManifestFlow({
    githubOrg: 'acme',
    appName: 'CryptFlare acme',
    permissions: { contents: 'read' },
  })
  return flow
}

function stateFrom(page: string): string {
  const state = /state=([0-9a-f]{32})/.exec(page)?.[1]
  if (!state) throw new Error('no state in the start page')
  return state
}

describe('startManifestFlow', () => {
  it('serves a page that posts the manifest to the organisation on GitHub', async () => {
    stubConversion()
    const { startUrl } = await start()
    const page = await (await fetch(startUrl)).text()
    expect(page).toContain('https://github.com/organizations/acme/settings/apps/new?state=')
    expect(page).toContain('name="manifest"')
    expect(page).toContain(`${startUrl}callback`)
  })

  it('refuses a redirect that does not carry this run state', async () => {
    const seen = stubConversion()
    const { startUrl } = await start()
    const res = await fetch(`${startUrl}callback?code=abc&state=forged`, { redirect: 'manual' })
    expect(res.status).toBe(400)
    expect(seen).toHaveLength(0)
  })

  it('trades the code for the App and forwards the browser to its install page', async () => {
    const seen = stubConversion()
    const current = await start()
    const state = stateFrom(await (await fetch(current.startUrl)).text())

    const res = await fetch(`${current.startUrl}callback?code=abc&state=${state}`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://github.com/apps/cryptflare-acme/installations/new',
    )
    expect(seen).toEqual(['POST https://api.github.com/app-manifests/abc/conversions'])
    const app = await current.app
    expect(app).toMatchObject({ id: '77', slug: 'cryptflare-acme', owner: 'acme' })
    expect(app.privateKey).toBe(RETURNED_KEY)

    // The code works once.
    const again = await fetch(`${current.startUrl}callback?code=abc&state=${state}`)
    expect(again.status).toBe(400)
  })
})

describe('signAppJwt', () => {
  it('signs with the PKCS#1 key GitHub issues', () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    const jwt = signAppJwt('77', pem, 1_800_000_000)
    const [header, payload, signature] = jwt.split('.')

    expect(JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())).toEqual({
      iat: 1_799_999_940,
      exp: 1_800_000_540,
      iss: '77',
    })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    expect(verifier.verify(pair.publicKey, Buffer.from(signature ?? '', 'base64url'))).toBe(true)
  })
})
