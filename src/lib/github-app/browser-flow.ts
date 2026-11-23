/**
 * The local half of the GitHub App manifest flow.
 *
 * A server on 127.0.0.1 serves the page that posts the manifest to GitHub,
 * takes GitHub's redirect back with the one-time code, trades the code for
 * the App and sends the browser straight on to the App's install page. A
 * random `state` ties the redirect to this run, so a code from anywhere else
 * is refused.
 */

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { convertManifestCode, type CreatedApp } from '@/lib/github-app/app-api'
import {
  buildAppManifest,
  installUrl,
  localPage,
  manifestFormPage,
  newAppUrl,
  type GitHubPermissions,
} from '@/lib/github-app/manifest'

const LOOPBACK = '127.0.0.1'

export type ManifestFlow = {
  /** The local page to open; it forwards to GitHub. */
  startUrl: string
  /** Settles once GitHub has redirected back and the App exists. */
  app: Promise<CreatedApp>
  close(): void
}

export type ManifestFlowInput = {
  githubOrg: string
  appName: string
  permissions: GitHubPermissions
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(html)
}

/** Starts the local server. Nothing is sent to GitHub until the start page is opened. */
export async function startManifestFlow(input: ManifestFlowInput): Promise<ManifestFlow> {
  const state = randomBytes(16).toString('hex')
  let settle: { resolve(app: CreatedApp): void; reject(err: Error): void } | undefined
  const app = new Promise<CreatedApp>((resolve, reject) => {
    settle = { resolve, reject }
  })
  let done = false
  let base = ''

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base || `http://${LOOPBACK}`)

    if (url.pathname === '/') {
      const manifest = buildAppManifest({
        name: input.appName,
        permissions: input.permissions,
        redirectUrl: `${base}/callback`,
        setupUrl: `${base}/installed`,
      })
      return send(res, 200, manifestFormPage(newAppUrl(input.githubOrg, state), manifest))
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code')
      if (done || !code || url.searchParams.get('state') !== state) {
        return send(
          res,
          400,
          localPage('Not this run', 'This link is not from the setup running in your terminal.'),
        )
      }
      done = true
      convertManifestCode(code).then(
        (created) => {
          settle?.resolve(created)
          res.writeHead(302, { Location: installUrl(created.slug), 'Cache-Control': 'no-store' })
          res.end()
        },
        (err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err))
          settle?.reject(error)
          send(res, 502, localPage('The App was not created', error.message))
        },
      )
      return
    }

    if (url.pathname === '/installed') {
      return send(
        res,
        200,
        localPage('Installed', 'The App is installed. Go back to your terminal to finish.'),
      )
    }

    return send(res, 404, localPage('Not found', 'Nothing here.'))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, () => resolve())
  })
  const address: AddressInfo | string | null = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('The local setup server did not get a port.')
  }
  base = `http://${LOOPBACK}:${address.port}`

  return {
    startUrl: `${base}/`,
    app,
    close: () => server.close(),
  }
}
