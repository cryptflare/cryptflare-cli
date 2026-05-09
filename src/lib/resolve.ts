import { getOrg, getDefault } from './config.js';

/**
 * Resolves workspace and environment from flags or config defaults.
 * Exits with error if required values are missing.
 */
export function resolveContext(opts: { workspace?: string; env?: string; org?: string }) {
  const org = opts.org ?? getOrg();
  if (!org) {
    console.error('No organisation selected. Run `cf org select` or pass --org.');
    process.exit(1);
  }

  const workspace = opts.workspace ?? getDefault('workspace');
  if (!workspace) {
    console.error('No workspace specified. Pass --workspace or set a default with `cf config set defaults.workspace <slug>`.');
    process.exit(1);
  }

  const env = opts.env ?? getDefault('environment');
  if (!env) {
    console.error('No environment specified. Pass --env or set a default with `cf config set defaults.environment <slug>`.');
    process.exit(1);
  }

  return { org, workspace, env };
}

export function resolveOrg(opts: { org?: string }) {
  const org = opts.org ?? getOrg();
  if (!org) {
    console.error('No organisation selected. Run `cf org select` or pass --org.');
    process.exit(1);
  }
  return org;
}
