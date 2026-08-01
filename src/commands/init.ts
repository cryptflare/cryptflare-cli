import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';

import { getClient } from '../lib/api.js';
import { getToken, setOrg, setDefault, getConfigPath } from '../lib/config.js';
import * as output from '../lib/output.js';
import * as progress from '../lib/progress.js';
import { MANIFEST_FILENAME, hasManifest } from '../lib/project-manifest.js';

type Org = { id: string; name: string; plan?: string };
type Workspace = { id: string; name: string; slug: string };
type Environment = { id: string; name: string; slug: string };

export const initCommand = new Command('init')
  .description('Account setup wizard - picks org/workspace/environment and saves them as CLI defaults (for a repo, see `cf sync init`)')
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
      banner();

      // Two commands are called `init`, and the wrong one gives a clean help
      // screen with no hint you are in the wrong place. Someone lost real time
      // to exactly that, so say it here rather than only in --help.
      // Informational, not a block: running the auth wizard inside a project
      // is perfectly reasonable, and it is what you need before `cf sync init`
      // can work at all.
      if (hasManifest(process.cwd())) {
        output.warn(`This directory has a ${MANIFEST_FILENAME}.`);
        console.error(
          chalk.dim('  That file is read by ')
            + chalk.cyan('cf sync init')
            + chalk.dim(', which pulls every bound file and registers the project.\n')
            + chalk.dim('  This wizard only saves org/workspace/environment defaults. Carrying on.\n'),
        );
      }

      // 1. Auth ------------------------------------------------------------
      if (!getToken()) {
        console.log(chalk.dim('  No saved credentials. Run `cf auth login` first, then re-run `cf init`.'));
        console.log();
        process.exit(1);
      }

      const client = getClient();

      // 2. Org -------------------------------------------------------------
      const org = await chooseOrg(client, opts);
      if (!org) return;
      setOrg(org.id);
      output.success(`Active organisation: ${chalk.bold(org.name)}`);

      // 3. Workspace --------------------------------------------------------
      const workspace = await chooseWorkspace(client, org.id, opts);
      if (!workspace) return;
      setDefault('defaults.workspace', workspace.slug);
      output.success(`Default workspace: ${chalk.bold(workspace.name)} (${workspace.slug})`);

      // 4. Environment -----------------------------------------------------
      const environment = await chooseEnvironment(client, org.id, workspace.slug, opts);
      if (!environment) return;
      setDefault('defaults.environment', environment.slug);
      output.success(`Default environment: ${chalk.bold(environment.name)} (${environment.slug})`);

      // 5. Done ------------------------------------------------------------
      console.log();
      console.log(chalk.bold('  All set.'));
      console.log(chalk.dim(`  Saved to ${getConfigPath()}`));
      console.log();
      console.log('  Try:');
      console.log(`    ${chalk.cyan('cf secret list')}`);
      console.log(`    ${chalk.cyan('cf whoami')}`);
      console.log(`    ${chalk.cyan('cf doctor')}`);
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

function banner() {
  console.log();
  console.log(`  ${chalk.bold('CryptFlare CLI - setup wizard')}`);
  console.log(chalk.dim('  Saves a default org / workspace / environment so you can stop typing the flags.'));
  console.log();
}

async function chooseOrg(client: ReturnType<typeof getClient>, opts: { org?: string; yes?: boolean }): Promise<Org | undefined> {
  if (opts.org) {
    return { id: opts.org, name: opts.org };
  }
  progress.start('Loading organisations...');
  const orgs = await client.organisations.list() as Org[];
  progress.stop();
  if (!orgs.length) {
    console.log(chalk.yellow('  You are not a member of any organisation. Visit https://vault.cryptflare.com/onboarding to create one.'));
    return undefined;
  }
  if (orgs.length === 1 || opts.yes) {
    return orgs[0];
  }
  const { picked } = await prompts({
    type: 'select',
    name: 'picked',
    message: 'Pick an organisation',
    choices: orgs.map((o) => ({
      title: o.name,
      description: o.plan ? `plan: ${o.plan} - ${o.id}` : o.id,
      value: o,
    })),
  });
  if (!picked) {
    console.log(chalk.dim('  Cancelled.'));
    return undefined;
  }
  return picked as Org;
}

async function chooseWorkspace(client: ReturnType<typeof getClient>, organisation: string, opts: { workspace?: string; yes?: boolean }): Promise<Workspace | undefined> {
  if (opts.workspace) {
    return { id: opts.workspace, name: opts.workspace, slug: opts.workspace };
  }
  progress.start('Loading workspaces...');
  const workspaces = await client.workspaces.list({ organisation }) as Workspace[];
  progress.stop();
  if (!workspaces.length) {
    console.log(chalk.yellow('  No workspaces in this organisation. Create one in the dashboard or via `cf workspace create`.'));
    return undefined;
  }
  if (workspaces.length === 1 || opts.yes) {
    return workspaces[0];
  }
  const { picked } = await prompts({
    type: 'select',
    name: 'picked',
    message: 'Pick a default workspace',
    choices: workspaces.map((w) => ({ title: w.name, description: w.slug, value: w })),
  });
  if (!picked) {
    console.log(chalk.dim('  Cancelled.'));
    return undefined;
  }
  return picked as Workspace;
}

async function chooseEnvironment(client: ReturnType<typeof getClient>, organisation: string, workspace: string, opts: { env?: string; yes?: boolean }): Promise<Environment | undefined> {
  if (opts.env) {
    return { id: opts.env, name: opts.env, slug: opts.env };
  }
  progress.start('Loading environments...');
  const envs = await client.environments.list({ organisation, workspace }) as Environment[];
  progress.stop();
  if (!envs.length) {
    console.log(chalk.yellow('  No environments in this workspace. Create one via `cf environment create`.'));
    return undefined;
  }
  if (envs.length === 1 || opts.yes) {
    return envs[0];
  }
  const { picked } = await prompts({
    type: 'select',
    name: 'picked',
    message: 'Pick a default environment',
    choices: envs.map((e) => ({ title: e.name, description: e.slug, value: e })),
  });
  if (!picked) {
    console.log(chalk.dim('  Cancelled.'));
    return undefined;
  }
  return picked as Environment;
}
