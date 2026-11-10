import { getOrg, getDefault } from './config.js';
import { resolveProjectDefaults, resolveProjectTarget } from './project-context.js';

export type ContextOptions = {
  workspace?: string;
  env?: string;
  org?: string;
  /** `--binding <file>`: use the scope of this bound file from `.cryptflare.json`. */
  binding?: string;
};

export type ResolvedContext = {
  org: string;
  workspace: string;
  env: string;
  /** Pod of the binding the context came from, when it has one. */
  pod?: string;
};

/**
 * Resolves organisation, workspace and environment for a command.
 *
 * Each value is taken from the first source that has it:
 *
 * 1. the flag (`--org`, `--workspace`, `--env`)
 * 2. the repository's `.cryptflare.json`, using the binding nearest the
 *    current directory (see `./project-context.ts`)
 * 3. the CLI defaults (`cf org select`, `cf config set defaults.*`)
 *
 * Passing both `--workspace` and `--env` skips binding selection: the scope
 * is already stated, and only the organisation is still read from the
 * manifest.
 *
 * @throws Error naming the missing value and how to supply it.
 */
export function resolveContext(opts: ContextOptions, cwd: string = process.cwd()): ResolvedContext {
  const fullyStated = Boolean(opts.workspace && opts.env) && !opts.binding;
  const target = fullyStated
    ? null
    : resolveProjectTarget({
      cwd,
      binding: opts.binding,
      environment: opts.env,
      workspace: opts.workspace,
    });

  // No binding was chosen (the scope came from flags, or `--env` names an
  // environment the manifest does not bind): the project still says which
  // organisation and workspace it belongs to.
  const project = target ?? resolveProjectDefaults(cwd);

  const org = opts.org ?? project.org ?? getOrg();
  if (!org) {
    throw new Error('No organisation selected. Run `cf org select` or pass --org.');
  }

  const workspace = opts.workspace ?? project.workspace ?? getDefault('workspace');
  if (!workspace) {
    throw new Error(
      'No workspace specified. Pass --workspace, run this inside a project with a .cryptflare.json, '
        + 'or set a default with `cf config set defaults.workspace <slug>`.',
    );
  }

  const env = opts.env ?? target?.environment ?? getDefault('environment');
  if (!env) {
    throw new Error(
      'No environment specified. Pass --env, run this inside a project with a .cryptflare.json, '
        + 'or set a default with `cf config set defaults.environment <slug>`.',
    );
  }

  return { org, workspace, env, ...(target?.pod ? { pod: target.pod } : {}) };
}

/**
 * Organisation for a command that needs no workspace: the flag, then the
 * project's `.cryptflare.json`, then the CLI default.
 *
 * @throws Error when no organisation is selected.
 */
export function resolveOrg(opts: { org?: string }, cwd: string = process.cwd()): string {
  const org = opts.org ?? resolveProjectDefaults(cwd).org ?? getOrg();
  if (!org) {
    throw new Error('No organisation selected. Run `cf org select` or pass --org.');
  }
  return org;
}
