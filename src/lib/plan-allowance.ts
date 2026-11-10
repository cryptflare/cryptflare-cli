/**
 * Keeps hands-off setup inside what the organisation's plan allows.
 *
 * Setting up every repository under a directory creates a workspace per
 * repository and an environment per env file, and a plan caps both. Without
 * this the first create past the cap failed with the API's refusal, the
 * repository was registered anyway, and every later pass failed on the
 * environments that were never made.
 *
 * So before anything is created, what is needed is compared with what the
 * plan has left, when the API says (`billing.getSubscription`, which needs
 * `billing:read`). Files that do not fit are refused up front, in manifest
 * order, without a request. When the API does not say, the create is tried
 * and the plan-limit refusal is taken as the answer: after the first one, no
 * further create of that kind is attempted in the run.
 */

import type { CryptFlare, ErrorCode } from '@cryptflare/sdk';
import { BRAND } from '../_vendored/brand';

import { ensureScope, knownEnvironments, knownWorkspaces, type ScopeCache } from './provision.js';

/** The two things a new binding can need, named as the plan limits name them. */
export type PlanResource = 'workspaces' | 'environments';

export type PlanAllowance = {
  /** Plan key as the API reports it (`free`, `pro`, `team`). */
  plan: string;
  /** The limit in force, add-ons included. `Infinity` when unlimited. */
  limits: Record<PlanResource, number>;
  /** How many more may be created. Counted down as this run creates. */
  remaining: Record<PlanResource, number>;
};

type SubscriptionLike = {
  plan?: unknown;
  limits?: Record<string, unknown>;
  effectiveLimits?: Record<string, unknown>;
  usage?: Record<string, unknown>;
};

const UNLIMITED = -1;

/**
 * The code the API sends when a plan's limit is reached.
 *
 * Typed against the SDK's error codes, not imported from
 * `@cryptflare/shared`: the published CLI is built in a public mirror that
 * carries only `BRAND` from that private package, so any other import from
 * it builds here and breaks the release. For the same reason the limits are
 * always the ones the API reports, never a table copied into the CLI.
 */
const PLAN_LIMIT_CODE: ErrorCode = 'BILLING_PLAN_LIMIT';

/** `free` -> `Free`: how a plan key is shown in a message. */
function planDisplayName(plan: string): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}

/**
 * Reads the allowance out of a subscription response.
 *
 * @returns `null` when the response does not carry what is needed to judge.
 */
export function parsePlanAllowance(raw: unknown): PlanAllowance | null {
  const body = ((raw as { data?: unknown } | null)?.data ?? raw) as SubscriptionLike | null;
  if (!body || typeof body !== 'object' || typeof body.plan !== 'string' || !body.usage) return null;

  const limits = {} as Record<PlanResource, number>;
  const remaining = {} as Record<PlanResource, number>;

  for (const resource of ['workspaces', 'environments'] as const) {
    // Effective limits include purchased add-ons; the plain plan limits do not.
    const limit = body.effectiveLimits?.[resource] ?? body.limits?.[resource];
    const used = body.usage[resource];
    if (typeof limit !== 'number' || typeof used !== 'number') return null;
    limits[resource] = limit === UNLIMITED ? Infinity : limit;
    remaining[resource] = Math.max(0, limits[resource] - used);
  }
  return { plan: body.plan, limits, remaining };
}

/**
 * Asks the API what the plan has left. Any failure (a token without
 * `billing:read`, an older API, no network) means "not known", never "none".
 */
export async function loadPlanAllowance(client: CryptFlare, org: string | undefined): Promise<PlanAllowance | null> {
  try {
    return parsePlanAllowance(await client.billing.getSubscription({ ...(org ? { organisation: org } : {}) }));
  } catch {
    return null;
  }
}

/** Whether the API refused a request because the plan's limit is reached. */
export function isPlanLimitError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === PLAN_LIMIT_CODE;
}

export type ProvisionTarget = { file: string; workspace: string; environment: string };

export type ProvisionOutcome = {
  /** Files whose workspace and environment now exist. */
  ready: Array<ProvisionTarget & { createdWorkspace: boolean; createdEnvironment: boolean }>;
  /** Files left out because the plan has no room, and which limit it was. */
  refused: Array<ProvisionTarget & { resource: PlanResource }>;
  /** Files that failed for any other reason. */
  failed: Array<ProvisionTarget & { message: string; status?: number }>;
  allowance: PlanAllowance | null;
};

