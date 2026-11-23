/**
 * Test double for the organisation side of `cf env migrate`: workspaces and
 * environments with the plan's limits enforced the way the server does, the
 * usage endpoint, secret batches, and the local-file key endpoint. Used by
 * the CLI's tests only.
 */

import type { CryptFlare } from '@cryptflare/sdk'

import { fakeKeyApi } from '@/lib/local-env/testing/fake-key-api'

export type FakeOrgApi = {
  client: CryptFlare
  /** Values pushed, by `workspace/environment`. */
  pushed: Map<string, Map<string, string>>
  /** Environment slugs, by workspace slug. */
  environments: Map<string, Set<string>>
  creates: { workspaces: number; environments: number }
}

function limitError(resource: string): Error {
  return Object.assign(new Error(`Free plan limit reached: ${resource}`), {
    status: 403,
    code: 'BILLING_PLAN_LIMIT',
  })
}

/**
 * @param opts.workspaces Workspaces that exist, with their environments.
 * @param opts.limits Plan limits; `-1` is unlimited. Defaults to Free (1 and 2).
 */
export function fakeOrgApi(
  opts: {
    workspaces?: Record<string, string[]>
    limits?: { workspaces: number; environments: number }
  } = {},
): FakeOrgApi {
  const limits = opts.limits ?? { workspaces: 1, environments: 2 }
  const keys = fakeKeyApi()
  const environments = new Map(
    Object.entries(opts.workspaces ?? {}).map(([slug, envs]) => [slug, new Set(envs)]),
  )
  const pushed = new Map<string, Map<string, string>>()
  const creates = { workspaces: 0, environments: 0 }
  const envCount = () => [...environments.values()].reduce((n, set) => n + set.size, 0)
  const over = (limit: number, used: number) => limit !== -1 && used >= limit

  const record = (scope: {
    workspace: string
    environment: string
    secrets: Array<{ key: string; value: string }>
  }) => {
    const target = `${scope.workspace}/${scope.environment}`
    const env = pushed.get(target) ?? new Map<string, string>()
    for (const secret of scope.secrets) env.set(secret.key, secret.value)
    pushed.set(target, env)
    return { results: scope.secrets.map((s) => ({ key: s.key, status: 'created' })) }
  }

  const client = {
    request: keys.client.request,
    billing: {
      getSubscription: async () => {
        throw Object.assign(new Error('billing:read required'), { status: 403 })
      },
    },
    usage: {
      get: async () => ({
        plan: 'free',
        usage: {
          workspaces: { used: environments.size, limit: limits.workspaces },
          environments: { used: envCount(), limit: limits.environments },
        },
      }),
    },
    workspaces: {
      list: async () => [...environments.keys()].map((slug) => ({ id: `ws_${slug}`, slug })),
      create: async (args: { slug: string }) => {
        if (over(limits.workspaces, environments.size)) throw limitError('workspaces')
        creates.workspaces += 1
        environments.set(args.slug, new Set())
      },
    },
    environments: {
      list: async (args: { workspace: string }) =>
        [...(environments.get(args.workspace) ?? [])].map((slug) => ({ slug })),
      create: async (args: { workspace: string; slug: string }) => {
        if (over(limits.environments, envCount())) throw limitError('environments')
        creates.environments += 1
        environments.get(args.workspace)?.add(args.slug)
      },
    },
    secrets: {
      list: async (scope: { workspace: string; environment: string }) =>
        [...(pushed.get(`${scope.workspace}/${scope.environment}`)?.keys() ?? [])].map((key) => ({
          key,
        })),
      batchCreate: record,
      batchUpdate: record,
    },
  }
  return { client: client as unknown as CryptFlare, pushed, environments, creates }
}
