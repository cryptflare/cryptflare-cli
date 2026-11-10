import { describe, expect, it } from 'vitest';

import type { CryptFlare } from '@cryptflare/sdk';
import { BRAND } from '../_vendored/brand';

import {
  describePlanRefusal,
  isPlanLimitError,
  loadPlanAllowance,
  parsePlanAllowance,
  provisionWithinPlan,
} from './plan-allowance.js';
import { newScopeCache } from './provision.js';

// Limits as the API reports them. Written out rather than imported from
// @cryptflare/shared: this file is also run in the public CLI mirror, which
// carries only BRAND from that package.
const FREE = { workspaces: 1, environments: 2 };
const TEAM = { workspaces: -1, environments: -1 };

function planLimitError(resource: string): Error {
  return Object.assign(new Error(`Limit reached for ${resource}.`), { status: 403, code: 'BILLING_PLAN_LIMIT' });
}

/**
 * A fake API that enforces limits the way the server does, and counts the
 * create calls it receives so a retry loop would show.
 */
function fake(opts: {
  workspaces?: Record<string, string[]>;
  limits?: { workspaces: number; environments: number };
  subscription?: 'ok' | 'forbidden';
} = {}) {
  const limits = opts.limits ?? { workspaces: FREE.workspaces, environments: FREE.environments };
  const state = new Map(Object.entries(opts.workspaces ?? {}).map(([slug, envs]) => [slug, [...envs]]));
  const calls = { workspaceCreates: 0, environmentCreates: 0, subscription: 0 };
  const environmentCount = () => [...state.values()].reduce((n, envs) => n + envs.length, 0);

  const client = {
    billing: {
      getSubscription: async () => {
        calls.subscription++;
        if (opts.subscription === 'forbidden') throw Object.assign(new Error('forbidden'), { status: 403 });
        return {
          plan: 'free',
          limits,
          effectiveLimits: limits,
          usage: { workspaces: state.size, environments: environmentCount() },
        };
      },
    },
    workspaces: {
      list: async () => [...state.keys()].map((slug) => ({ slug })),
      create: async (input: { slug: string }) => {
        calls.workspaceCreates++;
        if (state.size >= limits.workspaces) throw planLimitError('workspaces');
        state.set(input.slug, []);
        return {};
      },
    },
    environments: {
      list: async ({ workspace }: { workspace: string }) => (state.get(workspace) ?? []).map((slug) => ({ slug })),
      create: async (input: { workspace: string; slug: string }) => {
        calls.environmentCreates++;
        if (environmentCount() >= limits.environments) throw planLimitError('environments');
        state.get(input.workspace)!.push(input.slug);
        return {};
      },
    },
  };
  return { client: client as unknown as CryptFlare, calls, state };
}

const target = (file: string, environment: string, workspace = 'shop') => ({ file, workspace, environment });

describe('parsePlanAllowance', () => {
  it('works out what is left from limits and usage', () => {
    const allowance = parsePlanAllowance({ plan: 'free', limits: FREE, usage: { workspaces: 1, environments: 1 } });
    expect(allowance?.remaining).toEqual({ workspaces: FREE.workspaces - 1, environments: FREE.environments - 1 });
  });

  it('prefers effective limits, which include add-ons', () => {
    const allowance = parsePlanAllowance({
      plan: 'free',
      limits: FREE,
      effectiveLimits: { ...FREE, environments: FREE.environments + 5 },
      usage: { workspaces: 0, environments: FREE.environments },
    });
    expect(allowance?.remaining.environments).toBe(5);
  });

  it('treats -1 as unlimited', () => {
    const allowance = parsePlanAllowance({ plan: 'team', limits: TEAM, usage: { workspaces: 40, environments: 400 } });
    expect(allowance?.remaining).toEqual({ workspaces: Infinity, environments: Infinity });
  });

  it('says nothing when the response does not carry usage', () => {
    expect(parsePlanAllowance({ plan: 'free' })).toBeNull();
    expect(parsePlanAllowance(null)).toBeNull();
  });
});

describe('loadPlanAllowance', () => {
  it('is unknown, not zero, when the token may not read billing', async () => {
    const { client } = fake({ subscription: 'forbidden' });
    expect(await loadPlanAllowance(client, 'org_1')).toBeNull();
  });
});