/**
 * Makes sure the workspace and environment of each target exist, creating
 * what is missing while the plan has room and refusing the rest.
 *
 * A plan-limit refusal is never retried: the first one marks that limit as
 * reached for the rest of the run.
 *
 * @param options.allowance Pass one loaded earlier to share its countdown across calls.
 */
export async function provisionWithinPlan(
  client: CryptFlare,
  org: string | undefined,
  targets: readonly ProvisionTarget[],
  cache: ScopeCache,
  options: { allowance?: PlanAllowance | null } = {},
): Promise<ProvisionOutcome> {
  const allowance = options.allowance !== undefined ? options.allowance : await loadPlanAllowance(client, org);
  const outcome: ProvisionOutcome = { ready: [], refused: [], failed: [], allowance };
  // Limits the API has refused during this run, for when it gave no allowance.
  const reached = new Set<PlanResource>();
  const room = (resource: PlanResource) => !reached.has(resource) && (allowance ? allowance.remaining[resource] > 0 : true);

  for (const target of targets) {
    let needsWorkspace = false;
    try {
      needsWorkspace = !(await knownWorkspaces(client, org, cache)).has(target.workspace);
      const needsEnvironment = needsWorkspace
        || !(await knownEnvironments(client, org, target.workspace, cache)).has(target.environment);

      if (needsWorkspace && !room('workspaces')) {
        outcome.refused.push({ ...target, resource: 'workspaces' });
        continue;
      }
      // Also when the workspace is new: an empty workspace with no room for
      // its first environment would use up a workspace for nothing.
      if (needsEnvironment && !room('environments')) {
        outcome.refused.push({ ...target, resource: 'environments' });
        continue;
      }

      const made = await ensureScope(client, { ...(org ? { organisation: org } : {}), ...target }, cache);
      if (allowance) {
        if (made.createdWorkspace) allowance.remaining.workspaces -= 1;
        if (made.createdEnvironment) allowance.remaining.environments -= 1;
      }
      outcome.ready.push({ ...target, ...made });
    } catch (err) {
      if (isPlanLimitError(err)) {
        // The workspace is recorded in the cache the moment it is created, so
        // if it is still unknown the refusal was for the workspace itself.
        const resource: PlanResource = needsWorkspace && !cache.workspaces?.has(target.workspace) ? 'workspaces' : 'environments';
        reached.add(resource);
        if (allowance) allowance.remaining[resource] = 0;
        outcome.refused.push({ ...target, resource });
        continue;
      }
      const status = (err as { status?: unknown }).status;
      outcome.failed.push({
        ...target,
        message: (err as Error).message ?? String(err),
        ...(typeof status === 'number' ? { status } : {}),
      });
    }
  }
  return outcome;
}

/** Where a person changes their plan or buys more capacity. */
export function upgradeHint(): string {
  return `Upgrade or add capacity at ${BRAND.urls.app}/billing`;
}

/**
 * One line saying which files were not taken over and why.
 *
 * Names file paths and plan limits only, never a secret name or value.
 */
export function describePlanRefusal(
  refused: ReadonlyArray<{ file: string; resource: PlanResource }>,
  allowance: PlanAllowance | null,
): string {
  const files = refused.map((item) => item.file).join(', ');
  const count = (n: number, noun: string) => (n === Infinity ? `unlimited ${noun}s` : `${n} ${noun}${n === 1 ? '' : 's'}`);

  let why: string;
  if (allowance) {
    const name = planDisplayName(allowance.plan);
    why = `the ${name} plan allows ${count(allowance.limits.workspaces, 'workspace')} and `
      + `${count(allowance.limits.environments, 'environment')}, and there is no room left`;
  } else {
    const kinds = [...new Set(refused.map((item) => item.resource))].join(' and ');
    why = `the plan's limit on ${kinds} is reached`;
  }

  return `Plan limit: ${refused.length} file(s) not taken over (${files}) - ${why}. `
    + `${upgradeHint()} and they are taken over without another command.`;
}
