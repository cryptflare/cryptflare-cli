import { Command } from 'commander'
import chalk from 'chalk'
import prompts from 'prompts'

import { getClient } from '@/lib/api'
import { getToken, setOrg, setDefault, getConfigPath } from '@/lib/config'
import * as output from '@/lib/output'
import * as progress from '@/lib/progress'
import { MANIFEST_FILENAME, hasManifest } from '@/lib/project-manifest'
import { EXIT_CODES } from '@/lib/exit-codes'
import { BRAND } from '../_vendored/brand'

type Org = { id: string; name: string; plan?: string }
type Workspace = { id: string; name: string; slug: string }
type Environment = { id: string; name: string; slug: string }

export const initCommand = new Command('init')
  .description(
    'Account setup wizard - picks org/workspace/environment and saves them as CLI defaults (for a repo, see `cf sync init`)',
  )
  .option('-o, --org <id>', 'Skip the org picker and use this organisation ID')
  .option('-w, --workspace <slug>', 'Skip the workspace picker and use this slug')
  .option('-e, --env <slug>', 'Skip the environment picker and use this slug')
  .option('-y, --yes', 'Accept first match at every step (non-interactive defaults)')
  .addHelpText(
    'after',
    `
This is the account setup wizard: it picks an organisation, workspace and
environment and saves them as CLI defaults.

It is NOT the command for setting up a repository. For a project that has a
committed ${MANIFEST_FILENAME}, use:

  cf sync init            pull every bound file and register for sync
  cf sync init --create   also create the workspaces and environments it names
`,
  )
  .action(async (opts) => {
    try {
      banner()

      // Two commands are called `init`, and the wrong one gives a clean help
      // screen with no hint you are in the wrong place. Someone lost real time
      // to exactly that, so say it here rather than only in --help.
      // Informational, not a block: running the auth wizard inside a project
      // is perfectly reasonable, and it is what you need before `cf sync init`
      // can work at all.
      if (hasManifest(process.cwd())) {
        output.warn(`This directory has a ${MANIFEST_FILENAME}.`)
        output.printError(
          chalk.dim('  That file is read by ') +
            chalk.cyan('cf sync init') +
            chalk.dim(', which pulls every bound file and registers the project.\n') +
            chalk.dim(
              '  This wizard only saves org/workspace/environment defaults. Carrying on.\n',
            ),
        )
      }

      // 1. Auth ------------------------------------------------------------
      if (!getToken()) {
        output.printError(
          chalk.dim('  No saved credentials. Run `cf auth login` first, then re-run `cf init`.'),
        )
        output.print()
        process.exit(EXIT_CODES.AUTH)
      }

      const client = getClient()

      // 2. Org -------------------------------------------------------------
      const org = await chooseOrg(client, opts)
      if (!org) return
      setOrg(org.id)
      output.success(`Active organisation: ${chalk.bold(org.name)}`)

      // 3. Workspace --------------------------------------------------------
      const workspace = await chooseWorkspace(client, org.id, opts)
      if (!workspace) return
      setDefault('defaults.workspace', workspace.slug)
      output.success(`Default workspace: ${chalk.bold(workspace.name)} (${workspace.slug})`)

      // 4. Environment -----------------------------------------------------
      const environment = await chooseEnvironment(client, org.id, workspace.slug, opts)
      if (!environment) return
      setDefault('defaults.environment', environment.slug)
      output.success(`Default environment: ${chalk.bold(environment.name)} (${environment.slug})`)

      // 5. Done ------------------------------------------------------------
      output.print()
      output.print(chalk.bold('  All set.'))
      output.print(chalk.dim(`  Saved to ${getConfigPath()}`))
      output.print()
      output.print('  Try:')
      output.print(`    ${chalk.cyan('cf secret list')}`)
      output.print(`    ${chalk.cyan('cf whoami')}`)
      output.print(`    ${chalk.cyan('cf doctor')}`)
      output.print()
    } catch (err) {
      output.handleError(err)
    }
  })

function banner() {
  output.print()
  output.print(`  ${chalk.bold('CryptFlare CLI - setup wizard')}`)
  output.print(
    chalk.dim('  Saves a default org / workspace / environment so you can stop typing the flags.'),
  )
  output.print()
}

async function chooseOrg(
  client: ReturnType<typeof getClient>,
  opts: { org?: string; yes?: boolean },
): Promise<Org | undefined> {
  if (opts.org) {
    return { id: opts.org, name: opts.org }
  }
  progress.start('Loading organisations...')
  const orgs = await client.organisations.list()
  progress.stop()
  if (!orgs.length) {
    output.printError(
      chalk.yellow(
        `  You are not a member of any organisation. Visit ${BRAND.urls.app}/onboarding to create one.`,
      ),
    )
    return undefined
  }
  if (orgs.length === 1 || opts.yes) {
    return orgs[0]
  }
  const { picked } = await prompts({
    type: 'select',
    name: 'picked',
    message: 'Pick an organisation',
    choices: orgs.map((o) => ({
      title: o.name,
      description: o.plan ? `plan: ${o.plan} - ${o.id}` : o.id,
      value: o.id,
    })),
  })
  if (!picked) {
    output.print(chalk.dim('  Cancelled.'))
    return undefined
  }
  return orgs.find((o) => o.id === picked)
}

async function chooseWorkspace(
  client: ReturnType<typeof getClient>,
  organisation: string,
  opts: { workspace?: string; yes?: boolean },
): Promise<Workspace | undefined> {
  if (opts.workspace) {
    return { id: opts.workspace, name: opts.workspace, slug: opts.workspace }
  }
  progress.start('Loading workspaces...')
  const workspaces = await client.workspaces.list({ organisation })
  progress.stop()
  if (!workspaces.length) {
    output.printError(
      chalk.yellow(
        '  No workspaces in this organisation. Create one in the dashboard or via `cf workspace create`.',
      ),
    )
    return undefined
  }
  if (workspaces.length === 1 || opts.yes) {
    return workspaces[0]
  }
  const { picked } = await prompts({
    type: 'select',
    name: 'picked',
    message: 'Pick a default workspace',
    choices: workspaces.map((w) => ({ title: w.name, description: w.slug, value: w.id })),
  })
  if (!picked) {
    output.print(chalk.dim('  Cancelled.'))
    return undefined
  }
  return workspaces.find((w) => w.id === picked)
}

async function chooseEnvironment(
  client: ReturnType<typeof getClient>,
  organisation: string,
  workspace: string,
  opts: { env?: string; yes?: boolean },
): Promise<Environment | undefined> {
  if (opts.env) {
    return { id: opts.env, name: opts.env, slug: opts.env }
  }
  progress.start('Loading environments...')
  const envs = await client.environments.list({ organisation, workspace })
  progress.stop()
  if (!envs.length) {
    output.printError(
      chalk.yellow('  No environments in this workspace. Create one via `cf environment create`.'),
    )
    return undefined
  }
  if (envs.length === 1 || opts.yes) {
    return envs[0]
  }
  const { picked } = await prompts({
    type: 'select',
    name: 'picked',
    message: 'Pick a default environment',
    choices: envs.map((e) => ({ title: e.name, description: e.slug, value: e.id })),
  })
  if (!picked) {
    output.print(chalk.dim('  Cancelled.'))
    return undefined
  }
  return envs.find((e) => e.id === picked)
}
