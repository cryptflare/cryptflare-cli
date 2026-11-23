/**
 * The GitHub App manifest `cf dynamic github connect` creates an App from.
 *
 * GitHub's manifest flow: a browser form posts the manifest to the
 * organisation's "new App" page, the person approves it there, and GitHub
 * redirects back with a one-time code the CLI exchanges for the App's id and
 * private key. See https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

import { BRAND } from '../../_vendored/brand'
import {
  GITHUB_APP_DYNAMIC,
  GITHUB_PERMISSION_LEVELS,
  GITHUB_PERMISSION_NAME_PATTERN,
  type GitHubPermissionLevel,
} from '@/lib/github-app/contract'

/** GitHub caps an App name at 34 characters. */
const MAX_APP_NAME_LENGTH = 34

export type GitHubPermissions = Record<string, GitHubPermissionLevel>

function isPermissionLevel(value: string): value is GitHubPermissionLevel {
  return (GITHUB_PERMISSION_LEVELS as readonly string[]).includes(value)
}

/**
 * Reads `contents:read,pull_requests:write` into `{ contents: 'read', pull_requests: 'write' }`.
 *
 * @throws Error naming the entry that is not `<name>:<read|write|admin>`.
 */
export function parsePermissionList(list: string | undefined): GitHubPermissions {
  if (list === undefined || list.trim() === '') return { ...GITHUB_APP_DYNAMIC.DEFAULT_PERMISSIONS }
  const permissions: GitHubPermissions = {}
  for (const entry of list.split(',')) {
    const [name = '', level = '', ...rest] = entry.trim().split(':')
    if (
      rest.length > 0 ||
      !GITHUB_PERMISSION_NAME_PATTERN.test(name) ||
      !isPermissionLevel(level)
    ) {
      throw new Error(
        `--permissions entry "${entry.trim()}" is not <name>:<read|write|admin>, for example contents:read.`,
      )
    }
    permissions[name] = level
  }
  return permissions
}

/** Reads `api,web` into repository names, or undefined for every repository the installation reaches. */
export function parseRepositoryList(list: string | undefined): string[] | undefined {
  if (list === undefined) return undefined
  const names = list
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (names.length === 0) return undefined
  if (names.length > GITHUB_APP_DYNAMIC.MAX_REPOSITORIES) {
    throw new Error(`--repos takes at most ${GITHUB_APP_DYNAMIC.MAX_REPOSITORIES} repositories.`)
  }
  // An owner/name entry is reduced to the name: tokens are scoped by name within the installation.
  return names.map((name) => name.slice(name.lastIndexOf('/') + 1))
}

export type ManifestInput = {
  name: string
  permissions: GitHubPermissions
  /** Where GitHub sends the browser with the code once the App is created. */
  redirectUrl: string
  /** Where GitHub sends the browser once the App is installed. */
  setupUrl: string
}

/**
 * A private App with no webhook and only the permissions the leases need.
 * `metadata: read` is added because GitHub grants it to every App anyway.
 */
export function buildAppManifest(input: ManifestInput) {
  return {
    name: input.name.slice(0, MAX_APP_NAME_LENGTH),
    url: BRAND.urls.website,
    description: `Short-lived tokens issued by ${BRAND.name} dynamic secrets.`,
    public: false,
    redirect_url: input.redirectUrl,
    setup_url: input.setupUrl,
    hook_attributes: { url: BRAND.urls.website, active: false },
    default_permissions: { metadata: 'read', ...input.permissions },
    default_events: [],
  }
}

/** The default App name: the brand and the organisation, inside GitHub's length limit. */
export function defaultAppName(githubOrg: string): string {
  return `${BRAND.name} ${githubOrg}`.slice(0, MAX_APP_NAME_LENGTH)
}

/** GitHub's "register an App from a manifest" page for an organisation. */
export function newAppUrl(githubOrg: string, state: string): string {
  const url = new URL(
    `/organizations/${encodeURIComponent(githubOrg)}/settings/apps/new`,
    GITHUB_APP_DYNAMIC.WEB_URL,
  )
  url.searchParams.set('state', state)
  return url.toString()
}

/** Where to install an App by its slug. */
export function installUrl(slug: string): string {
  return new URL(
    `/apps/${encodeURIComponent(slug)}/installations/new`,
    GITHUB_APP_DYNAMIC.WEB_URL,
  ).toString()
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/**
 * One HTML element with escaped attributes and text. The local pages are
 * built from these so no value, including the manifest, can break out of
 * its place in the markup.
 */
export function element(
  tag: string,
  attributes: Record<string, string> = {},
  text = '',
  children = '',
): string {
  const attrs = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('')
  return `<${tag}${attrs}>${escapeHtml(text)}${children}</${tag}>`
}

const PAGE_STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}'

/** A plain local page with a heading, a line of text and any extra markup. */
export function localPage(title: string, body: string, extra = ''): string {
  const head = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    element('title', {}, title),
    element('style', {}, '', PAGE_STYLE),
  ].join('')
  const content = element('h1', {}, title) + element('p', {}, body) + extra
  return `<!doctype html>${element('html', { lang: 'en' }, '', element('head', {}, '', head) + element('body', {}, '', content))}`
}

/** The page that posts the manifest to GitHub as soon as it loads. */
export function manifestFormPage(action: string, manifest: object): string {
  const fields =
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
    element('button', { type: 'submit' }, 'Continue to GitHub')
  const form = element('form', { method: 'post', action }, '', fields)
  const submit = element('script', {}, '', 'document.forms[0].submit()')
  return localPage('Creating the GitHub App', 'Sending you to GitHub to approve it.', form + submit)
}
