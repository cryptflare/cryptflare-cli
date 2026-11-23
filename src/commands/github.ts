/**
 * `cf github` - push CryptFlare environments to GitHub Actions secrets.
 *
 * `cf github connect` sets up one push per environment: it finds the
 * repository from the current directory's git remote, uses the GitHub CLI
 * (`gh`) to check you administer it and to create any GitHub environment
 * that is missing, makes sure the CryptFlare GitHub App is installed on the
 * owner, and creates the push connections. `gh` is only used for setup and
 * always as its own process; the pushes run through the GitHub App, so no
 * personal token is stored.
 *
 * Short-lived GitHub tokens for your own code are a different feature:
 * `cf dynamic github connect`.
 */

import chalk from 'chalk'
import { Command } from 'commander'
import open from 'open'

import type { CryptFlare } from '@cryptflare/sdk'
import { BRAND } from '../_vendored/brand'

import { getClient } from '@/lib/api'
import {
  alreadyConnected,
  collect,
  createEnvironment,
  findOwnerIntegration,
  installationSettingsUrl,
  listEnvironments,
  parseKeyList,
  parsePushTargets,
  splitRepo,
  viewRepo,
  type GitHubIntegration,
  type GitHubRepo,
} from '@/lib/github-push'
import * as output from '@/lib/output'
import * as progress from '@/lib/progress'
import { resolveContext, resolveOrg } from '@/lib/resolve'

const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const INSTALL_POLL_INTERVAL_MS = 3000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type ConnectOptions = {
  repo?: string
  env: string[]
  workspace?: string
  org?: string
  repositorySecrets?: boolean
  prefix?: string
  only?: string
  exclude?: string
  auto?: boolean
  push?: boolean
  createEnvironments: boolean
  browser: boolean
  json?: boolean
}

/** The repository through `gh`, or from `--repo` alone when `gh` is not there. */
function resolveRepo(repo: string | undefined): { repo: GitHubRepo; checked: boolean } {
  try {
    return { repo: viewRepo(repo), checked: true }
  } catch (err) {
    if (!repo) throw err
    output.warn(
      `${err instanceof Error ? err.message : String(err)} Going on without gh: GitHub environments are not checked or created.`,
    )
    return { repo: { ...splitRepo(repo), admin: false }, checked: false }
  }
}

/** Creates the GitHub environments the targets name that the repository lacks. */
function ensureGithubEnvironments(repo: GitHubRepo, wanted: string[], create: boolean): void {
  if (wanted.length === 0) return
  const existing = new Set(listEnvironments(repo).map((name) => name.toLowerCase()))
  const missing = wanted.filter((name) => !existing.has(name.toLowerCase()))
  if (missing.length === 0) return
  const where = `${repo.owner}/${repo.name}`
  if (!create) {
    throw new Error(
      `${where} has no GitHub environment ${missing.join(', ')}. Create it, or drop --no-create-environments.`,
    )
  }
  if (!repo.admin) {
    throw new Error(
      `${where} has no GitHub environment ${missing.join(', ')}, and creating one needs admin on the repository. Ask an admin, or create it in the repository settings.`,
    )
  }
  for (const name of missing) {
    createEnvironment(repo, name)
    output.success(`Created GitHub environment ${name} on ${where}`)
  }
}

/** The installation on the owner, sending the browser to install the App when there is none. */
async function ensureInstallation(
  client: CryptFlare,
  organisation: string,
  owner: string,
  browser: boolean,
): Promise<GitHubIntegration> {
  const list = async () => (await client.integrations.list({ organisation })).data
  const found = findOwnerIntegration(await list(), owner)
  if (found) return found

  const { data } = await client.integrations.githubInstallUrl({ organisation })
  output.print()
  output.print(`  ${chalk.bold(`Install the ${BRAND.name} GitHub App on ${owner}`)}`)
  output.print(
    chalk.dim(
      `  Pick the repositories it may push to. Use a browser signed in to the ${BRAND.name} dashboard: it records the install.`,
    ),
  )
  output.print(`  ${chalk.dim('Install:')} ${chalk.cyan(data.url)}`)
  if (browser) await open(data.url).catch(() => undefined)

  progress.start(`Waiting for the App to be installed on ${owner}...`)
  try {
    const deadline = Date.now() + INSTALL_TIMEOUT_MS
    while (Date.now() < deadline) {
      await sleep(INSTALL_POLL_INTERVAL_MS)
      const installed = findOwnerIntegration(await list(), owner)
      if (installed) {
        progress.succeed(`${BRAND.name} GitHub App installed on ${owner}`)
        return installed
      }
    }
  } finally {
    progress.stop()
  }
  throw new Error(`The App was not installed on ${owner} within 15 minutes. Run this again.`)
}

