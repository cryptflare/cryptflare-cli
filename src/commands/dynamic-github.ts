/**
 * `cf dynamic github connect` - connect a GitHub organisation to dynamic secrets.
 *
 * Creates a GitHub App on the organisation from a manifest (one approval in
 * the browser), sends the browser on to install it, waits for the
 * installation, and saves a `github_app` dynamic secret config. Each lease
 * from that config is a GitHub installation token limited to the
 * repositories and permissions given here, revoked when the lease ends and
 * gone after an hour regardless.
 *
 * `--app-id` with `--private-key-file` uses an App that already exists
 * instead. `gh`, when installed and signed in, is only used to list the
 * person's organisations when `--github-org` is left out.
 */

import { readFileSync } from 'node:fs'

import chalk from 'chalk'
import { Command } from 'commander'
import open from 'open'
import prompts from 'prompts'

import { getClient } from '@/lib/api'
import {
  DYNAMIC_DEFAULT_MAX_CONCURRENT_LEASES,
  DYNAMIC_DEFAULT_MAX_LEASES_PER_IDENTITY,
  DYNAMIC_DEFAULT_TTL_SECONDS,
  DYNAMIC_MIN_TTL_SECONDS,
  GITHUB_APP_DYNAMIC,
  GITHUB_APP_PROVIDER,
  defaultAppName,
  findInstallation,
  getAppSlug,
  installUrl,
  listGhOrganisations,
  missingInstallationPermissions,
  parsePermissionList,
  parseRepositoryList,
  startManifestFlow,
  type AppInstallation,
  type CreatedApp,
} from '@/lib/github-app'
import * as output from '@/lib/output'
import * as progress from '@/lib/progress'
import { resolveOrg } from '@/lib/resolve'

const BROWSER_STEP_TIMEOUT_MS = 15 * 60 * 1000
const INSTALL_POLL_INTERVAL_MS = 3000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Opens a URL unless told not to; the URL is printed either way. */
async function offer(url: string, label: string, browser: boolean): Promise<void> {
  output.print(`  ${chalk.dim(`${label}:`)} ${chalk.cyan(url)}`)
  if (!browser) return
  try {
    await open(url)
  } catch {
    output.print(chalk.dim('  Open the URL above in your browser.'))
  }
}

/** `--github-org`, else the person's organisations from `gh`. */
async function pickGithubOrg(flag: string | undefined): Promise<string> {
  if (flag) return flag
  const orgs = listGhOrganisations()
  if (orgs === null) {
    output.usageError(
      'Pass --github-org <login> to name the GitHub organisation.',
      'Or sign in to the GitHub CLI (`gh auth login`) and the CLI lists your organisations.',
    )
  }
  if (orgs.length === 0) {
    output.usageError(
      'The GitHub CLI shows no organisations for your account. Pass --github-org <login>.',
    )
  }
  if (orgs.length === 1 && orgs[0]) {
    output.info(`Using ${orgs[0]}, your only organisation in the GitHub CLI.`)
    return orgs[0]
  }
  if (!process.stdin.isTTY) {
    output.usageError(`Pass --github-org with one of: ${orgs.join(', ')}.`)
  }
  const answer: { org?: string } = await prompts({
    type: 'select',
    name: 'org',
    message: 'Which GitHub organisation?',
    choices: orgs.map((login) => ({ title: login, value: login })),
  })
  if (!answer.org) output.usageError('No organisation chosen.')
  return answer.org
}

async function waitForInstallation(
  appId: string,
  privateKey: string,
  githubOrg: string,
): Promise<AppInstallation> {
  const deadline = Date.now() + BROWSER_STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    const installation = await findInstallation(appId, privateKey, githubOrg)
    if (installation) return installation
    await sleep(INSTALL_POLL_INTERVAL_MS)
  }
  throw new Error(`The App was not installed on ${githubOrg} within 15 minutes.`)
}

type ConnectOptions = {
  githubOrg?: string
  name?: string
  permissions?: string
  repos?: string
  appName?: string
  appId?: string
  privateKeyFile?: string
  ttl?: string
  browser: boolean
  org?: string
  json?: boolean
}

