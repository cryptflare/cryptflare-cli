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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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
    '-b, --bind <file=environment...>',
    'Bind an env file to an environment. Repeatable: --bind .env=dev --bind .env.local=dev-local',
  )
  .action(async (pathArg: string, opts) => {
    try {
      const root = resolve(pathArg);
      if (!existsSync(root)) throw new Error(`Directory not found: ${root}`);

      const workspace = opts.workspace ?? getDefault('workspace');
      if (!workspace) {
        throw new Error('No workspace. Pass --workspace or set one with `cf config set defaults.workspace <slug>`.');
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
        if (idx <= 0) throw new Error(`Invalid --bind "${raw}". Expected <file>=<environment>.`);
        return { file: raw.slice(0, idx), environment: raw.slice(idx + 1) };
      });

      const id = opts.id ?? basename(root);
      const registry = loadRegistry();
      const existingIdx = registry.projects.findIndex((p) => p.id === id);
      const project: SyncProject = {
        id,
        path: root,
        ...(org ? { org } : {}),
        workspace,
        enabled: true,
        bindings,
      };

      if (existingIdx >= 0) registry.projects[existingIdx] = project;
      else registry.projects.push(project);
      saveRegistry(registry);

      output.success(`${existingIdx >= 0 ? 'Updated' : 'Registered'} ${chalk.bold(id)} -> ${root}`);
      for (const b of bindings) {
        const marker = existsSync(join(root, b.file)) ? chalk.dim('(exists)') : chalk.yellow('(will be created)');
        console.log(`    ${b.file} ${chalk.dim('->')} ${workspace}/${b.environment} ${marker}`);
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
            workspace: p.workspace,
            environment: b.environment,
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
};

const ACTION_GLYPH: Record<string, string> = {
  pull: '<-',
  push: '->',
  conflict: '!!',
  'skip-new-local': '..',
  'skip-local-deleted': '..',
  'skip-remote-deleted': '..',
  'skip-multiline': '..',
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
    default:
      return '';
  }
}

function printPlan(plan: BindingPlan, verbose: boolean): void {
  const label = `${plan.project.id}/${plan.binding.file}`;
  const scope = `${plan.project.workspace}/${plan.binding.environment}`;
  const actionable = countActionable(plan);

  if (actionable === 0 && !verbose) return;

  console.log(
    `${chalk.bold(label)} ${chalk.dim(`<-> ${scope}`)}${plan.creating ? chalk.yellow(' (file will be created)') : ''}`,
  );
  for (const action of plan.actions) {
    if (!verbose && action.type.startsWith('skip-')) continue;
    const style = ACTION_STYLE[action.type] ?? chalk.white;
    const note = describeAction(action.type);
    console.log(`    ${style(`${ACTION_GLYPH[action.type]} ${action.key}`)}${note ? chalk.dim(`  ${note}`) : ''}`);
  }
  if (actionable === 0) console.log(chalk.dim('    in sync'));
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
        const plan = await planBinding(client, project, binding, state);

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
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(removeCommand)
  .addCommand(enableCommand)
  .addCommand(disableCommand)
  .addCommand(statusCommand)
  .addCommand(runCommand)
  .addCommand(watchCommand)
  .addCommand(installServiceCommand);