describe('provisionWithinPlan', () => {
  it('creates what fits and refuses the rest without sending a request for them', async () => {
    const { client, calls } = fake();
    const outcome = await provisionWithinPlan(client, 'org_1', [
      target('.env', 'root-dev'),
      target('apps/api/.dev.vars', 'api-dev-worker'),
      target('apps/web/.env', 'web-dev'),
      target('.env.production', 'root-production'),
    ], newScopeCache());

    expect(outcome.ready.map((r) => r.file)).toEqual(['.env', 'apps/api/.dev.vars']);
    expect(outcome.refused).toEqual([
      { ...target('apps/web/.env', 'web-dev'), resource: 'environments' },
      { ...target('.env.production', 'root-production'), resource: 'environments' },
    ]);
    expect(calls.workspaceCreates).toBe(FREE.workspaces);
    expect(calls.environmentCreates).toBe(FREE.environments);
  });

  it('refuses a second repository when the plan has one workspace, and creates nothing', async () => {
    const { client, calls } = fake({ workspaces: { seed: ['dev'] } });
    const outcome = await provisionWithinPlan(client, 'org_1', [target('.env', 'root-dev', 'blog')], newScopeCache());

    expect(outcome.ready).toEqual([]);
    expect(outcome.refused).toEqual([{ ...target('.env', 'root-dev', 'blog'), resource: 'workspaces' }]);
    expect(calls.workspaceCreates + calls.environmentCreates).toBe(0);
  });

  it('does not use up a workspace when there is no room for its first environment', async () => {
    const { client, calls } = fake({ limits: { workspaces: 5, environments: 0 } });
    const outcome = await provisionWithinPlan(client, 'org_1', [target('.env', 'root-dev')], newScopeCache());
    expect(outcome.refused[0]?.resource).toBe('environments');
    expect(calls.workspaceCreates).toBe(0);
  });

  it('needs no room for what already exists', async () => {
    const { client, calls } = fake({ workspaces: { shop: ['root-dev', 'api-dev-worker'] } });
    const outcome = await provisionWithinPlan(client, 'org_1', [target('.env', 'root-dev')], newScopeCache());
    expect(outcome.ready).toEqual([{ ...target('.env', 'root-dev'), createdWorkspace: false, createdEnvironment: false }]);
    expect(calls.environmentCreates).toBe(0);
  });

  it('takes the first plan-limit refusal as final when the allowance is unknown', async () => {
    const { client, calls } = fake({ subscription: 'forbidden' });
    const outcome = await provisionWithinPlan(client, 'org_1', [
      target('.env', 'a'),
      target('b/.env', 'b'),
      target('c/.env', 'c'),
      target('d/.env', 'd'),
      target('e/.env', 'e'),
    ], newScopeCache());

    expect(outcome.allowance).toBeNull();
    expect(outcome.ready).toHaveLength(FREE.environments);
    expect(outcome.refused.map((r) => r.resource)).toEqual(['environments', 'environments', 'environments']);
    // One refused request, then no more: never a retry loop.
    expect(calls.environmentCreates).toBe(FREE.environments + 1);
  });

  it('tells a workspace refusal from an environment refusal when the allowance is unknown', async () => {
    const { client, calls } = fake({ subscription: 'forbidden', workspaces: { seed: [] } });
    const outcome = await provisionWithinPlan(client, 'org_1', [
      target('.env', 'root-dev', 'blog'),
      target('.env', 'root-dev', 'shop'),
      target('.env', 'dev', 'seed'),
    ], newScopeCache());

    expect(outcome.refused.map((r) => r.resource)).toEqual(['workspaces', 'workspaces']);
    expect(calls.workspaceCreates).toBe(1);
    // The existing workspace still gets its environment.
    expect(outcome.ready.map((r) => r.workspace)).toEqual(['seed']);
  });

  it('reports other failures separately and carries on', async () => {
    const { client } = fake({ workspaces: { shop: [] }, limits: { workspaces: 5, environments: 5 } });
    let first = true;
    const create = client.environments.create.bind(client.environments);
    (client.environments as unknown as { create: unknown }).create = async (input: never) => {
      if (first) {
        first = false;
        throw Object.assign(new Error('boom'), { status: 500 });
      }
      return create(input);
    };

    const outcome = await provisionWithinPlan(client, 'org_1', [target('.env', 'a'), target('b/.env', 'b')], newScopeCache());
    expect(outcome.failed).toEqual([{ ...target('.env', 'a'), message: 'boom', status: 500 }]);
    expect(outcome.ready.map((r) => r.file)).toEqual(['b/.env']);
  });

  it('counts down one shared allowance across calls', async () => {
    const { client } = fake();
    const allowance = await loadPlanAllowance(client, 'org_1');
    const cache = newScopeCache();
    await provisionWithinPlan(client, 'org_1', [target('.env', 'a'), target('b/.env', 'b')], cache, { allowance });
    const second = await provisionWithinPlan(client, 'org_1', [target('c/.env', 'c')], cache, { allowance });
    expect(second.refused).toHaveLength(1);
  });
});

describe('isPlanLimitError', () => {
  it('recognises the plan-limit code and nothing else', () => {
    expect(isPlanLimitError(planLimitError('workspaces'))).toBe(true);
    expect(isPlanLimitError(Object.assign(new Error('no'), { status: 403, code: 'AUTH_FORBIDDEN' }))).toBe(false);
    expect(isPlanLimitError(null)).toBe(false);
  });
});

describe('describePlanRefusal', () => {
  it('names the files, the plan limits and where to upgrade', () => {
    const allowance = parsePlanAllowance({ plan: 'free', limits: FREE, usage: { workspaces: 1, environments: 2 } });
    const message = describePlanRefusal([{ file: 'apps/web/.env', resource: 'environments' }, { file: '.envrc', resource: 'environments' }], allowance);

    expect(message).toContain('2 file(s) not taken over (apps/web/.env, .envrc)');
    expect(message).toContain(`Free plan allows ${FREE.workspaces} workspace`);
    expect(message).toContain(`${FREE.environments} environments`);
    expect(message).toContain(BRAND.urls.app);
    expect(message).not.toContain('\n');
  });

  it('still says which limit when the allowance is unknown', () => {
    expect(describePlanRefusal([{ file: '.env', resource: 'workspaces' }], null)).toContain("limit on workspaces is reached");
  });
});