function readTtl(value: string | undefined): number {
  if (value === undefined)
    return Math.min(DYNAMIC_DEFAULT_TTL_SECONDS, GITHUB_APP_DYNAMIC.MAX_TTL_SECONDS)
  const ttl = Number(value)
  if (
    !Number.isInteger(ttl) ||
    ttl < DYNAMIC_MIN_TTL_SECONDS ||
    ttl > GITHUB_APP_DYNAMIC.MAX_TTL_SECONDS
  ) {
    throw new Error(
      `--ttl must be a whole number of seconds from ${DYNAMIC_MIN_TTL_SECONDS} to ${GITHUB_APP_DYNAMIC.MAX_TTL_SECONDS}; GitHub tokens last an hour at most.`,
    )
  }
  return ttl
}

/** A new App through the manifest flow, then its installation. */
async function createAndInstall(
  githubOrg: string,
  opts: ConnectOptions,
  permissions: ReturnType<typeof parsePermissionList>,
): Promise<{ app: CreatedApp; installation: AppInstallation }> {
  const flow = await startManifestFlow({
    githubOrg,
    appName: opts.appName ?? defaultAppName(githubOrg),
    permissions,
  })
  try {
    output.print()
    output.print(`  ${chalk.bold('1. Create the GitHub App')}`)
    output.print(
      chalk.dim(
        `  GitHub asks you to approve an App on ${githubOrg} with ${Object.keys(permissions).join(', ')}. You can rename it there.`,
      ),
    )
    await offer(flow.startUrl, 'Open', opts.browser)
    progress.start('Waiting for the App to be created on GitHub...')
    const app = await withTimeout(
      flow.app,
      BROWSER_STEP_TIMEOUT_MS,
      'The App was not created within 15 minutes. Run the command again.',
    )
    progress.succeed(`Created GitHub App ${app.name} (ID ${app.id}) on ${app.owner}`)

    output.print()
    output.print(`  ${chalk.bold(`2. Install it on ${githubOrg}`)}`)
    output.print(
      chalk.dim('  Your browser moves on to the install page. Pick the repositories it may reach.'),
    )
    output.print(`  ${chalk.dim('Install:')} ${chalk.cyan(installUrl(app.slug))}`)
    progress.start(`Waiting for the App to be installed on ${githubOrg}...`)
    const installation = await waitForInstallation(app.id, app.privateKey, githubOrg)
    progress.succeed(`Installed on ${installation.account} (installation ${installation.id})`)
    return { app, installation }
  } finally {
    progress.stop()
    flow.close()
  }
}

/** An App that already exists: find its installation, asking for one if there is none. */
async function useExistingApp(
  githubOrg: string,
  appId: string,
  privateKey: string,
  browser: boolean,
): Promise<AppInstallation> {
  const installation = await findInstallation(appId, privateKey, githubOrg)
  if (installation) return installation
  output.print(`  App ${appId} is not installed on ${githubOrg} yet.`)
  await offer(installUrl(await getAppSlug(appId, privateKey)), 'Install', browser)
  progress.start(`Waiting for the App to be installed on ${githubOrg}...`)
  try {
    const found = await waitForInstallation(appId, privateKey, githubOrg)
    progress.succeed(`Installed on ${found.account} (installation ${found.id})`)
    return found
  } finally {
    progress.stop()
  }
}

export const dynamicGithubCommand = new Command('github').description(
  'Short-lived GitHub tokens from a GitHub App on your organisation',
)

