/**
 * `cf sync` - multi-project, bidirectional env-file sync plus the background
 * service that runs it unattended (systemd, launchd, or a Windows task).
 *
 * Distinct from the older top-level `cf pull` / `cf push` / `cf daemon`, which
 * operate on a single file passed by flag and hold no state between runs. This
 * group reads a registry of projects, keeps a merge base per bound file, and is
 * designed to be the thing systemd starts and forgets about.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { Command } from 'commander';
import chalk from 'chalk';
import prompts from 'prompts';

import { getClient } from '../lib/api.js';
import { getOrg, getDefault } from '../lib/config.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { CAPTURE_MODES, isCaptureMode, type CaptureMode } from '../lib/capture.js';
import { launchdLogPath, launchdPlistPath, renderLaunchdPlist } from '../lib/service/launchd.js';
import type { ServiceSpec } from '../lib/service/spec.js';
import {
  quoteWindowsArg,
  renderWindowsLauncher,
  WINDOWS_TASK_NAME,
  windowsCreateTaskArgs,
  windowsLauncherPath,
  windowsLogPath,
} from '../lib/service/windows.js';
import { pendingRepositories } from '../lib/auto-onboard.js';
import { assertNoBindingCollisions, collidingFiles, describeCollision, findBindingCollisions } from '../lib/binding-collisions.js';
import { buildManifest, findEnvFiles, isEnvFileName, planBindings } from '../lib/discover.js';
import { watchFiles, type DirectoryWatch, type FileWake } from '../lib/file-wake.js';
import { needsLoginMessage } from '../lib/login-state.js';
import { describePlanRefusal, isPlanLimitError, provisionWithinPlan, upgradeHint } from '../lib/plan-allowance.js';
import { findNewBindings, rediscoverProjects, type RediscoverReport } from '../lib/rediscover.js';
import { gitFileStates, type GitFileState } from '../lib/git-state.js';
import { loadManifestCapture, resolveCapture } from '../lib/sync-capture.js';
import {
  applyPlan,
  countActionable,
  planBinding,
  type ApplyResult,
  type BindingPlan,
  type SyncAction,
} from '../lib/sync-engine.js';
import {
  bindingFilePath,
  getRegistryPath,
  loadRegistry,
  saveRegistry,
  type SyncBinding,
  type SyncProject,
  type SyncRegistry,
} from '../lib/sync-registry.js';
import { getStatePath, loadState, saveState } from '../lib/sync-state.js';
import { revealSecrets } from '../lib/reveal.js';
import { newScopeCache, seedFromValues } from '../lib/provision.js';
import { applyEnvChanges, parseEnvContent, renderEnvFile, toValueMap } from '../lib/env-file.js';
import { MANIFEST_FILENAME, hasManifest, loadManifest, writeManifest } from '../lib/project-manifest.js';

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 15;
const BACKOFF_CEILING_MS = 600_000;
const BACKOFF_MULTIPLIER = 2;
const NO_CHANGE_GRACE = 5;
const JITTER_PCT = 0.1;
const SERVICE_NAME = 'cryptflare-sync.service';
/** Consecutive passes in which every binding was refused as unauthenticated before the loop gives up. */
const AUTH_FAILURE_LIMIT = 3;
/** sysexits EX_CONFIG. The unit lists it under RestartPreventExitStatus. */
const EXIT_NEEDS_LOGIN = 78;
/** How often the watch loop looks for repositories to set up under the auto roots. */
const ONBOARD_INTERVAL_MS = 600_000;
/** How long a repository that failed to set up is left alone before another try. */
const ONBOARD_RETRY_MS = 3_600_000;
/**
 * The least time between two looks for new env files in registered
 * repositories, when nothing on disk said to look. A file event skips it.
 */
const REDISCOVER_MIN_INTERVAL_MS = 30_000;

function jittered(ms: number): number {
  return Math.max(5_000, Math.round(ms + ms * JITTER_PCT * (Math.random() * 2 - 1)));
}

function parseCaptureOption(value: unknown): CaptureMode | undefined {
  if (value === undefined) return undefined;
  if (!isCaptureMode(value)) {
    throw new Error(`--capture must be one of ${CAPTURE_MODES.join(', ')} (got "${String(value)}")`);
  }
  return value;
}

function selectProjects(projectId?: string): SyncProject[] {
  const registry = loadRegistry();
  const enabled = registry.projects.filter((p) => p.enabled);
  if (!projectId) return enabled;
  const match = registry.projects.find((p) => p.id === projectId);
  if (!match) {
    throw new Error(`No project "${projectId}" in ${getRegistryPath()}. Run \`cf sync list\`.`);
  }
  return [match];
}

// ---------------------------------------------------------------------------
// Automatic setup of repositories under the named roots
// ---------------------------------------------------------------------------

/** Repositories that failed to set up, and when each may be tried again. */
const onboardRetryAt = new Map<string, number>();
/** The last reason logged per repository, so an hourly retry that fails the same way stays quiet. */
const onboardReasonLogged = new Map<string, string>();

/**
 * Sets up every repository under the auto roots that is not registered yet.
 *
 * Each one is set up by running this CLI's own `sync init`, in a child
 * process: the exact path a person would take by hand, with its own exit
 * code, so one repository that cannot be set up (a plan limit, a bad file)
 * cannot take the others or the sync loop down with it.
 *
 * @returns how many repositories were set up.
 */
function isRegisteredPath(path: string): boolean {
  try {
    return loadRegistry().projects.some((project) => resolve(project.path) === resolve(path));
  } catch {
    return false;
  }
}

