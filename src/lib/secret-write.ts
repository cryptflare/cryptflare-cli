import type { CryptFlare } from '@cryptflare/sdk';

export type WriteScope = {
  organisation: string;
  workspace: string;
  environment: string;
  podId?: string;
};

export type SecretWrite = {
  environment: string;
  key: string;
  version: number;
  action: 'created' | 'rotated';
};

export type SecretWriteOptions = {
  description?: string;
  metadata?: Record<string, string>;
};

/**
 * Creates a secret, or rotates it when the key already exists.
 *
 * `cf secret set` was documented as "create or update" but only ever
 * created, so setting a key a second time failed with a conflict and the
 * caller had to know to reach for `rotate` instead.
 *
 * Create is tried first because it is the only call that can place the
 * secret in a pod and attach a description; the conflict is the signal that
 * the key is already there.
 */
export async function upsertSecret(
  client: CryptFlare,
  scope: WriteScope,
  key: string,
  value: string,
  options: SecretWriteOptions = {},
): Promise<SecretWrite> {
  try {
    const created = await client.secrets.create({
      ...scope,
      key,
      value,
      ...(options.description ? { description: options.description } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    });
    return { environment: scope.environment, key: created.key, version: created.version, action: 'created' };
  } catch (err) {
    if ((err as { status?: number }).status !== 409) throw err;
  }

  const { podId: _podId, ...keyScope } = scope;
  const rotated = await client.secrets.rotate({ ...keyScope, key, value });
  return { environment: scope.environment, key: rotated.key ?? key, version: rotated.version, action: 'rotated' };
}

export type MultiWriteResult = {
  written: SecretWrite[];
  failed: Array<{ environment: string; message: string }>;
};

/**
 * Writes one value to several environments of a workspace.
 *
 * The environments are independent, so one refusing the write (a locked
 * secret, a missing permission) must not stop the others; every outcome is
 * reported and the caller decides what a partial result means.
 */
export async function upsertAcrossEnvironments(
  client: CryptFlare,
  scope: Omit<WriteScope, 'environment'>,
  environments: string[],
  key: string,
  value: string,
  options: SecretWriteOptions = {},
): Promise<MultiWriteResult> {
  const result: MultiWriteResult = { written: [], failed: [] };
  for (const environment of environments) {
    try {
      result.written.push(await upsertSecret(client, { ...scope, environment }, key, value, options));
    } catch (err) {
      result.failed.push({ environment, message: (err as Error).message ?? String(err) });
    }
  }
  return result;
}