dynamicGithubCommand
  .command('connect')
  .description('Create and install a GitHub App on an organisation and save it as a dynamic secret')
  .option('--github-org <login>', 'GitHub organisation (default: pick from `gh`)')
  .option('--name <name>', 'Name of the dynamic secret config (default: github-<org>)')
  .option(
    '--permissions <list>',
    'Token permissions as name:level, comma separated',
    'contents:read',
  )
  .option('--repos <list>', 'Limit tokens to these repositories (default: all the App can reach)')
  .option('--ttl <seconds>', 'Default lease length, 60 to 3600 (default: 1800)')
  .option('--app-name <name>', 'Name for the new GitHub App (default: CryptFlare <org>)')
  .option('--app-id <id>', 'Use this existing GitHub App instead of creating one')
  .option('--private-key-file <path>', 'Private key (.pem) of the App given with --app-id')
  .option('--no-browser', 'Print the URLs instead of opening them')
  .option('-o, --org <id>', 'CryptFlare organisation ID')
  .option('--json', 'Output as JSON')
  .addHelpText(
    'after',
    `
Examples:
  cf dynamic github connect --github-org acme
      create an App with contents:read on every repository it is installed on
  cf dynamic github connect --github-org acme --repos api,web \\
      --permissions contents:write,pull_requests:write
  cf dynamic github connect --github-org acme --app-id 123456 --private-key-file app.pem
      use an App you already have

Then: cf dynamic issue github-acme --save --prefix GITHUB   stores GITHUB_TOKEN

Creating an App on an organisation needs an owner of it, or an App manager.
The App's private key is sent once to CryptFlare and encrypted there; it is
never written to disk here.`,
  )
  .action(async (opts: ConnectOptions) => {
    let createdApp: CreatedApp | undefined
    try {
      const organisation = resolveOrg(opts)
      const permissions = parsePermissionList(opts.permissions)
      const repositories = parseRepositoryList(opts.repos)
      const defaultTtl = readTtl(opts.ttl)
      if (opts.appId && !opts.privateKeyFile) {
        throw new Error('--app-id needs --private-key-file with the App private key.')
      }
      if (opts.appId && !/^\d+$/.test(opts.appId)) throw new Error('--app-id must be a number.')
      const githubOrg = await pickGithubOrg(opts.githubOrg)
      const name = opts.name ?? `github-${githubOrg.toLowerCase()}`
      const client = getClient()

      // Checked before anything is created on GitHub: a clash or a missing
      // permission here would leave an App on the organisation for nothing.
      const existing = (await client.dynamicSecrets.listConfigs({ organisation })).data
      if (existing.some((config) => config.name === name)) {
        throw new Error(`A dynamic secret config named "${name}" already exists. Pass --name.`)
      }

      let appId: string
      let privateKey: string
      let installation: AppInstallation
      if (opts.appId && opts.privateKeyFile) {
        appId = opts.appId
        privateKey = readFileSync(opts.privateKeyFile, 'utf8')
        installation = await useExistingApp(githubOrg, appId, privateKey, opts.browser)
      } else {
        const result = await createAndInstall(githubOrg, opts, permissions)
        createdApp = result.app
        appId = result.app.id
        privateKey = result.app.privateKey
        installation = result.installation
      }

      const missing = missingInstallationPermissions(permissions, installation.permissions)
      if (missing.length > 0) {
        throw new Error(
          `The installation on ${githubOrg} does not hold ${missing.join(', ')}. ` +
            "Add them in the App's permissions, approve the change on the organisation, then run this again with --app-id.",
        )
      }

      progress.start('Saving the dynamic secret config...')
      const { data: config } = await client.dynamicSecrets.createConfig({
        organisation,
        name,
        description: `GitHub App ${appId} on ${githubOrg}`,
        provider: GITHUB_APP_PROVIDER,
        providerConfig: {
          installationId: installation.id,
          owner: installation.account,
          permissions,
          ...(repositories ? { repositories } : {}),
        },
        rootCredentials: { appId, privateKey },
        defaultTtlSeconds: defaultTtl,
        maxTtlSeconds: GITHUB_APP_DYNAMIC.MAX_TTL_SECONDS,
        systemMaxTtlSeconds: GITHUB_APP_DYNAMIC.MAX_TTL_SECONDS,
        maxConcurrentLeases: DYNAMIC_DEFAULT_MAX_CONCURRENT_LEASES,
        maxLeasesPerIdentity: DYNAMIC_DEFAULT_MAX_LEASES_PER_IDENTITY,
      })
      progress.stop()

      if (opts.json) {
        return output.json({
          configId: config.id,
          name,
          githubOrg: installation.account,
          appId,
          installationId: installation.id,
        })
      }
      output.success(`Saved dynamic secret "${name}" for ${installation.account}`)
      output.print()
      output.print(`  ${chalk.dim('Issue a token:')}   cf dynamic issue ${name}`)
      output.print(
        `  ${chalk.dim('Store it:')}        cf dynamic issue ${name} --save --prefix GITHUB`,
      )
      output.print(chalk.dim('  Tokens last for the lease, an hour at most.'))
    } catch (err) {
      progress.stop()
      if (createdApp) {
        // The key only ever lived in memory; say how to recover without it.
        output.printError(
          chalk.yellow('!') +
            ` GitHub App ${createdApp.name} (ID ${createdApp.id}) was created but not saved to CryptFlare.` +
            `\n  Generate a private key in its settings (${GITHUB_APP_DYNAMIC.WEB_URL}/organizations/${createdApp.owner}/settings/apps/${createdApp.slug}), then run:` +
            `\n  cf dynamic github connect --github-org ${createdApp.owner} --app-id ${createdApp.id} --private-key-file <key.pem>`,
        )
      }
      output.handleError(err)
    }
  })
