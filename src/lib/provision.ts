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
export async function ensureScope(
  client: CryptFlare,
  scope: Scope,
): Promise<{ createdWorkspace: boolean; createdEnvironment: boolean }> {
  const org = scope.organisation;

  const workspaces = (await client.workspaces.list({ ...(org ? { organisation: org } : {}) })) as
    | Array<{ slug: string }>
    | { data?: Array<{ slug: string }> };
  const wsList = Array.isArray(workspaces) ? workspaces : workspaces.data ?? [];

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
  }

  const environments = (await client.environments.list({
    ...(org ? { organisation: org } : {}),
    workspace: scope.workspace,
  })) as Array<{ slug: string }> | { data?: Array<{ slug: string }> };
  const envList = Array.isArray(environments) ? environments : environments.data ?? [];

  let createdEnvironment = false;
  if (!envList.some((e) => e.slug === scope.environment)) {
    await client.environments.create({
      ...(org ? { organisation: org } : {}),
      workspace: scope.workspace,
      name: scope.environment,
      slug: scope.environment,
    });
    createdEnvironment = true;
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

  for (const batch of chunk(toCreate)) {
    await client.secrets.batchCreate({ ...scope, secrets: batch });
  }
  for (const batch of chunk(toUpdate)) {
    await client.secrets.batchUpdate({ ...scope, secrets: batch });
  }

  return { created: toCreate.length, updated: toUpdate.length };
}