/** Refuses a repository the installation was not given access to. */
async function assertRepoReachable(
  client: CryptFlare,
  organisation: string,
  integration: GitHubIntegration,
  repo: GitHubRepo,
): Promise<void> {
  if (integration.repositorySelection !== 'selected') return
  const { data } = await client.integrations.listRepositories({
    organisation,
    integrationId: integration.id,
    q: repo.name,
  })
  const full = `${repo.owner}/${repo.name}`.toLowerCase()
  if (data.repos.some((r) => r.full_name.toLowerCase() === full)) return
  throw new Error(
    `The CryptFlare GitHub App cannot reach ${repo.owner}/${repo.name}. Add the repository to the installation at ${installationSettingsUrl(integration)}, then run this again.`,
  )
}

async function connect(opts: ConnectOptions): Promise<void> {
  const firstEnv = opts.env[0]?.split(':')[0]
  const context = resolveContext({
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    ...(opts.org ? { org: opts.org } : {}),
    ...(firstEnv ? { env: firstEnv } : {}),
  })
  const organisation = context.org
  const targets = parsePushTargets(opts.env, context.env, opts.repositorySecrets === true)
  const keyFilter = parseKeyList(opts.only)
  const excludeKeys = parseKeyList(opts.exclude)

  const { repo, checked } = resolveRepo(opts.repo)
  const where = `${repo.owner}/${repo.name}`
  if (checked) {
    const wanted = targets.flatMap((t) => (t.githubEnvironment ? [t.githubEnvironment] : []))
    ensureGithubEnvironments(repo, wanted, opts.createEnvironments)
  }

  const client = getClient()
  const workspaces = await client.workspaces.list({ organisation })
  const workspace = workspaces.find(
    (w) => w.slug === context.workspace || w.id === context.workspace,
  )
  if (!workspace) throw new Error(`No workspace ${context.workspace} in this organisation.`)
  const environments = await client.environments.list({ organisation, workspace: workspace.id })
  const resolved = targets.map((target) => {
    const environment = environments.find((e) => e.slug === target.env || e.id === target.env)
    if (!environment) throw new Error(`No environment ${target.env} in ${workspace.slug}.`)
    return { ...target, environment }
  })

  const integration = await ensureInstallation(client, organisation, repo.owner, opts.browser)
  await assertRepoReachable(client, organisation, integration, repo)

  const existing = (await client.syncConnections.list({ organisation })).data
  const created: Array<{ id: string; env: string; githubEnvironment: string | null }> = []
  const skipped: string[] = []
  for (const target of resolved) {
    if (alreadyConnected(existing, target.environment.id, repo, target.githubEnvironment)) {
      skipped.push(target.environment.slug)
      continue
    }
    const { data: connection } = await client.syncConnections.create({
      organisation,
      workspaceId: workspace.id,
      environmentId: target.environment.id,
      provider: 'github',
      authMethod: 'github_app',
      // The API mints a GitHub App installation token in its place.
      credentials: 'github_app',
      providerConfig: {
        owner: repo.owner,
        repo: repo.name,
        secretType: 'actions',
        ...(target.githubEnvironment ? { environment: target.githubEnvironment } : {}),
      },
      syncMode: opts.auto ? 'auto' : 'manual',
      ...(opts.prefix ? { keyPrefix: opts.prefix } : {}),
      ...(keyFilter ? { keyFilter } : {}),
      ...(excludeKeys ? { excludeKeys } : {}),
    })
    created.push({
      id: connection.id,
      env: target.environment.slug,
      githubEnvironment: target.githubEnvironment,
    })
  }

  if (opts.push) {
    for (const connection of created) {
      await client.syncConnections.trigger({ organisation, connectionId: connection.id })
    }
  }

  if (opts.json) return output.json({ repository: where, created, skipped })
  for (const connection of created) {
    const destination = connection.githubEnvironment
      ? `environment ${connection.githubEnvironment}`
      : 'repository secrets'
    output.success(`${connection.env} -> ${where} ${destination} (${connection.id})`)
  }
  for (const env of skipped) output.info(`${env} already pushes to ${where}; left as it is.`)
  if (created.length === 0) return
  output.print()
  output.print(
    opts.auto
      ? chalk.dim('  Pushes run on every change to these environments.')
      : chalk.dim(
          `  Push now with: cf github push ${created.map((c) => c.id).join(' ')}   (or pass --auto to push on every change)`,
        ),
  )
}

