import type { CryptFlare } from '@cryptflare/sdk';

import { chunk, validateSecrets } from './secret-validation.js';

type Scope = { organisation?: string; workspace: string; environment: string };

/** What a provisioning pass did, so the caller can report it honestly. */
export type ProvisionResult = {
  createdWorkspace: boolean;
  createdEnvironment: boolean;
  created: number;
  updated: number;
};

/**
 * Creates the workspace and environment a binding names, if they are missing.
 *
 * `cf sync init` only ever pulled, which assumes someone already built the
 * remote structure by hand - `cf workspace create` then `cf environment create`
 * per environment. For a repository whose manifest names six environments that
 * is thirteen commands before the first secret moves, and the failure mode when
 * you skip it is an opaque "workspace not found" from the pull.
 *
 * Idempotent: existing workspaces and environments are left untouched, so this
 * is safe to re-run over a partially provisioned project.
 */
export type ScopeCache = {
  workspaces?: Set<string>;
  environments: Map<string, Set<string>>;
};

/** Fresh cache for one provisioning run. */
export function newScopeCache(): ScopeCache {
  return { environments: new Map() };
}

type SlugList = Array<{ slug: string }> | { data?: Array<{ slug: string }> };

function slugs(list: SlugList): Set<string> {
  return new Set((Array.isArray(list) ? list : list.data ?? []).map((item) => item.slug));
}

/**
 * The workspaces that exist, listed once per run, not once per binding. A
 * twelve-binding repository was making twenty-four calls to the two heaviest
 * read endpoints before moving a single secret, which on a loaded API is
 * twenty-four chances to fail.
 */
export async function knownWorkspaces(client: CryptFlare, org: string | undefined, cache: ScopeCache): Promise<Set<string>> {
  if (!cache.workspaces) {
    cache.workspaces = slugs((await client.workspaces.list({ ...(org ? { organisation: org } : {}) })) as SlugList);
  }
  return cache.workspaces;
}

/** The environments of a workspace that exists, listed once per run. */
export async function knownEnvironments(
  client: CryptFlare,
  org: string | undefined,
  workspace: string,
  cache: ScopeCache,
): Promise<Set<string>> {
  let known = cache.environments.get(workspace);
  if (!known) {
    known = slugs((await client.environments.list({ ...(org ? { organisation: org } : {}), workspace })) as SlugList);
    cache.environments.set(workspace, known);
  }
  return known;
}

export async function ensureScope(
  client: CryptFlare,
  scope: Scope,
  cache: ScopeCache = newScopeCache(),
): Promise<{ createdWorkspace: boolean; createdEnvironment: boolean }> {
  const org = scope.organisation;
  const wsList = [...(await knownWorkspaces(client, org, cache))].map((slug) => ({ slug }));

  let createdWorkspace = false;
  if (!wsList.some((w) => w.slug === scope.workspace)) {
    await client.workspaces.create({
      ...(org ? { organisation: org } : {}),
      // The manifest carries slugs, not display names. Using the slug for both
      // keeps what the dashboard shows identical to what the manifest says,
      // rather than inventing a prettier name that then disagrees with it.
      name: scope.workspace,
      slug: scope.workspace,
    });
    createdWorkspace = true;
    // Record it so a later binding in the same run does not re-create or
    // re-list it, and so a freshly created workspace is known immediately -
    // D1 reads are eventually consistent, so re-listing could miss it.
    cache.workspaces!.add(scope.workspace);
    cache.environments.set(scope.workspace, new Set());
  }

  const envList = [...(await knownEnvironments(client, org, scope.workspace, cache))].map((slug) => ({ slug }));

  let createdEnvironment = false;
  if (!envList.some((e) => e.slug === scope.environment)) {
    await client.environments.create({
      ...(org ? { organisation: org } : {}),
      workspace: scope.workspace,
      name: scope.environment,
      slug: scope.environment,
    });
    createdEnvironment = true;
    cache.environments.get(scope.workspace)!.add(scope.environment);
  }

  return { createdWorkspace, createdEnvironment };
}

/**
 * Seeds an environment from a local file's contents.
 *
 * Validates the whole set before sending anything: a rejection partway through
 * would leave the environment half-written, and the caller could not tell which
 * keys had already landed.
 */
export async function seedFromValues(
  client: CryptFlare,
  scope: Scope,
  values: Map<string, string>,
): Promise<{ created: number; updated: number }> {
  if (values.size === 0) return { created: 0, updated: 0 };

  const problems = validateSecrets(values);
  if (problems.length > 0) {
    const detail = problems.map((p) => `${p.key}: ${p.reason}`).join('; ');
    throw new Error(`${problems.length} invalid secret(s), nothing pushed - ${detail}`);
  }

  const remoteKeys = new Set<string>();
  for await (const secret of await client.secrets.list(scope)) remoteKeys.add(secret.key);

  const toCreate: Array<{ key: string; value: string }> = [];
  const toUpdate: Array<{ key: string; value: string }> = [];
  for (const [key, value] of values) {
    if (remoteKeys.has(key)) toUpdate.push({ key, value });
    else toCreate.push({ key, value });
  }

  const failures: string[] = [];
  for (const batch of chunk(toCreate)) {
    failures.push(...failedItems(await client.secrets.batchCreate({ ...scope, secrets: batch })));
  }
  for (const batch of chunk(toUpdate)) {
    failures.push(...failedItems(await client.secrets.batchUpdate({ ...scope, secrets: batch })));
  }

  if (failures.length > 0) {
    // Seeding reported success on the strength of the request being accepted.
    // The server now says what happened to each key, so say it too.
    throw new Error(`${failures.length} secret(s) were not written - ${failures.join('; ')}`);
  }

  return { created: toCreate.length, updated: toUpdate.length };
}

/**
 * Items a batch did not write, as `KEY: reason`. A key skipped because it
 * already exists is not a failure here: another writer got there first, and
 * the next sync pass reconciles the two values.
 */
function failedItems(response: {
  results?: Array<{ key: string; status: string; reason?: string; error?: string }> | null;
}): string[] {
  return (response.results ?? [])
    .filter((item) => item.status === 'error')
    .map((item) => `${item.key}: ${item.error ?? item.reason ?? 'not written'}`);
}
