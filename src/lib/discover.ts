/**
 * Works out a `.cryptflare.json` for a repository from the env files in it.
 *
 * Setting a repository up used to mean writing the manifest by hand: finding
 * every env file, inventing an environment name for each, and remembering
 * the rule that two files must never share one. This does that part.
 *
 * ## Naming
 *
 * One workspace per repository, one environment per file:
 *
 *   workspace   = the repository directory name
 *   environment = <app>-<stage>[-<kind>]
 *
 * - `app` is where the file lives: `root` at the top, otherwise the path with
 *   a leading `apps/` dropped and `packages/` shortened to `pkg`.
 * - `stage` comes from the file name: `.env.production` is `production`,
 *   and a file that names no stage is `dev`.
 * - `kind` says what reads the file: `worker` for wrangler's `*.vars`,
 *   `shell` for direnv's `.envrc`, nothing for `.env` build variables.
 *
 * ## One file per environment
 *
 * The server keys secrets by (environment, key). Two files bound to one
 * environment would overwrite each other's values on every pass, so when two
 * files land on the same name, each gets its file name appended.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';

import type { CaptureMode } from './capture.js';
import type { ManifestBinding, ProjectManifest } from './project-manifest.js';

/** Directories that never hold a project's own env files. */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.wrangler', '.venv', 'venv',
  'vendor', 'target', 'references', 'repositories', 'templates', '.cache',
]);

/** Suffixes of files that are committed on purpose and hold no real values. */
const EXAMPLE_SUFFIX = /\.(example|sample|template|dist|hbs|defaults)$/i;

/**
 * Files that sit beside an env file and share its name but are not one: the
 * sync engine's conflict sidecars and half-written temporaries, and editor
 * backups. Binding one would upload a stale copy as its own environment.
 */
const LEFTOVER = /(\.cf-conflict-.*|\.tmp-\d+|\.bak|\.orig|\.old|\.swp|~)$/i;

const ENV_FILE = /^(\.env(\..+)?|\.envrc|\.dev\.vars(\..+)?|\.[a-z0-9-]+\.vars)$/i;

/** Stage names recognised in a file name, mapped to the stage they mean. */
const STAGES: Record<string, string> = {
  dev: 'dev',
  development: 'dev',
  local: 'dev',
  test: 'test',
  testing: 'test',
  staging: 'staging',
  stage: 'staging',
  preview: 'preview',
  prod: 'production',
  production: 'production',
};

const DEFAULT_STAGE = 'dev';
const MAX_SEARCH_DEPTH = 6;

export type DiscoveredFile = {
  /** Path relative to the repository root, with forward slashes. */
  file: string;
  environment: string;
  stage: string;
  capture: CaptureMode;
};

/** Whether a file name is an env file this tool manages. */
export function isEnvFileName(name: string): boolean {
  return ENV_FILE.test(name) && !EXAMPLE_SUFFIX.test(name) && !LEFTOVER.test(name);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The stage a file name declares, or `dev` when it declares none. */
export function stageOf(name: string): string {
  const words = name.toLowerCase().split('.').filter(Boolean);
  for (const word of words) {
    const stage = STAGES[word];
    // `.dev.vars.production` says "dev" (wrangler's file name) and then the
    // real stage. The last recognised word is the one that was added to say
    // which stage this copy is for.
    if (stage && word !== 'dev') return stage;
  }
  return words.some((word) => STAGES[word] === 'dev') ? 'dev' : DEFAULT_STAGE;
}

function kindOf(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower === '.envrc') return 'shell';
  if (lower.endsWith('.vars') || lower.startsWith('.dev.vars')) return 'worker';
  return null;
}

function appOf(directory: string): string {
  if (directory === '' || directory === '.') return 'root';
  const segments = directory.split('/');
  if (segments[0] === 'apps' && segments.length > 1) segments.shift();
  else if (segments[0] === 'packages') segments[0] = 'pkg';
  return slug(segments.join('-')) || 'root';
}

/** The words of a file name that tell two colliding files apart. */
function fileToken(name: string): string {
  return slug(name.replace(/^\./, '')) || 'env';
}

/**
 * Turns a list of env file paths into bindings.
 *
 * @param files Paths relative to the repository root, forward slashes.
 */