export const githubCommand = new Command('github').description(
  'Push environments to GitHub Actions secrets',
)

githubCommand
  .command('connect')
  .description('Push environments to a GitHub repository, set up through the GitHub CLI')
  .option('--repo <owner/name>', 'GitHub repository (default: this directory’s git remote)')
  .option(
    '-e, --env <env[:github-environment]>',
    'Environment to push, and the GitHub environment it goes to (repeatable)',
    collect,
    [],
  )
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('--repository-secrets', 'Push to repository secrets instead of a GitHub environment')
  .option('--prefix <PREFIX>', 'Prefix for secret names on GitHub')
  .option('--only <keys>', 'Push only these keys, comma separated')
  .option('--exclude <keys>', 'Never push these keys, comma separated')
  .option('--auto', 'Push on every change instead of on demand')
  .option('--push', 'Push once right after connecting')
  .option('--no-create-environments', 'Refuse instead of creating a missing GitHub environment')
  .option('--no-browser', 'Print the install URL instead of opening it')
  .option('-o, --org <id>', 'CryptFlare organisation ID')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  cf github connect --env staging --env production --auto
      push staging and production to the GitHub environments of the same names
  cf github connect --repo acme/api --env prod:production --only STRIPE_SECRET_KEY,DATABASE_URL
  cf github connect --env ci --repository-secrets --push

Needs the GitHub CLI signed in (gh auth login) to read the repository and
create GitHub environments. Its token stays with gh: pushes run through the
CryptFlare GitHub App on the repository owner, installed once in the browser.`,
  )
  .action(async (opts: ConnectOptions) => {
    try {
      await connect(opts)
    } catch (err) {
      progress.stop()
      output.handleError(err)
    }
  })

githubCommand
  .command('list')
  .description('List the pushes to GitHub')
  .option('-o, --org <id>', 'CryptFlare organisation ID')
  .option('--json', 'Output as JSON')
  .action(async (opts: { org?: string; json?: boolean }) => {
    try {
      const organisation = resolveOrg(opts)
      const connections = (await getClient().syncConnections.list({ organisation })).data.filter(
        (c) => c.provider === 'github',
      )
      if (opts.json) return output.json(connections)
      output.table(
        connections.map((c) => ({
          id: c.id,
          repository: `${String(c.providerConfig['owner'] ?? '')}/${String(c.providerConfig['repo'] ?? '')}`,
          'github environment': String(c.providerConfig['environment'] ?? '(repository)'),
          mode: c.syncMode,
          'last push': c.lastSyncStatus ?? 'never',
        })),
      )
    } catch (err) {
      output.handleError(err)
    }
  })

githubCommand
  .command('push <connectionIds...>')
  .description('Push now')
  .option('-o, --org <id>', 'CryptFlare organisation ID')
  .action(async (connectionIds: string[], opts: { org?: string }) => {
    try {
      const organisation = resolveOrg(opts)
      const client = getClient()
      for (const connectionId of connectionIds) {
        await client.syncConnections.trigger({ organisation, connectionId })
        output.success(`Push queued for ${connectionId}`)
      }
    } catch (err) {
      output.handleError(err)
    }
  })