function onboardPending(): number {
  const pending = pendingRepositories(loadRegistry()).filter((repo) => (onboardRetryAt.get(repo.path) ?? 0) <= Date.now());
  let done = 0;

  for (const repo of pending) {
    const args = ['sync', 'init', repo.path, '--yes', ...(repo.action === 'create' ? ['--create'] : [])];
    const result = spawnSync(process.execPath, [process.argv[1] ?? 'cf', ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // The last line the child printed is its summary or its error. Its
    // output never holds a secret value, but only that one line is repeated.
    const lastLine = (text: string | null | undefined) => (text ?? '').split('\n').map((line) => line.trim()).filter(Boolean).pop();
    // Errors and the plan-limit summary go to stderr, so that is read first.
    const reason = (lastLine(result.stderr) ?? lastLine(result.stdout) ?? `exit ${result.status}`).slice(0, 400);

    if (result.status === 0) {
      done += 1;
      onboardRetryAt.delete(repo.path);
      onboardReasonLogged.delete(repo.path);
      console.error(chalk.green(`[auto] set up ${repo.path}${repo.action === 'create' ? ' (new: manifest written, files uploaded)' : ' (files pulled)'}`));
    } else if (isRegisteredPath(repo.path)) {
      // Part of it was set up: a plan limit or one bad file kept some files
      // out. It is registered, so it is not looked at here again, and the
      // files left out are picked up by the sync pass when they can be.
      done += 1;
      onboardRetryAt.delete(repo.path);
      console.error(chalk.yellow(`[auto] set up ${repo.path}, but not all of it. ${reason}`));
    } else {
      onboardRetryAt.set(repo.path, Date.now() + ONBOARD_RETRY_MS);
      // Said once per repository, not once an hour for as long as a plan
      // limit stands.
      if (onboardReasonLogged.get(repo.path) !== reason) {
        onboardReasonLogged.set(repo.path, reason);
        console.error(chalk.yellow(`[auto] could not set up ${repo.path}: ${reason} - trying again every hour`));
      }
    }
  }
  return done;
}

const autoCommand = new Command('auto')
  .description('Set up every repository under a directory automatically, now and as new ones appear')
  .argument('[directory]', 'Directory that holds your repositories, e.g. ~/code')
  .option('--remove', 'Stop setting up repositories under this directory (already set up projects are kept)')
  .addHelpText(
    'after',
    `
Run once per machine:

  cf sync auto ~/code
  cf sync install-service --enable

After that there is nothing to run per project. Any git repository under
~/code that has a .env, .dev.vars or .envrc gets a ${MANIFEST_FILENAME}, its own
workspace, and its files uploaded and kept in sync. A fresh clone that already
has a ${MANIFEST_FILENAME} gets its env files pulled.

This uploads the env files of every repository under the directory without
asking again. Name only directories whose repositories are yours.`,
  )
  .action((directory: string | undefined, opts) => {
    try {
      const registry = loadRegistry();
      const roots = new Set(registry.roots ?? []);

      if (!directory) {
        if (roots.size === 0) {
          output.info(`No automatic directories. Add one with ${chalk.cyan('cf sync auto <directory>')}.`);
          return;
        }
        for (const root of roots) console.log(`  ${root}`);
        const waiting = pendingRepositories(registry);
        console.log();
        console.log(chalk.dim(`  ${waiting.length} repository(ies) waiting to be set up on the next sync pass.`));
        return;
      }

      const root = resolve(directory);
      if (opts.remove) {
        if (!roots.delete(root)) throw new Error(`${root} is not an automatic directory.`);
        saveRegistry({ ...registry, roots: [...roots] });
        output.success(`Stopped setting up repositories under ${chalk.bold(root)}. Projects already set up are unchanged.`);
        return;
      }

      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`);
      roots.add(root);
      const next = { ...registry, roots: [...roots] };
      saveRegistry(next);

      const waiting = pendingRepositories(next);
      output.success(`Repositories under ${chalk.bold(root)} are now set up automatically.`);
      console.log();
      if (waiting.length === 0) {
        console.log(chalk.dim('  Nothing to set up right now.'));
      } else {
        console.log(`  ${waiting.length} to set up on the next pass:`);
        for (const repo of waiting.slice(0, 20)) {
          console.log(`    ${repo.path} ${chalk.dim(repo.action === 'create' ? '(new: env files will be uploaded)' : '(has a manifest: files will be pulled)')}`);
        }
        if (waiting.length > 20) console.log(chalk.dim(`    ...and ${waiting.length - 20} more`));
      }
      console.log();
      console.log(`  Do it now:        ${chalk.cyan('cf sync run')}`);
      console.log(`  Keep it running:  ${chalk.cyan('cf sync install-service --enable')}`);
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// cf sync add
// ---------------------------------------------------------------------------

const addCommand = new Command('add')
  .description('Register a project directory so the sync service manages its env files')
  .argument('[path]', 'Project root (defaults to the current directory)', '.')
  .option('--id <id>', 'Project identifier (defaults to the directory name)')
  .option('-o, --org <id>', 'Organisation ID (defaults to the CLI default)')
  .option('-w, --workspace <slug>', 'Workspace slug (defaults to the CLI default)')
  .option(
    '-b, --bind <file=[workspace/]environment...>',
    'Bind an env file. Repeatable: --bind .env=dev --bind apps/web/.env=peak-web/dev',
  )
  .option(
    '--capture <mode>',
    `What to do with new local keys: ${CAPTURE_MODES.join(' | ')} (default off). \`auto\` creates them in CryptFlare.`,
  )
  .action(async (pathArg: string, opts) => {
    try {
      const root = resolve(pathArg);
      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`);

      if (hasManifest(root) && !opts.bind) {
        // The repo already carries its mapping; re-deriving it from flags is
        // how the two drift apart.
        output.warn(`${root} has a ${MANIFEST_FILENAME}. Use ${chalk.cyan('cf sync init')} to register from it.`);
        console.log();
      }

      const org = opts.org ?? getOrg();
      const capture = parseCaptureOption(opts.capture);

      const bindArgs: string[] = opts.bind ?? [];
      if (bindArgs.length === 0) {
        // Default binding uses the CLI's default environment for `.env`, which
        // is the single-environment case most projects start from.
        const env = getDefault('environment');
        if (!env) {
          throw new Error('No bindings given. Pass --bind .env=<environment> (repeatable).');
        }
        bindArgs.push(`.env=${env}`);
      }

      const bindings = bindArgs.map((raw): SyncBinding => {
        const idx = raw.lastIndexOf('=');
        if (idx <= 0) throw new Error(`Invalid --bind "${raw}". Expected <file>=[workspace/]<environment>.`);
        const file = raw.slice(0, idx);
        const target = raw.slice(idx + 1);

        // `workspace/environment` targets a different workspace per binding,
        // which is how one monorepo maps each app to its own access boundary.
        const slash = target.indexOf('/');
        if (slash > 0) {
          return {
            file,
            workspace: target.slice(0, slash),
            environment: target.slice(slash + 1),
            ...(capture ? { capture } : {}),
          };
        }
        return { file, environment: target, ...(capture ? { capture } : {}) };
      });

      // Only needed as a default for bindings that did not name their own.
      const workspace = opts.workspace ?? getDefault('workspace');
      if (!workspace && bindings.some((b) => !b.workspace)) {
        throw new Error(
          'No workspace. Pass --workspace, set one with `cf config set defaults.workspace <slug>`, ' +
            'or qualify each binding as --bind <file>=<workspace>/<environment>.',
        );
      }

      // Two files in one environment overwrite each other on every pass.
      assertNoBindingCollisions(bindings, workspace);

      const id = opts.id ?? basename(root);
      const registry = loadRegistry();
      const existingIdx = registry.projects.findIndex((p) => p.id === id);
      const project: SyncProject = {
        id,
        path: root,
        ...(org ? { org } : {}),
        ...(workspace ? { workspace } : {}),
        enabled: true,
        bindings,
      };

      if (existingIdx >= 0) registry.projects[existingIdx] = project;
      else registry.projects.push(project);
      saveRegistry(registry);

      output.success(`${existingIdx >= 0 ? 'Updated' : 'Registered'} ${chalk.bold(id)} -> ${root}`);
      for (const b of bindings) {
        const marker = existsSync(join(root, b.file)) ? chalk.dim('(exists)') : chalk.yellow('(will be created)');
        console.log(`    ${b.file} ${chalk.dim('->')} ${b.workspace ?? workspace}/${b.environment} ${marker}`);
      }
      console.log();
      console.log(chalk.dim(`  Registry: ${getRegistryPath()}`));
      console.log(`  Preview:  ${chalk.cyan(`cf sync status --project ${id}`)}`);
      console.log(`  Run once: ${chalk.cyan(`cf sync run --project ${id}`)}`);
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// cf sync list / remove / enable / disable
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// cf sync init - the fresh-clone path
// ---------------------------------------------------------------------------

const initCommand = new Command('init')
  .description('Set a project up for sync. Uses its committed .cryptflare.json, or proposes one from the env files it finds')
  .argument('[path]', 'Project root (defaults to the current directory)', '.')
  .option('--write', 'Generate .cryptflare.json from this project\'s existing sync registration instead')
  .option('--no-pull', 'Register for sync without pulling files first')
  .option('--no-register', 'Pull files without registering for ongoing sync')
  .option('-p, --project <id>', 'Which registered project to write from, when several share this directory')
  .option('--id <id>', 'Register under this id instead of the manifest\'s, for a second checkout of the same repo')
  .option('--create', 'Create any workspace or environment the manifest names but CryptFlare does not have, then push each local file up. For a project that has never been synced.')
  .option('-y, --yes', 'Write a proposed .cryptflare.json without asking')
  .addHelpText(
    'after',
    `
In a repository with no ${MANIFEST_FILENAME}, this finds the env files, proposes
a manifest (one environment per file, named <app>-<stage>) and writes it once
you agree. New project, start to finish:

  cf sync init --create --yes`,
  )
  .action(async (pathArg: string, opts) => {
    try {
      const root = resolve(pathArg);
      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`);

      if (opts.write) {
        writeManifestFromRegistry(root, opts.project);
        return;
      }

      let wroteManifest = false;
      if (!hasManifest(root)) {
        // A repository that has never been set up: work the manifest out
        // from the env files in it instead of asking for one to be written
        // by hand.
        const written = await proposeManifest(root, { assumeYes: Boolean(opts.yes) });
        if (!written) return;
        wroteManifest = true;
        if (!opts.create) {
          console.log(`  Next: ${chalk.cyan('cf sync init --create')}   ${chalk.dim('# creates the workspace and environments, uploads each file')}`);
          console.log();
          return;
        }
      }

      const manifest = loadManifest(root);
      const id = opts.id ?? manifest.id ?? basename(root);
      const org = manifest.org ?? getOrg();

      console.log();
      console.log(`  ${chalk.bold(id)} ${chalk.dim(`(${manifest.bindings.length} file(s) from ${MANIFEST_FILENAME})`)}`);
      console.log();

      // Pull first, then register. Registering first would make the initial
      // sync pass see empty local files and treat every remote key as new -
      // correct, but it logs a pull of everything rather than a clean adopt.
      // Collected rather than thrown: a bootstrap that dies on the first
      // unreachable environment leaves a half-populated clone and no clue
      // which files are missing. Every binding is attempted, failures are
      // listed at the end, and the exit code still reports failure.
      const failures: Array<{ file: string; message: string }> = [];

      // Two files bound to one environment are refused, and the rest of the
      // manifest is set up as usual.
      const collisions = findBindingCollisions(manifest.bindings, manifest.workspace);
      const collided = collidingFiles(collisions);
      for (const collision of collisions) {
        console.log(`  ${chalk.red('✗')} ${chalk.red(describeCollision(collision))}`);
        for (const file of collision.files) failures.push({ file, message: `shares environment ${collision.target} with another file` });
      }
      const bindings = manifest.bindings.filter((binding) => !collided.has(binding.file));
      /**
       * Files whose environment could not be created (no room in the plan, or
       * the request failed). Not registered, so no pass fails on an
       * environment that does not exist.
       */
      const unprovisioned = new Set<string>();
      let planLine = '';

      // First-time setup: build the remote structure from the manifest and
      // seed it from what is already on disk. Without this the only path was
      // `cf workspace create` plus one `cf environment create` per environment
      // by hand, and skipping it made the pull fail with "workspace not found".
      if (opts.create) {
        await requirePermission('secrets:write');
        const client = getClient();
        const scopeCache = newScopeCache();
        let madeWs = 0;
        let madeEnv = 0;
        let pushed = 0;

        // What the manifest needs is compared with what the plan has left
        // before anything is created, so a plan limit leaves out whole files
        // in a known order instead of failing partway.
        const provisioned = await provisionWithinPlan(
          client,
          org,
          bindings.map((binding) => ({ file: binding.file, workspace: binding.workspace!, environment: binding.environment! })),
          scopeCache,
        );
        for (const item of provisioned.failed) {
          unprovisioned.add(item.file);
          failures.push({ file: item.file, message: item.message });
          console.log(`  ${chalk.red('✗')} ${item.file} ${chalk.red(item.message.slice(0, 90))}`);
        }
        for (const item of provisioned.refused) {
          unprovisioned.add(item.file);
          console.log(`  ${chalk.yellow('✗')} ${item.file} ${chalk.yellow(`not taken over: plan limit on ${item.resource}`)}`);
        }
        if (provisioned.refused.length > 0) planLine = describePlanRefusal(provisioned.refused, provisioned.allowance);

        for (const item of provisioned.ready) {
          const scope = { ...(org ? { organisation: org } : {}), workspace: item.workspace, environment: item.environment };
          const { createdWorkspace, createdEnvironment } = item;
          const binding = { file: item.file, workspace: item.workspace, environment: item.environment };
          try {
            if (createdWorkspace) madeWs++;
            if (createdEnvironment) madeEnv++;

            const target = join(root, binding.file);
            const values = existsSync(target)
              ? toValueMap(parseEnvContent(readFileSync(target, 'utf-8')))
              : new Map<string, string>();
            const { created, updated } = await seedFromValues(client, scope, values);
            pushed += created + updated;

            const marks = [
              createdWorkspace ? chalk.green('+workspace') : '',
              createdEnvironment ? chalk.green('+environment') : '',
              created > 0 ? chalk.green(`+${created} secret(s)`) : '',
              updated > 0 ? chalk.blue(`~${updated} secret(s)`) : '',
            ].filter(Boolean).join(' ');
            console.log(
              `  ${chalk.green('✓')} ${binding.file} ${chalk.dim(`-> ${binding.workspace}/${binding.environment}`)}`
                + (marks ? ` ${marks}` : chalk.dim(' (already set up)')),
            );
          } catch (err) {
            const message = (err as Error).message ?? String(err);
            failures.push({ file: binding.file, message });
            console.log(`  ${chalk.red('✗')} ${binding.file} ${chalk.red(message.slice(0, 90))}`);
          }
        }

        console.log();
        output.success(
          `Created ${madeWs} workspace(s), ${madeEnv} environment(s), pushed ${pushed} secret(s).`,
        );
        // Local files are already the source here, so pulling them straight
        // back would be a no-op at best and a needless reveal at worst.
        opts.pull = false;
      }

      if (opts.pull !== false) {
        await requirePermission('secrets:read');
        const client = getClient();

        for (const binding of bindings) {
          try {
          const target = join(root, binding.file);
          const scope = {
            ...(org ? { organisation: org } : {}),
            workspace: binding.workspace!,
            environment: binding.environment!,
            ...(binding.pod ? { podId: binding.pod } : {}),
          };

          const secrets = await revealSecrets(client, scope);

          mkdirSync(dirname(target), { recursive: true });
          if (existsSync(target)) {
            // Merge rather than clobber: a cloned repo may ship a template
            // file, and overwriting it would drop any comment or unmanaged
            // line the author put there.
            const original = readFileSync(target, 'utf-8');
            const parsed = parseEnvContent(original);
            const updates = new Map<string, string>();
            const additions = new Map<string, string>();
            for (const [k, v] of secrets) {
              if (parsed.entries.has(k)) updates.set(k, v);
              else additions.set(k, v);
            }
            const { content } = applyEnvChanges(original, updates, additions);
            if (content !== original) writeFileSync(target, content, { encoding: 'utf-8', mode: 0o600 });
          } else {
            writeFileSync(target, renderEnvFile(secrets, '# Pulled by CryptFlare (cf sync init)'), {
              encoding: 'utf-8',
              mode: 0o600,
            });
          }

          console.log(
            `  ${chalk.green('✓')} ${binding.file} ${chalk.dim(`<- ${binding.workspace}/${binding.environment}`)} ` +
              `${chalk.dim(`(${secrets.size} secret(s))`)}`,
          );
          } catch (err) {
            const message = (err as Error).message ?? String(err);
            failures.push({ file: binding.file, message });
            console.log(
              `  ${chalk.red('✗')} ${binding.file} ${chalk.dim(`<- ${binding.workspace}/${binding.environment}`)} ` +
                `${chalk.red(message.slice(0, 80))}`,
            );
          }
        }
      }

      const registrable = bindings.filter((binding) => !unprovisioned.has(binding.file));
      if (opts.register !== false && registrable.length === 0) {
        console.log();
        output.warn('Nothing was registered for sync: no file of this project could be set up.');
        if (wroteManifest) {
          // Leaving the manifest behind would make the next attempt look like
          // a fresh clone, which is pulled, not created, and so could never
          // succeed. Without it the next attempt starts from the beginning.
          rmSync(join(root, MANIFEST_FILENAME), { force: true });
          console.log(chalk.dim(`  Removed the ${MANIFEST_FILENAME} written a moment ago, so the next attempt starts clean.`));
        }
      }
      if (opts.register !== false && registrable.length > 0) {
        const registry = loadRegistry();
        const project: SyncProject = {
          id,
          path: root,
          ...(org ? { org } : {}),
          ...(manifest.workspace ? { workspace: manifest.workspace } : {}),
          enabled: true,
          bindings: registrable.map((b) => ({
            file: b.file,
            environment: b.environment!,
            ...(b.pod ? { pod: b.pod } : {}),
            ...(b.workspace && b.workspace !== manifest.workspace ? { workspace: b.workspace } : {}),
          })),
        };
        const existing = registry.projects.findIndex((p) => p.id === id);
        if (existing >= 0 && registry.projects[existing]!.path !== root) {
          // The manifest is committed, so every checkout of the repo carries
          // the same id. Silently rebinding it would point the sync service at
          // whichever copy ran `init` last - a second clone, a worktree, a
          // colleague's path in a shared home - and stop syncing the original
          // without saying so.
          throw new Error(
            `Project "${id}" is already registered at ${registry.projects[existing]!.path}.\n`
              + `  This directory is ${root}.\n`
              + `  Re-running init here would repoint the sync service at this copy.\n`
              + `  Use --id <other-id> to register this checkout separately, `
              + `or \`cf sync remove ${id}\` first if you meant to move it.`,
          );
        }
        if (existing >= 0) registry.projects[existing] = project;
        else registry.projects.push(project);
        saveRegistry(registry);
        console.log();
        output.success(`Registered ${chalk.bold(id)} for ongoing sync.`);
      }

      if (failures.length > 0) {
        console.log();
        output.warn(`${failures.length} of ${manifest.bindings.length} file(s) could not be set up:`);
        for (const f of failures) console.error(`    ${f.file}  ${chalk.dim(f.message.slice(0, 100))}`);
        if (!planLine) console.error(chalk.dim(`\n  Re-run ${chalk.cyan('cf sync init')} to retry only what is missing.`));
      }
      if (planLine) {
        // Last and on one line: when the background service ran this, the
        // last line is the one it repeats in its own log.
        console.error();
        console.error(chalk.yellow(planLine));
      }
      if (failures.length > 0 || planLine) process.exit(1);

      console.log();
      console.log('  Next:');
      console.log(`    ${chalk.cyan(`cf sync status --project ${id}`)}`);
      console.log(`    ${chalk.cyan('cf sync install-service --enable')}   ${chalk.dim('# run it in the background')}`);
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

/** Generates `.cryptflare.json` from a project already registered locally. */
const GIT_STATE_NOTE: Record<GitFileState, string> = {
  ignored: '',
  unknown: '',
  untracked: 'not in .gitignore',
  tracked: 'TRACKED BY GIT',
};

/**
 * Proposes a manifest for a repository that has none, and writes it when the
 * person agrees. Reads file names only - never the contents of an env file.
 *
 * @returns whether a manifest was written.
 */
async function proposeManifest(root: string, options: { assumeYes: boolean }): Promise<boolean> {
  const files = findEnvFiles(root);
  if (files.length === 0) {
    throw new Error(
      `No ${MANIFEST_FILENAME} in ${root}, and no env files to build one from.\n`
        + '  Create the file your app reads (for example .env), then run this again.',
    );
  }

  const planned = planBindings(files);
  const manifest = buildManifest(root, planned, { org: getOrg() });
  const git = gitFileStates(root, files);

  console.log();
  console.log(`  No ${MANIFEST_FILENAME} here yet. Proposed from the ${files.length} env file(s) found:`);
  console.log();
  console.log(`  ${chalk.dim('workspace')} ${chalk.bold(manifest.workspace)}`);
  console.log();
  output.table(planned.map((binding) => ({
    file: binding.file,
    environment: binding.environment,
    capture: binding.capture,
    note: GIT_STATE_NOTE[git.get(binding.file) ?? 'unknown'],
  })));

  const tracked = files.filter((file) => git.get(file) === 'tracked');
  const exposed = files.filter((file) => git.get(file) === 'untracked');
  if (tracked.length > 0) {
    console.log();
    output.warn(`${tracked.length} of these are tracked by git: ${tracked.join(', ')}`);
    console.log(chalk.dim('  Their values are in the repository history. Rotate them, and stop tracking the files'));
    console.log(chalk.dim('  (git rm --cached <file>, then add them to .gitignore).'));
  }
  if (exposed.length > 0) {
    console.log();
    output.warn(`${exposed.length} are not ignored by git and could be committed by accident: ${exposed.join(', ')}`);
  }
  console.log();

  if (!options.assumeYes) {
    if (!process.stdin.isTTY) {
      console.log(chalk.dim(`  Not a terminal, so nothing was written. Pass --yes to write ${MANIFEST_FILENAME}.`));
      console.log();
      return false;
    }
    const { ok } = await prompts(
      { type: 'confirm', name: 'ok', message: `Write ${MANIFEST_FILENAME}?`, initial: true },
      { onCancel: () => ({ ok: false }) },
    );
    if (!ok) {
      console.log(chalk.dim('  Nothing written.'));
      return false;
    }
  }

  const path = writeManifest(root, manifest);
  output.success(`Wrote ${chalk.bold(path)}`);
  console.log(chalk.dim('  It holds file paths and names only, never a value. Edit it freely, then commit it.'));
  console.log();
  return true;
}

function writeManifestFromRegistry(root: string, projectId?: string): void {
  const registry = loadRegistry();
  const atRoot = registry.projects.filter((p) => p.path === root);

  if (atRoot.length === 0) {
    throw new Error(
      `No registered project at ${root}. Run \`cf sync add\` first, then \`cf sync init --write\`.`,
    );
  }

  // More than one project can point at the same directory - registering a
  // monorepo per-app produces exactly that. Picking the first silently writes
  // a manifest covering one app and looking complete, so require a choice.
  let project = atRoot[0]!;
  if (projectId) {
    const match = atRoot.find((p) => p.id === projectId);
    if (!match) {
      throw new Error(
        `No project "${projectId}" registered at ${root}. Candidates: ${atRoot.map((p) => p.id).join(', ')}`,
      );
    }
    project = match;
  } else if (atRoot.length > 1) {
    throw new Error(
      `${atRoot.length} projects are registered at ${root}: ${atRoot.map((p) => p.id).join(', ')}. ` +
        `Choose one with --project <id>.`,
    );
  }

  const written = writeManifest(root, {
    version: 1,
    id: project.id,
    ...(project.org ? { org: project.org } : {}),
    ...(project.workspace ? { workspace: project.workspace } : {}),
    bindings: project.bindings.map((b) => ({
      file: b.file,
      ...(b.workspace ? { workspace: b.workspace } : {}),
      environment: b.environment,
      ...(b.pod ? { pod: b.pod } : {}),
      ...(b.capture ? { capture: b.capture } : {}),
    })),
  });

  output.success(`Wrote ${chalk.bold(written)}`);
  console.log();
  console.log(chalk.dim('  Commit it. It holds no secrets - only file paths and workspace/environment names -'));
  console.log(chalk.dim('  so anyone cloning the repo can run `cf sync init` and be set up in one command.'));
  console.log();
}

const listCommand = new Command('list')
  .description('List registered projects')
  .option('--json', 'Output as JSON')
  .action((opts) => {
    try {
      const registry = loadRegistry();
      if (opts.json) {
        output.json(registry);
        return;
      }
      if (registry.projects.length === 0) {
        output.info(`No projects registered. Add one with ${chalk.cyan('cf sync add')}.`);
        return;
      }
      output.table(
        registry.projects.flatMap((p) =>
          p.bindings.map((b) => ({
            project: p.id,
            file: b.file,
            // Per-binding workspace wins; the project value is only a default.
            workspace: b.workspace ?? p.workspace ?? '(unset)',
            environment: b.environment,
            pod: b.pod ?? 'root',
            capture: resolveCapture(b, loadManifestCapture(p)),
            enabled: p.enabled ? 'yes' : 'no',
            path: p.path,
          })),
        ),
      );
    } catch (err) {
      output.handleError(err);
    }
  });

const removeCommand = new Command('remove')
  .description('Unregister a project (does not touch its files or remote secrets)')
  .argument('<id>', 'Project identifier')
  .action((id: string) => {
    try {
      const registry = loadRegistry();
      const next = registry.projects.filter((p) => p.id !== id);
      if (next.length === registry.projects.length) {
        throw new Error(`No project "${id}" registered.`);
      }
      registry.projects = next;
      saveRegistry(registry);
      output.success(`Removed ${chalk.bold(id)}. Local files and remote secrets untouched.`);
    } catch (err) {
      output.handleError(err);
    }
  });

function setEnabled(id: string, enabled: boolean): void {
  const registry = loadRegistry();
  const project = registry.projects.find((p) => p.id === id);
  if (!project) throw new Error(`No project "${id}" registered.`);
  project.enabled = enabled;
  saveRegistry(registry);
  output.success(`${enabled ? 'Enabled' : 'Disabled'} ${chalk.bold(id)}.`);
}

const enableCommand = new Command('enable')
  .description('Re-enable a parked project')
  .argument('<id>', 'Project identifier')
  .action((id: string) => {
    try {
      setEnabled(id, true);
    } catch (err) {
      output.handleError(err);
    }
  });

const disableCommand = new Command('disable')
  .description('Park a project without unregistering it')
  .argument('<id>', 'Project identifier')
  .action((id: string) => {
    try {
      setEnabled(id, false);
    } catch (err) {
      output.handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// Pass execution, shared by `status`, `run`, and `watch`
// ---------------------------------------------------------------------------

const ACTION_STYLE: Record<string, (s: string) => string> = {
  pull: chalk.blue,
  push: chalk.green,
  conflict: chalk.red,
  create: chalk.green,
  'confirm-create': chalk.cyan,
  'skip-invalid-local': chalk.yellow,
  'skip-new-local': chalk.yellow,
  'skip-local-deleted': chalk.dim,
  'skip-remote-deleted': chalk.dim,
  'skip-multiline': chalk.yellow,
  'needs-compare': chalk.cyan,
};

const ACTION_GLYPH: Record<string, string> = {
  pull: '<-',
  push: '->',
  conflict: '!!',
  create: '+>',
  'confirm-create': '+?',
  'skip-invalid-local': '..',
  'skip-new-local': '..',
  'skip-local-deleted': '..',
  'skip-remote-deleted': '..',
  'skip-multiline': '..',
  'needs-compare': '??',
};

function describeAction(action: SyncAction): string {
  switch (action.type) {
    case 'create':
      return 'new local key - will be created (capture: auto)';
    case 'confirm-create':
      return 'new local key - `cf sync run` asks before creating it (capture: prompt)';
    case 'skip-invalid-local':
      return `new local key, not created - ${action.reason}`;
    case 'skip-new-local':
      return 'new local key, not created (capture: off) - set "capture": "auto" on the binding, or `cf push`';
    case 'skip-local-deleted':
      return 'removed locally, still remote - not deleted';
    case 'skip-remote-deleted':
      return 'removed remotely, still local - not deleted';
    case 'skip-multiline':
      return 'multi-line value, not managed';
    case 'needs-compare':
      return 'first sync for this key - `cf sync run` compares it (a dry run will not decrypt)';
    default:
      return '';
  }
}

function printPlan(plan: BindingPlan, verbose: boolean): void {
  const label = `${plan.project.id}/${plan.binding.file}`;
  // A binding may name its own workspace, which overrides the project default
  // and is the whole point in a monorepo mapping each app to its own. Reading
  // only the project field printed "undefined/dev" for those.
  const scope = `${plan.binding.workspace ?? plan.project.workspace}/${plan.binding.environment}`;
  const actionable = countActionable(plan);
  // Not actionable - nothing to do about them - but a dry run that stays
  // silent about keys it declined to compare is misreporting.
  const unresolved = plan.actions.filter((a) => a.type === 'needs-compare').length;

  if (actionable === 0 && unresolved === 0 && !verbose) return;

  console.log(
    `${chalk.bold(label)} ${chalk.dim(`<-> ${scope}`)}${plan.creating ? chalk.yellow(' (file will be created)') : ''}`,
  );
  for (const action of plan.actions) {
    if (!verbose && action.type.startsWith('skip-')) continue;
    // First contact usually means every key at once - a fresh registration
    // has no baseline for any of them. One line each, carrying the same
    // sentence, buries the pulls and conflicts that need a decision. Collapse
    // to a count below, and list them under --verbose.
    if (!verbose && action.type === 'needs-compare') continue;
    const style = ACTION_STYLE[action.type] ?? chalk.white;
    const note = describeAction(action);
    console.log(`    ${style(`${ACTION_GLYPH[action.type]} ${action.key}`)}${note ? chalk.dim(`  ${note}`) : ''}`);
  }

  if (unresolved > 0 && !verbose) {
    console.log(
      `    ${chalk.cyan(`?? ${unresolved} key(s) awaiting first comparison`)}`
        + chalk.dim(` - ${chalk.cyan('cf sync run')} resolves them (a dry run will not decrypt)`),
    );
  }
  if (actionable === 0 && unresolved === 0) console.log(chalk.dim('    in sync'));
}

type PassOptions = {
  projectId?: string;
  push: boolean;
  dryRun: boolean;
  verbose: boolean;
  quiet: boolean;
  /** Skip signatures already logged this process, so a fortnight of polls
   * does not print the same "new local key" line 20,000 times. */
  loggedSkips?: Set<string>;
  /** Someone is at a terminal, so `capture: prompt` keys can be asked about. */
  interactive?: boolean;
  /** Projects to sync, when the caller already read the registry. */
  projects?: SyncProject[];
};

type PassSummary = {
  pulled: number;
  pushed: number;
  created: number;
  conflicts: number;
  failures: number;
  /** Bindings refused with 401 - a login problem, not a transient one. */
  authFailures: number;
  /** Bindings attempted, so "every binding failed auth" can be told apart from "one did". */
  bindings: number;
  /** Groups of files refused because they are bound to one environment. */
  collisions: number;
  /** Files whose new keys were not uploaded because the plan's secret limit is reached. */
  planLimited: number;
  changed: boolean;
};

/**
 * Asks which new keys to create, for bindings in `capture: prompt`.
 * Everything is pre-selected: the developer just typed these lines, so the
 * common answer is yes, and deselecting a scratch variable is one keypress.
 */
async function askWhichToCreate(label: string, keys: string[]): Promise<string[]> {
  const { chosen } = await prompts(
    {
      type: 'multiselect',
      name: 'chosen',
      message: `[${label}] new local keys - create in CryptFlare?`,
      choices: keys.map((key) => ({ title: key, value: key, selected: true })),
      instructions: false,
      hint: 'space toggles, enter confirms',
    },
    { onCancel: () => ({ chosen: [] }) },
  );
  return Array.isArray(chosen) ? (chosen as string[]) : [];
}

/**
 * Files whose new keys the plan has no room for, and when to try again.
 * Until then the file is synced as if capture were off: existing keys still
 * move both ways, and no create is sent only to be refused again.
 */
const captureBlockedUntil = new Map<string, number>();

async function runPass(opts: PassOptions): Promise<PassSummary> {
  const projects = opts.projects ?? selectProjects(opts.projectId);
  const summary: PassSummary = {
    pulled: 0,
    pushed: 0,
    created: 0,
    conflicts: 0,
    failures: 0,
    authFailures: 0,
    bindings: 0,
    collisions: 0,
    planLimited: 0,
    changed: false,
  };
  if (projects.length === 0) return summary;

  const client = getClient();
  const state = loadState();
  let stateDirty = false;

  const canAsk = Boolean(opts.interactive) && Boolean(process.stdin.isTTY);

  for (const project of projects) {
    const manifestCapture = loadManifestCapture(project);

    // Two files in one environment would overwrite each other on every pass.
    // Refuse those, say which, and sync the rest of the project.
    const collisions = findBindingCollisions(project.bindings, project.workspace);
    const collided = collidingFiles(collisions);
    summary.collisions += collisions.length;
    for (const collision of collisions) {
      const signature = `${project.id}:collision:${collision.target}:${collision.files.join(',')}`;
      if (opts.loggedSkips?.has(signature)) continue;
      opts.loggedSkips?.add(signature);
      console.error(chalk.red(`[${project.id}] ${describeCollision(collision)}`));
    }

    for (const binding of project.bindings) {
      if (collided.has(binding.file)) continue;
      const label = `${project.id}/${binding.file}`;
      summary.bindings++;
      const captureBlocked = (captureBlockedUntil.get(label) ?? 0) > Date.now();
      try {
        // A dry run reports; it must not consume the reveal budget the real
        // pass needs, so first-contact keys come back as `needs-compare`.
        const plan = await planBinding(client, project, binding, state, {
          reveal: !opts.dryRun,
          capture: captureBlocked ? 'off' : resolveCapture(binding, manifestCapture),
        });

        if (opts.dryRun) {
          printPlan(plan, opts.verbose);
          continue;
        }

        const result = await applyPlan(client, plan, state, {
          push: opts.push,
          ...(canAsk ? { approveCreate: (keys: string[]) => askWhichToCreate(label, keys) } : {}),
        });
        stateDirty = true;
        // The plan-limit line already said why these were not created.
        if (captureBlocked) result.skipped = result.skipped.filter((skip) => skip.type !== 'skip-new-local');
        summary.pulled += result.pulled.length;
        summary.pushed += result.pushed.length;
        summary.created += result.created.length;
        summary.failures += result.failed.length > 0 ? 1 : 0;
        summary.conflicts += result.conflicts.length;
        summary.changed ||= result.changed;
        logResult(label, bindingFilePath(project, binding), result, opts);
      } catch (err) {
        if (isPlanLimitError(err)) {
          // Asking again every minute cannot succeed and buries the log.
          // Say it once, sync the rest of this file as usual, and try the
          // new keys again in an hour in case the plan changed.
          summary.planLimited++;
          captureBlockedUntil.set(label, Date.now() + ONBOARD_RETRY_MS);
          const signature = `${label}:plan-limit`;
          if (!opts.loggedSkips?.has(signature)) {
            opts.loggedSkips?.add(signature);
            console.error(chalk.yellow(
              `[${label}] new keys were not uploaded: ${(err as Error).message} ${upgradeHint()}. Trying again every hour.`,
            ));
          }
          continue;
        }
        summary.failures++;
        if ((err as { status?: number }).status === 401) summary.authFailures++;
        // One unreachable workspace must not stop the other projects. Log and
        // carry on; the next pass retries from the same baseline.
        console.error(chalk.red(`[${label}] ${(err as Error).message ?? String(err)}`));
      }
    }
  }

  if (stateDirty) saveState(state);
  return summary;
}

function logResult(label: string, filePath: string, result: ApplyResult, opts: PassOptions): void {
  if (result.conflicts.length > 0) {
    console.error(
      chalk.red(`[${label}] CONFLICT on ${result.conflicts.join(', ')} - remote won, local saved to ${result.conflictFile}`),
    );
  }
  if (result.pulled.length > 0) {
    console.error(chalk.blue(`[${label}] pulled ${result.pulled.length} -> ${filePath} (${result.pulled.join(', ')})`));
  }
  if (result.pushed.length > 0) {
    console.error(chalk.green(`[${label}] pushed ${result.pushed.length} (${result.pushed.join(', ')})`));
  }
  if (result.created.length > 0) {
    console.error(chalk.green(`[${label}] created ${result.created.length} new (${result.created.join(', ')})`));
  }
  for (const failure of result.failed) {
    console.error(chalk.red(`[${label}] ${failure.key}: not written - ${failure.reason}`));
  }

  for (const skip of result.skipped) {
    const signature = `${label}:${skip.type}:${skip.key}`;
    if (opts.loggedSkips) {
      if (opts.loggedSkips.has(signature)) continue;
      opts.loggedSkips.add(signature);
    }
    console.error(chalk.yellow(`[${label}] ${skip.key}: ${describeAction(skip)}`));
  }

  if (!result.changed && !opts.quiet && result.skipped.length === 0) {
    console.error(chalk.dim(`[${label}] no change`));
  }
}

// ---------------------------------------------------------------------------
// New env files in repositories that are already registered
// ---------------------------------------------------------------------------

/** Files that could not be bound, and when each may be tried again. */
const rediscoverRetryAt = new Map<string, number>();

/**
 * Binds env files that appeared since each project was set up. See
 * `../lib/rediscover.ts` for what it will and will not touch.
 *
 * Never throws: a repository whose new file cannot be bound must not stop
 * the files that are already synced.
 *
 * @param logged Lines already printed by this process. Without it every line is printed.
 * @returns how many files were newly bound.
 */
async function rediscover(projects: readonly SyncProject[], logged?: Set<string>): Promise<number> {
  // Looking is local and free; the client is only needed once something new is found.
  let registry: SyncRegistry;
  try {
    registry = loadRegistry();
  } catch {
    return 0;
  }
  if (!projects.some((project) => findNewBindings(project, registry).length > 0)) return 0;

  let reports: RediscoverReport[];
  try {
    reports = await rediscoverProjects(getClient(), projects, { retryAt: rediscoverRetryAt, scopeCache: newScopeCache() });
  } catch (err) {
    console.error(chalk.yellow(`[sync] could not look for new env files: ${(err as Error).message ?? String(err)}`));
    return 0;
  }

  const once = (signature: string, line: string) => {
    if (logged?.has(signature)) return;
    logged?.add(signature);
    console.error(line);
  };

  let added = 0;
  for (const report of reports) {
    const id = report.project.id;
    for (const binding of report.added) {
      added += 1;
      const mode = binding.capture ?? 'off';
      console.error(chalk.green(
        `[${id}/${binding.file}] new env file, now synced with ${binding.workspace}/${binding.environment} (capture: ${mode})`,
      ));
    }
    if (report.refused.length > 0) {
      once(
        `${id}:plan:${report.refused.map((item) => item.file).join(',')}`,
        chalk.yellow(`[${id}] ${describePlanRefusal(report.refused, report.allowance)}`),
      );
    }
    for (const item of report.failed) {
      once(
        `${id}:rediscover:${item.file}:${item.message}`,
        chalk.yellow(`[${id}/${item.file}] new env file, not synced yet: ${item.message.slice(0, 200)} - trying again every hour`),
      );
    }
  }
  return added;
}

/** What the watch loop watches: every bound file, plus the registry itself. */
function startFileWake(projects: readonly SyncProject[]): FileWake {
  const files = projects.flatMap((project) => project.bindings.map((binding) => bindingFilePath(project, binding)));
  // A new env file wakes the loop too, wherever a bound file already lives
  // and at the top of each repository.
  const directories: DirectoryWatch[] = [...new Set([...projects.map((project) => project.path), ...files.map((file) => dirname(file))])]
    .map((directory) => ({ directory, matches: isEnvFileName }));
  // `cf sync auto`, `init`, `add` and `remove` all save the registry, so
  // watching it is what makes them take effect without a restart.
  return watchFiles([...files, getRegistryPath()], undefined, directories);
}

/** Changes when the set of things to watch changes, and only then. */
export function watchSignature(projects: readonly SyncProject[], roots: readonly string[]): string {
  return JSON.stringify([
    [...roots].sort(),
    projects.map((project) => [project.id, project.path, project.bindings.map((binding) => binding.file)]),
  ]);
}

// ---------------------------------------------------------------------------
// cf sync status / run / watch
// ---------------------------------------------------------------------------

const statusCommand = new Command('status')
  .description('Show what a sync pass would do, without changing anything')
  .option('-p, --project <id>', 'Limit to one project')
  .option('-a, --all', 'Include keys that are already in sync or intentionally skipped')
  .action(async (opts) => {
    try {
      const projects = selectProjects(opts.project);
      if (projects.length === 0) {
        output.info(`No enabled projects. Add one with ${chalk.cyan('cf sync add')}.`);
        return;
      }
      console.log();
      await runPass({ projectId: opts.project, push: true, dryRun: true, verbose: Boolean(opts.all), quiet: false });

      const registry = loadRegistry();
      for (const project of projects) {
        for (const binding of findNewBindings(project, registry)) {
          console.log(
            `${chalk.bold(`${project.id}/${binding.file}`)} ${chalk.dim(`<-> ${binding.workspace}/${binding.environment}`)} `
              + chalk.green('new env file - bound on the next `cf sync run`'),
          );
        }
      }
      console.log();
      console.log(chalk.dim(`  Registry: ${getRegistryPath()}`));
      console.log(chalk.dim(`  State:    ${getStatePath()}`));
      console.log();
    } catch (err) {
      output.handleError(err);
    }
  });

const runCommand = new Command('run')
  .description('Run one sync pass over every registered project and exit')
  .option('-p, --project <id>', 'Limit to one project')
  .option('--pull-only', 'Do not push local changes up')
  .option('--dry-run', 'Alias for `cf sync status`')
  .option('-q, --quiet', 'Only log when something changes')
  .action(async (opts) => {
    try {
      await requirePermission('secrets:read');
      if (!opts.pullOnly && !opts.dryRun) await requirePermission('secrets:write');

      // New repositories under the automatic directories are set up first,
      // so this same pass already syncs them.
      if (!opts.dryRun && !opts.pullOnly && !opts.project) onboardPending();
      // And new env files in repositories that are already set up.
      if (!opts.dryRun && !opts.pullOnly) await rediscover(selectProjects(opts.project));

      const summary = await runPass({
        projectId: opts.project,
        push: !opts.pullOnly,
        dryRun: Boolean(opts.dryRun),
        verbose: false,
        quiet: Boolean(opts.quiet),
        interactive: true,
      });

      if (opts.dryRun) return;
      if (summary.failures > 0) output.warn(`${summary.failures} binding(s) failed. See errors above.`);
      if (summary.collisions > 0) {
        output.warn(`${summary.collisions} group(s) of files share an environment and were not synced. See errors above.`);
      }
      if (summary.failures > 0 || summary.collisions > 0) process.exit(1);
      output.success(
        `Sync complete: ${summary.pulled} pulled, ${summary.pushed} pushed, `
          + `${summary.created} created, ${summary.conflicts} conflict(s).`,
      );
    } catch (err) {
      output.handleError(err);
    }
  });

const watchCommand = new Command('watch')
  .description('Long-running loop that syncs every registered project (what the background service runs)')
  .option('-p, --project <id>', 'Limit to one project')
  .option('--interval <seconds>', 'Base poll interval', String(DEFAULT_INTERVAL_S))
  .option('--pull-only', 'Do not push local changes up')
  .option('-q, --quiet', 'Only log when something changes')
  .action(async (opts) => {
    try {
      const intervalS = Number(opts.interval);
      if (!Number.isFinite(intervalS) || intervalS < MIN_INTERVAL_S) {
        throw new Error(`--interval must be a number >= ${MIN_INTERVAL_S} (got ${opts.interval})`);
      }
      const baseIntervalMs = intervalS * 1_000;

      await requirePermission('secrets:read');
      if (!opts.pullOnly) await requirePermission('secrets:write');

      // Setting repositories up uploads, so a pull-only or single-project
      // service never does it.
      const canOnboard = !opts.project && !opts.pullOnly;
      const canDiscover = !opts.pullOnly;

      // Read once here so a registry that is broken, or a --project that does
      // not exist, fails at start where someone sees it.
      const initial = selectProjects(opts.project);
      const initialRoots = canOnboard ? loadRegistry().roots ?? [] : [];

      let stop = false;
      const onSignal = (sig: NodeJS.Signals) => {
        if (stop) return;
        stop = true;
        console.error(chalk.dim(`[sync] ${sig} received, finishing current pass...`));
      };
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);

      console.error(chalk.bold(`[sync] started, checking every ${intervalS}s${opts.pullOnly ? ' (pull-only)' : ''}`));
      if (initial.length === 0 && initialRoots.length === 0) {
        // Not an error: the service is often installed before the first
        // directory is named, and it picks that up without a restart.
        console.error(chalk.dim(
          `[sync] nothing to sync yet. Waiting for \`cf sync auto <directory>\` or \`cf sync init\` (registry: ${getRegistryPath()})`,
        ));
      }

      const loggedSkips = new Set<string>();
      let backoffMs = baseIntervalMs;
      let idlePasses = 0;
      let authFailedPasses = 0;

      let fileWake: FileWake | undefined;
      let signature: string | undefined;
      let knownRoots = new Set<string>();
      let nextOnboardAt = 0;
      let lastRediscoverAt = 0;
      // Whether this turn of the loop was caused by a change on disk.
      let woken = false;
      let registryProblem = '';

      /** The registry as it is now, or `null` while it cannot be read. */
      const readRegistry = (): { projects: SyncProject[]; roots: string[] } | null => {
        try {
          const projects = selectProjects(opts.project);
          const roots = canOnboard ? loadRegistry().roots ?? [] : [];
          registryProblem = '';
          return { projects, roots };
        } catch (err) {
          // Saved half-edited, or the one project this service is for was
          // removed. Say so once and wait for it to be put right.
          const problem = (err as Error).message ?? String(err);
          if (problem !== registryProblem) console.error(chalk.red(`[sync] ${problem} - waiting for the registry to be fixed`));
          registryProblem = problem;
          return null;
        }
      };

      while (!stop) {
        // The registry is read again on every turn, and the loop is woken
        // when the file changes. That is what makes `cf sync auto <dir>`,
        // `cf sync init` and `cf sync remove` take effect in a running
        // service.
        let current = readRegistry();

        if (current) {
          const addedRoots = current.roots.filter((root) => !knownRoots.has(root));
          const removedRoots = [...knownRoots].filter((root) => !current!.roots.includes(root));
          if (signature !== undefined) {
            for (const root of addedRoots) console.error(chalk.bold(`[sync] now setting up repositories under ${root}`));
            for (const root of removedRoots) console.error(chalk.dim(`[sync] no longer setting up repositories under ${root}`));
          }
          knownRoots = new Set(current.roots);
          // A directory that was just named is looked at now, not at the
          // next ten-minute mark.
          if (addedRoots.length > 0) nextOnboardAt = 0;

          if (current.roots.length > 0 && Date.now() >= nextOnboardAt) {
            nextOnboardAt = Date.now() + ONBOARD_INTERVAL_MS;
            if (onboardPending() > 0) current = readRegistry() ?? current;
          }

          if (canDiscover && (woken || Date.now() - lastRediscoverAt >= REDISCOVER_MIN_INTERVAL_MS)) {
            lastRediscoverAt = Date.now();
            if ((await rediscover(current.projects, loggedSkips)) > 0) current = readRegistry() ?? current;
          }

          const nextSignature = watchSignature(current.projects, current.roots);
          if (nextSignature !== signature) {
            const fileCount = current.projects.reduce((n, project) => n + project.bindings.length, 0);
            console.error(chalk.bold(
              `[sync] ${signature === undefined ? 'watching' : 'registry changed, now watching'} `
                + `${current.projects.length} project(s), ${fileCount} file(s)`,
            ));
            // New projects and new files mean new things to watch.
            fileWake?.close();
            fileWake = startFileWake(current.projects);
            if (fileWake.watching === 0) {
              console.error(chalk.dim('[sync] file changes cannot be watched here; relying on the poll interval'));
            }
            signature = nextSignature;
          }
        }

        const summary = await runPass({
          projectId: opts.project,
          push: !opts.pullOnly,
          dryRun: false,
          verbose: false,
          quiet: Boolean(opts.quiet),
          loggedSkips,
          projects: current?.projects ?? [],
        });

        // A revoked or expired token fails every binding with 401 and will keep
        // doing so. Retrying it every minute for a fortnight helps nobody and
        // buries the cause in the journal, so stop and say what to do.
        authFailedPasses = summary.bindings > 0 && summary.authFailures === summary.bindings
          ? authFailedPasses + 1
          : 0;
        if (authFailedPasses >= AUTH_FAILURE_LIMIT) {
          console.error(chalk.red(needsLoginMessage(AUTH_FAILURE_LIMIT)));
          process.exit(EXIT_NEEDS_LOGIN);
        }

        if (summary.changed || summary.failures > 0) {
          // Activity (or trouble) means poll tight again - a developer who just
          // rotated a secret should not wait out a ten-minute backoff.
          idlePasses = 0;
          backoffMs = baseIntervalMs;
        } else if (++idlePasses >= NO_CHANGE_GRACE) {
          backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_CEILING_MS);
        }

        if (stop) break;

        const sleepMs = jittered(backoffMs);
        const edited = await new Promise<boolean>((resolveSleep) => {
          const timer = setTimeout(() => resolveSleep(false), sleepMs);
          const wake = (byEdit: boolean) => {
            clearTimeout(timer);
            resolveSleep(byEdit);
          };
          process.once('SIGTERM', () => wake(false));
          process.once('SIGINT', () => wake(false));
          void fileWake?.next().then(() => wake(true));
        });
        woken = edited;
        if (edited) {
          // Someone is working in these files: poll tight again.
          idlePasses = 0;
          backoffMs = baseIntervalMs;
        }
      }

      fileWake?.close();
      console.error(chalk.dim('[sync] stopped'));
    } catch (err) {
      output.handleError(err);
    }
  });

// ---------------------------------------------------------------------------
// cf sync install-service
// ---------------------------------------------------------------------------

/**
 * Renders a systemd **user** unit, not a system unit. The service needs the
 * caller's `~/.config/cryptflare` credentials and writes into the caller's
 * project directories, so running it as root would mean either copying the
 * token somewhere more privileged or writing files as the wrong owner.
 */
export function renderUnit(opts: {
  interval: number;
  pullOnly: boolean;
  project?: string;
  execPath?: string;
}): string {
  // systemd needs an absolute path with no PATH lookup, so bake in the entry
  // point this process was started from. `--exec-path` overrides it for the
  // cases where argv[1] is not the real CLI (a wrapper script, a test runner).
  const cliPath = resolve(opts.execPath ?? process.argv[1] ?? 'cf');
  const args = ['sync', 'watch', '--interval', String(opts.interval)];
  if (opts.pullOnly) args.push('--pull-only');
  if (opts.project) args.push('--project', opts.project);

  return `[Unit]
Description=CryptFlare secret sync
Documentation=https://cryptflare.com/docs/cli
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${cliPath} ${args.join(' ')}
Restart=always
RestartSec=15
# 78 is "login required": the saved token was refused. Restarting cannot fix
# that, so stay stopped until someone logs in again.
RestartPreventExitStatus=${EXIT_NEEDS_LOGIN}
# Optional 0600 file holding CF_TOKEN, so a dedicated scoped token for the
# service never has to live in this world-readable unit. The leading dash makes
# it optional - without it the service falls back to the CLI's saved login.
EnvironmentFile=-%h/.config/cryptflare/service.env
# Cap restart storms: if the loop cannot stay up, stop rather than hammer the
# API for a fortnight while nobody is watching.
StartLimitIntervalSec=300
StartLimitBurst=5
Environment=NODE_ENV=production

# Hardening. ProtectHome stays read-write because the whole job is writing
# .env files under $HOME; MemoryDenyWriteExecute stays off because V8 JITs.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-write
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=default.target
`;
}

/** Runs a system tool, passing its output through. */
function runTool(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'inherit' });
}

function serviceSpecFrom(opts: { interval: string; pullOnly?: boolean; project?: string; execPath?: string }): ServiceSpec {
  const interval = Number(opts.interval);
  if (!Number.isFinite(interval) || interval < MIN_INTERVAL_S) {
    throw new Error(`--interval must be a number >= ${MIN_INTERVAL_S}`);
  }

  const cliPath = resolve(opts.execPath ?? process.argv[1] ?? 'cf');
  if (!existsSync(cliPath)) {
    // A service whose entry point does not exist fails silently in the
    // background. Catch it here, while someone is still watching.
    throw new Error(`CLI entry point not found at ${cliPath}. Pass --exec-path <path to cf>.`);
  }

  return {
    nodePath: process.execPath,
    cliPath,
    interval,
    pullOnly: Boolean(opts.pullOnly),
    project: opts.project,
  };
}

/** Linux: systemd user unit. */
function installSystemd(spec: ServiceSpec, opts: { enable?: boolean; print?: boolean }): void {
  const unit = renderUnit({
    interval: spec.interval,
    pullOnly: spec.pullOnly,
    ...(spec.project ? { project: spec.project } : {}),
    execPath: spec.cliPath,
  });
  if (opts.print) {
    console.log(unit);
    return;
  }

  // Under WSL the user manager only exists when systemd is switched on, and
  // without it the unit below would be written and never run.
  if (!existsSync('/run/systemd/system')) {
    throw new Error(
      'systemd is not running on this machine. Under WSL, add\n\n'
        + '    [boot]\n    systemd=true\n\n'
        + '  to /etc/wsl.conf and run `wsl --shutdown` from Windows, then try again.\n'
        + '  Or install the service on the Windows side instead, by running this command in PowerShell.',
    );
  }

  const unitDir = join(homedir(), '.config', 'systemd', 'user');
  const unitPath = join(unitDir, SERVICE_NAME);
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit, { encoding: 'utf-8', mode: 0o644 });
  output.success(`Wrote ${chalk.bold(unitPath)}`);

  if (opts.enable) {
    runTool('systemctl', ['--user', 'daemon-reload']);
    runTool('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    try {
      // Without lingering, the user manager is torn down at logout and the
      // service dies with it - fatal for the "sync while I am away" case.
      runTool('loginctl', ['enable-linger', userInfo().username]);
    } catch {
      output.warn('Could not enable linger automatically. Run: sudo loginctl enable-linger $USER');
    }
    output.success('Service enabled and started.');
  } else {
    console.log();
    console.log('  Next:');
    console.log(`    ${chalk.cyan('systemctl --user daemon-reload')}`);
    console.log(`    ${chalk.cyan(`systemctl --user enable --now ${SERVICE_NAME}`)}`);
    console.log(`    ${chalk.cyan('sudo loginctl enable-linger $USER')}   ${chalk.dim('# keeps it running while logged out')}`);
  }

  console.log();
  console.log('  Logs:');
  console.log(`    ${chalk.cyan(`journalctl --user -u ${SERVICE_NAME} -f`)}`);
  console.log();
}

/** macOS: launchd user agent. */
function installLaunchd(spec: ServiceSpec, opts: { enable?: boolean; print?: boolean }): void {
  const plist = renderLaunchdPlist(spec);
  if (opts.print) {
    console.log(plist);
    return;
  }

  const plistPath = launchdPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });
  mkdirSync(dirname(launchdLogPath()), { recursive: true });
  writeFileSync(plistPath, plist, { encoding: 'utf-8', mode: 0o644 });
  output.success(`Wrote ${chalk.bold(plistPath)}`);

  if (opts.enable) {
    // Unload first so re-installing replaces a running agent instead of
    // failing with "service already loaded". Not loaded is not an error.
    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    } catch {
      // Nothing was loaded.
    }
    runTool('launchctl', ['load', '-w', plistPath]);
    output.success('Agent loaded. It starts at login.');
  } else {
    console.log();
    console.log('  Next:');
    console.log(`    ${chalk.cyan(`launchctl load -w ${plistPath}`)}`);
  }

  console.log();
  console.log('  Logs:');
  console.log(`    ${chalk.cyan(`tail -f ${launchdLogPath()}`)}`);
  console.log();
}

/** Windows: scheduled task at logon. */
function installWindowsTask(spec: ServiceSpec, opts: { enable?: boolean; print?: boolean }): void {
  const configDir = dirname(getRegistryPath());
  const launcher = renderWindowsLauncher(spec, configDir);
  if (opts.print) {
    console.log(launcher);
    return;
  }

  const launcherPath = windowsLauncherPath(configDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(launcherPath, launcher, { encoding: 'utf-8' });
  output.success(`Wrote ${chalk.bold(launcherPath)}`);

  const createArgs = windowsCreateTaskArgs(configDir);
  if (opts.enable) {
    runTool('schtasks.exe', createArgs);
    runTool('schtasks.exe', ['/Run', '/TN', WINDOWS_TASK_NAME]);
    output.success(`Task "${WINDOWS_TASK_NAME}" created and started. It starts at logon.`);
  } else {
    console.log();
    console.log('  Next:');
    console.log(`    ${chalk.cyan(`schtasks ${createArgs.map(quoteWindowsArg).join(' ')}`)}`);
    console.log(`    ${chalk.cyan(`schtasks /Run /TN "${WINDOWS_TASK_NAME}"`)}`);
  }

  console.log();
  console.log('  Logs:');
  console.log(`    ${chalk.cyan(windowsLogPath(configDir))}`);
  console.log();
}

const SERVICE_KINDS: Partial<Record<NodeJS.Platform, string>> = {
  linux: 'systemd user unit',
  darwin: 'launchd agent',
  win32: 'scheduled task at logon',
};

function requireServicePlatform(): 'linux' | 'darwin' | 'win32' {
  const platform = process.platform;
  if (platform === 'linux' || platform === 'darwin' || platform === 'win32') return platform;
  throw new Error(
    `No background service is available for ${platform}. Run \`cf sync watch\` under whatever keeps processes alive there.`,
  );
}

const installServiceCommand = new Command('install-service')
  .description('Run `cf sync watch` in the background at login (systemd on Linux, launchd on macOS, a scheduled task on Windows)')
  .option('--interval <seconds>', 'Base poll interval', String(DEFAULT_INTERVAL_S))
  .option('--pull-only', 'Service pulls only, never pushes local changes up')
  .option('-p, --project <id>', 'Limit the service to one project')
  .option('--exec-path <path>', 'Path to the cf entry point (defaults to the running one)')
  .option('--enable', 'Also register and start the service now')
  .option('--print', 'Print the service definition to stdout instead of writing it')
  .action((opts) => {
    try {
      const platform = requireServicePlatform();
      const spec = serviceSpecFrom(opts);

      if (!opts.print) console.log(chalk.dim(`  Installing as a ${SERVICE_KINDS[platform]}.`));
      if (platform === 'linux') installSystemd(spec, opts);
      else if (platform === 'darwin') installLaunchd(spec, opts);
      else installWindowsTask(spec, opts);
    } catch (err) {
      output.handleError(err);
    }
  });

/** Removes a file if it is there. Returns whether it was. */
function removeIfPresent(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** Runs a tool whose failure only means "there was nothing to stop". */
function runQuietly(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: 'ignore' });
  } catch {
    // Not installed, not running, or already gone.
  }
}

