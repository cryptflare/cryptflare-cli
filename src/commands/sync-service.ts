/**
 * `cf sync` - multi-project, bidirectional env-file sync plus the Linux
 * service that runs it unattended.
 *
 * Distinct from the older top-level `cf pull` / `cf push` / `cf daemon`, which
 * operate on a single file passed by flag and hold no state between runs. This
 * group reads a registry of projects, keeps a merge base per bound file, and is
 * designed to be the thing systemd starts and forgets about.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { Command } from 'commander';
import chalk from 'chalk';

import { getClient } from '../lib/api.js';
import { getOrg, getDefault } from '../lib/config.js';
import { requirePermission } from '../lib/permissions.js';
import * as output from '../lib/output.js';
import { applyPlan, countActionable, planBinding, type ApplyResult, type BindingPlan } from '../lib/sync-engine.js';
import {
  bindingFilePath,
  getRegistryPath,
  loadRegistry,
  saveRegistry,
  type SyncProject,
} from '../lib/sync-registry.js';
import { getStatePath, loadState, saveState } from '../lib/sync-state.js';
import { revealSecrets } from '../lib/reveal.js';
import { applyEnvChanges, parseEnvContent, renderEnvFile } from '../lib/env-file.js';
import { MANIFEST_FILENAME, hasManifest, loadManifest, writeManifest } from '../lib/project-manifest.js';

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 15;
const BACKOFF_CEILING_MS = 600_000;
const BACKOFF_MULTIPLIER = 2;
const NO_CHANGE_GRACE = 5;
const JITTER_PCT = 0.1;
const SERVICE_NAME = 'cryptflare-sync.service';

function jittered(ms: number): number {
  return Math.max(5_000, Math.round(ms + ms * JITTER_PCT * (Math.random() * 2 - 1)));
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

      const bindings = bindArgs.map((raw) => {
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
          };
        }
        return { file, environment: target };
      });

      // Only needed as a default for bindings that did not name their own.
      const workspace = opts.workspace ?? getDefault('workspace');
      if (!workspace && bindings.some((b) => !b.workspace)) {
        throw new Error(
          'No workspace. Pass --workspace, set one with `cf config set defaults.workspace <slug>`, ' +
            'or qualify each binding as --bind <file>=<workspace>/<environment>.',
        );
      }

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
  .description('Set up a cloned project from its committed .cryptflare.json: pull every bound file, then register for sync')
  .argument('[path]', 'Project root (defaults to the current directory)', '.')
  .option('--write', 'Generate .cryptflare.json from this project\'s existing sync registration instead')
  .option('--no-pull', 'Register for sync without pulling files first')
  .option('--no-register', 'Pull files without registering for ongoing sync')
  .option('-p, --project <id>', 'Which registered project to write from, when several share this directory')
  .option('--id <id>', 'Register under this id instead of the manifest\'s, for a second checkout of the same repo')
  .action(async (pathArg: string, opts) => {
    try {
      const root = resolve(pathArg);
      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`);

      if (opts.write) {
        writeManifestFromRegistry(root, opts.project);
        return;
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

      if (opts.pull !== false) {
        await requirePermission('secrets:read');
        const client = getClient();

        for (const binding of manifest.bindings) {
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

      if (opts.register !== false) {
        const registry = loadRegistry();
        const project: SyncProject = {
          id,
          path: root,
          ...(org ? { org } : {}),
          ...(manifest.workspace ? { workspace: manifest.workspace } : {}),
          enabled: true,
          bindings: manifest.bindings.map((b) => ({
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
        output.warn(`${failures.length} of ${manifest.bindings.length} file(s) could not be pulled:`);
        for (const f of failures) console.error(`    ${f.file}  ${chalk.dim(f.message.slice(0, 100))}`);
        console.error(chalk.dim(`\n  Re-run ${chalk.cyan('cf sync init')} to retry only what is missing.`));
        process.exit(1);
      }

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
  'skip-new-local': '..',
  'skip-local-deleted': '..',
  'skip-remote-deleted': '..',
  'skip-multiline': '..',
  'needs-compare': '??',
};

function describeAction(type: string): string {
  switch (type) {
    case 'skip-new-local':
      return 'new local key, not pushed (guarded policy) - `cf push` to create it';
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
    const note = describeAction(action.type);
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
};

type PassSummary = { pulled: number; pushed: number; conflicts: number; failures: number; changed: boolean };

async function runPass(opts: PassOptions): Promise<PassSummary> {
  const projects = selectProjects(opts.projectId);
  const summary: PassSummary = { pulled: 0, pushed: 0, conflicts: 0, failures: 0, changed: false };
  if (projects.length === 0) return summary;

  const client = getClient();
  const state = loadState();
  let stateDirty = false;

  for (const project of projects) {
    for (const binding of project.bindings) {
      const label = `${project.id}/${binding.file}`;
      try {
        // A dry run reports; it must not consume the reveal budget the real
        // pass needs, so first-contact keys come back as `needs-compare`.
        const plan = await planBinding(client, project, binding, state, { reveal: !opts.dryRun });

        if (opts.dryRun) {
          printPlan(plan, opts.verbose);
          continue;
        }

        const result = await applyPlan(client, plan, state, { push: opts.push });
        stateDirty = true;
        summary.pulled += result.pulled.length;
        summary.pushed += result.pushed.length;
        summary.conflicts += result.conflicts.length;
        summary.changed ||= result.changed;
        logResult(label, bindingFilePath(project, binding), result, opts);
      } catch (err) {
        summary.failures++;
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

  for (const skip of result.skipped) {
    const signature = `${label}:${skip.type}:${skip.key}`;
    if (opts.loggedSkips) {
      if (opts.loggedSkips.has(signature)) continue;
      opts.loggedSkips.add(signature);
    }
    console.error(chalk.yellow(`[${label}] ${skip.key}: ${describeAction(skip.type)}`));
  }

  if (!result.changed && !opts.quiet && result.skipped.length === 0) {
    console.error(chalk.dim(`[${label}] no change`));
  }
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

      const summary = await runPass({
        projectId: opts.project,
        push: !opts.pullOnly,
        dryRun: Boolean(opts.dryRun),
        verbose: false,
        quiet: Boolean(opts.quiet),
      });

      if (opts.dryRun) return;
      if (summary.failures > 0) {
        output.warn(`${summary.failures} binding(s) failed. See errors above.`);
        process.exit(1);
      }
      output.success(
        `Sync complete: ${summary.pulled} pulled, ${summary.pushed} pushed, ${summary.conflicts} conflict(s).`,
      );
    } catch (err) {
      output.handleError(err);
    }
  });

const watchCommand = new Command('watch')
  .description('Long-running loop that syncs every registered project (what the systemd service runs)')
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

      const projects = selectProjects(opts.project);
      if (projects.length === 0) {
        throw new Error(`No enabled projects in ${getRegistryPath()}. Add one with \`cf sync add\`.`);
      }

      let stop = false;
      const onSignal = (sig: NodeJS.Signals) => {
        if (stop) return;
        stop = true;
        console.error(chalk.dim(`[sync] ${sig} received, finishing current pass...`));
      };
      process.on('SIGTERM', onSignal);
      process.on('SIGINT', onSignal);

      const bindingCount = projects.reduce((n, p) => n + p.bindings.length, 0);
      console.error(
        chalk.bold(
          `[sync] watching ${projects.length} project(s), ${bindingCount} file(s), every ${intervalS}s` +
            (opts.pullOnly ? ' (pull-only)' : ''),
        ),
      );

      const loggedSkips = new Set<string>();
      let backoffMs = baseIntervalMs;
      let idlePasses = 0;

      while (!stop) {
        const summary = await runPass({
          projectId: opts.project,
          push: !opts.pullOnly,
          dryRun: false,
          verbose: false,
          quiet: Boolean(opts.quiet),
          loggedSkips,
        });

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
        await new Promise<void>((resolveSleep) => {
          const timer = setTimeout(resolveSleep, sleepMs);
          const wake = () => {
            clearTimeout(timer);
            resolveSleep();
          };
          process.once('SIGTERM', wake);
          process.once('SIGINT', wake);
        });
      }

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

const installServiceCommand = new Command('install-service')
  .description('Write a systemd user unit that runs `cf sync watch` in the background')
  .option('--interval <seconds>', 'Base poll interval', String(DEFAULT_INTERVAL_S))
  .option('--pull-only', 'Service pulls only, never pushes local changes up')
  .option('-p, --project <id>', 'Limit the service to one project')
  .option('--exec-path <path>', 'Path to the cf entry point (defaults to the running one)')
  .option('--enable', 'Also run daemon-reload, enable --now, and enable-linger')
  .option('--print', 'Print the unit to stdout instead of writing it')
  .action((opts) => {
    try {
      if (process.platform !== 'linux') {
        throw new Error(`install-service targets systemd on Linux; this host is ${process.platform}.`);
      }
      const interval = Number(opts.interval);
      if (!Number.isFinite(interval) || interval < MIN_INTERVAL_S) {
        throw new Error(`--interval must be a number >= ${MIN_INTERVAL_S}`);
      }

      const execPath = resolve(opts.execPath ?? process.argv[1] ?? 'cf');
      if (!existsSync(execPath)) {
        // A unit whose ExecStart does not exist fails silently in the
        // background. Catch it here, while someone is still watching.
        throw new Error(`CLI entry point not found at ${execPath}. Pass --exec-path <path to cf>.`);
      }

      const unit = renderUnit({
        interval,
        pullOnly: Boolean(opts.pullOnly),
        project: opts.project,
        execPath,
      });
      if (opts.print) {
        console.log(unit);
        return;
      }

      const unitDir = join(homedir(), '.config', 'systemd', 'user');
      const unitPath = join(unitDir, SERVICE_NAME);
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unitPath, unit, { encoding: 'utf-8', mode: 0o644 });
      output.success(`Wrote ${chalk.bold(unitPath)}`);

      if (opts.enable) {
        const run = (args: string[]) => execFileSync(args[0]!, args.slice(1), { stdio: 'inherit' });
        run(['systemctl', '--user', 'daemon-reload']);
        run(['systemctl', '--user', 'enable', '--now', SERVICE_NAME]);
        try {
          // Without lingering, the user manager is torn down at logout and the
          // service dies with it - fatal for the "sync while I am away" case.
          run(['loginctl', 'enable-linger', process.env['USER'] ?? '']);
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
    } catch (err) {
      output.handleError(err);
    }
  });

// ---------------------------------------------------------------------------

export const syncCommand = new Command('sync')
  .description('Keep local .env files in sync with CryptFlare environments')
  .addCommand(initCommand)
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(removeCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(statusCommand)
  .addCommand(runCommand)
  .addCommand(watchCommand)
  .addCommand(installServiceCommand);
