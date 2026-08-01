import type { CryptFlare } from '@cryptflare/sdk';

import { MAX_BATCH_SIZE, chunk } from './secret-validation.js';

type Scope = {
  organisation?: string;
  workspace: string;
  environment: string;
  podId?: string;
};

/**
 * Decrypts secrets in as few requests as possible.
 *
 * Every caller here used to loop `secrets.reveal()` once per key. That is one
 * full worker invocation per secret - auth, org context, RBAC, a quota
 * Durable Object hop, several D1 queries - to move one value, so bootstrapping
 * a ten-file repository cost 69 requests. `secrets.revealMany` does the same
 * work in one request per 100 keys.
 *
 * The rate limit is unchanged: the server charges one unit per key against the
 * same bucket a single reveal uses. This buys round trips, not budget.
 *
 * @param keys Keys to fetch. Omit to fetch every secret in the environment.
 */
export async function revealSecrets(
  client: CryptFlare,
  scope: Scope,
  keys?: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();

  if (keys && keys.length === 0) return out;

  try {
    // Chunked because the endpoint caps a batch at MAX_BATCH_SIZE, the same
    // ceiling the create/update batches use.
    const batches = keys ? chunk(keys) : [undefined];
    for (const batch of batches) {
      const res = await client.secrets.revealMany({
        ...scope,
        ...(batch ? { keys: batch } : {}),
      });
      for (const secret of res.secrets) out.set(secret.key, secret.value);
    }
    return out;
  } catch (err) {
    // An API deployed before this endpoint existed answers 404. Falling back
    // keeps a newer CLI working against an older server instead of failing
    // outright; everything else is a real error and propagates.
    if ((err as { status?: number }).status !== 404) throw err;
    return revealOneByOne(client, scope, keys);
  }
}

/** Pre-batch behaviour, kept only as the compatibility path. */
async function revealOneByOne(
  client: CryptFlare,
  scope: Scope,
  keys?: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let wanted = keys;

  if (!wanted) {
    wanted = [];
    for await (const secret of await client.secrets.list(scope)) wanted.push(secret.key);
  }

  for (const key of wanted) {
    const revealed = await client.secrets.reveal({ ...scope, key });
    out.set(revealed.key, revealed.value);
  }
  return out;
}

export { MAX_BATCH_SIZE };