const uninstallServiceCommand = new Command('uninstall-service')
  .description('Stop the background sync service and remove what `install-service` wrote')
  .action(() => {
    try {
      const platform = requireServicePlatform();
      let removed: boolean;

      if (platform === 'linux') {
        runQuietly('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
        removed = removeIfPresent(join(homedir(), '.config', 'systemd', 'user', SERVICE_NAME));
        runQuietly('systemctl', ['--user', 'daemon-reload']);
      } else if (platform === 'darwin') {
        runQuietly('launchctl', ['unload', '-w', launchdPlistPath()]);
        removed = removeIfPresent(launchdPlistPath());
      } else {
        const configDir = dirname(getRegistryPath());
        runQuietly('schtasks.exe', ['/End', '/TN', WINDOWS_TASK_NAME]);
        runQuietly('schtasks.exe', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']);
        removed = removeIfPresent(windowsLauncherPath(configDir));
      }

      if (removed) output.success('Background sync service removed. Registered projects and saved login are untouched.');
      else output.info('No background sync service was installed.');
    } catch (err) {
      output.handleError(err);
    }
  });

// ---------------------------------------------------------------------------

export const syncCommand = new Command('sync')
  .description('Keep local .env files in sync with CryptFlare environments')
  .addCommand(initCommand)
  .addCommand(autoCommand)
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(removeCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(statusCommand)
  .addCommand(runCommand)
  .addCommand(watchCommand)
  .addCommand(installServiceCommand)
  .addCommand(uninstallServiceCommand);