export function planBindings(files: readonly string[]): DiscoveredFile[] {
  const planned = [...files].sort().map((file) => {
    const name = basename(file);
    const directory = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const stage = stageOf(name);
    const kind = kindOf(name);
    return {
      file,
      name,
      stage,
      environment: [appOf(directory), stage, kind].filter(Boolean).join('-'),
    };
  });

  const counts = new Map<string, number>();
  for (const item of planned) counts.set(item.environment, (counts.get(item.environment) ?? 0) + 1);

  return planned.map((item) => ({
    file: item.file,
    stage: item.stage,
    // Every file that would share a name gets its own file name appended,
    // not just the second one, so neither looks like "the real one".
    environment: (counts.get(item.environment) ?? 0) > 1 ? `${item.environment}-${fileToken(item.name)}` : item.environment,
    // A new line in a development file is a new secret. Anywhere else, ask.
    capture: item.stage === DEFAULT_STAGE ? 'auto' : 'off',
  }));
}

/**
 * Names environments for env files that appeared after the manifest was
 * written, using the same rules as {@link planBindings}.
 *
 * Existing bindings are never renamed, so the rule that every colliding file
 * gets its file name appended cannot be applied to them. A new file whose
 * natural name is already taken gets its own file name appended instead, and
 * a number after that if even that is taken.
 *
 * @param existing Bindings already in the manifest, as written (possibly by hand).
 * @param files Every env file now in the repository, relative, forward slashes.
 * @returns One entry per file that has no binding yet.
 */
export function planNewBindings(
  existing: ReadonlyArray<{ file: string; environment?: string | undefined }>,
  files: readonly string[],
): DiscoveredFile[] {
  const bound = new Set(existing.map((binding) => binding.file));
  const fresh = files.filter((file) => !bound.has(file));
  if (fresh.length === 0) return [];

  const taken = new Set(existing.map((binding) => binding.environment).filter((name): name is string => Boolean(name)));
  const added: DiscoveredFile[] = [];

  // Planned together with the bound files so a new `.env.local` beside a
  // bound `.env` is seen to collide with it, exactly as it would have been
  // had both existed on day one.
  for (const item of planBindings([...bound, ...fresh])) {
    if (bound.has(item.file)) continue;

    let environment = item.environment;
    const token = fileToken(basename(item.file));
    if (taken.has(environment) && !environment.endsWith(`-${token}`)) environment = `${environment}-${token}`;
    const stem = environment;
    for (let n = 2; taken.has(environment); n++) environment = `${stem}-${n}`;

    taken.add(environment);
    added.push({ ...item, environment });
  }
  return added;
}

/** Finds env files under a directory, skipping dependencies, build output and examples. */
export function findEnvFiles(root: string): string[] {
  const found: string[] = [];

  const walk = (directory: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // Unreadable directory: nothing of ours to find there.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < MAX_SEARCH_DEPTH && !SKIPPED_DIRECTORIES.has(entry.name)) walk(join(directory, entry.name), depth + 1);
      } else if (entry.isFile() && isEnvFileName(entry.name)) {
        found.push(relative(root, join(directory, entry.name)).split(sep).join('/'));
      }
    }
  };

  walk(root, 0);
  return found.sort();
}

/**
 * Builds the manifest for a repository.
 *
 * @param options.org Organisation id to record, when one is known.
 */
export function buildManifest(
  root: string,
  discovered: readonly DiscoveredFile[],
  options: { org?: string | undefined; workspace?: string | undefined } = {},
): ProjectManifest {
  const workspace = options.workspace ?? (slug(basename(root)) || 'project');
  const allAuto = discovered.every((item) => item.capture === 'auto');

  return {
    version: 1,
    id: workspace,
    ...(options.org ? { org: options.org } : {}),
    workspace,
    // The common setting goes at the top; bindings only state where they differ.
    capture: allAuto || discovered.some((item) => item.capture === 'auto') ? 'auto' : 'off',
    // Generated, so the sync service may add a binding when a new env file
    // appears. A manifest written by hand does not carry this and is left alone.
    autoDiscover: true,
    bindings: discovered.map((item): ManifestBinding => ({
      file: item.file,
      workspace,
      environment: item.environment,
      capture: item.capture,
    })),
  };
}
