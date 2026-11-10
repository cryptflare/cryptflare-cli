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
 * full request per secret to move one value, so bootstrapping a ten-file
 * repository cost 69 requests. `secrets.revealMany` does the same work in
 * one request per 100 keys, and `secrets.revealAll` walks a whole
 * environment page by page.
 *
 * The server counts the reveal budget in secrets per minute. When it is
 * exhausted the SDK waits out `Retry-After` and continues, so a large
 * bootstrap slows down instead of failing.
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
    if (!keys) {
      for (const secret of await client.secrets.revealAll(scope)) out.set(secret.key, secret.value);
      return out;
    }

    // Chunked because the endpoint caps named keys at MAX_BATCH_SIZE, the
    // same ceiling the create/update batches use.
    for (const batch of chunk(keys)) {
      const res = await client.secrets.revealMany({ ...scope, keys: batch });
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
