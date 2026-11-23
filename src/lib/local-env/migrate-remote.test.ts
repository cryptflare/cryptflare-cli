/**
 * `cf env migrate` against an organisation on the Free plan (1 workspace,
 * 2 environments): choosing the workspace, reporting the plan's limits in
 * the dry run, the flags that make it fit, and refusing names two files of
 * one environment define differently.
 *
 * Every secret-shaped value is generated per run.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { applyMigration } from '@/lib/local-env/migrate-apply'
import { blockers, planMigration, type PlanOptions } from '@/lib/local-env/migrate-plan'
import { checkRemote } from '@/lib/local-env/migrate-remote'
import { fakeOrgApi } from '@/lib/local-env/testing/fake-org-api'
import { loadManifest } from '@/lib/project-manifest'

const gen = (): string => randomBytes(18).toString('base64url')

let root = ''
const values = { root: gen(), api: gen(), web: gen(), shell: gen() }

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-migrate-remote-'))
  write('.env', `# root\nROOT_TOKEN="${values.root}"\n`)
  write('apps/api/.dev.vars', `API_TOKEN = "${values.api}"\n`)
  write('apps/web/.env.local', `NEXT_PUBLIC_URL=https://example.com\nWEB_TOKEN=${values.web}\n`)
  write('.envrc', `export SHELL_TOKEN=${values.shell}\n`)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

async function plan(opts: PlanOptions & { createWorkspace?: boolean }, api = fakeOrgApi()) {
  const result = planMigration(root, opts)
  const group = opts.environment ? 'single' : (opts.group ?? 'per-file')
  const remote = await checkRemote(api.client, 'org_test', result, {
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
    createWorkspace: opts.createWorkspace ?? false,
    group,
  })
  return { plan: result, remote, api }
}

describe('checkRemote: workspace', () => {
  it('uses the only existing workspace when the folder-named one does not exist', async () => {
    const { plan: result } = await plan({}, fakeOrgApi({ workspaces: { existing: [] } }))
    expect(result.workspace).toBe('existing')
    expect(result.files.every((file) => file.workspace === 'existing')).toBe(true)
    expect(result.notes.join('\n')).toContain("the organisation's only workspace")
  })

  it('takes -w by slug or id', async () => {
    const api = fakeOrgApi({
      workspaces: { a: [], b: [] },
      limits: { workspaces: 5, environments: 9 },
    })
    expect((await plan({ workspace: 'b' }, api)).plan.workspace).toBe('b')
    expect((await plan({ workspace: 'ws_a' }, api)).plan.workspace).toBe('a')
  })

  it('refuses a -w that does not exist unless creation is allowed', async () => {
    const api = fakeOrgApi({ workspaces: { existing: [] } })
    await expect(plan({ workspace: 'missing' }, api)).rejects.toThrow(
      /Workspace "missing" does not exist in this organisation \(existing: existing\).*--create-workspace/,
    )
    const created = await plan({ workspace: 'missing', createWorkspace: true }, api)
    expect(created.plan.workspace).toBe('missing')
    // Free has no room for a second workspace: said up front, per file.
    expect(created.plan.files[0]?.blocked?.resource).toBe('workspaces')
  })
})

describe('checkRemote: plan limits', () => {
  it('marks the files past the environment limit and suggests the flag that fits', async () => {
    const { plan: result } = await plan({}, fakeOrgApi({ workspaces: { existing: [] } }))
    expect(result.notes.join('\n')).toMatch(/Plan free: 1\/1 workspaces and 0\/2 environments/)
    const blocked = result.files.filter((file) => file.blocked)
    // Four files, four environments, room for two.
    expect(blocked.map((file) => file.rel)).toEqual(['apps/api/.dev.vars', 'apps/web/.env.local'])
    expect(blocked[0]?.blocked?.message).toContain('the free plan allows 2 environments')
    // per-app needs root-dev, api-dev, web-dev: three. One environment fits.
    expect(result.suggestions).toEqual(['cf env migrate -e dev'])
    expect(blockers(result)).toHaveLength(2)
  })

  it('suggests an environment that already exists when there is no room for any', async () => {
    const api = fakeOrgApi({ workspaces: { existing: ['development', 'staging'] } })
    const { plan: result } = await plan({}, api)
    expect(result.files.every((file) => file.blocked?.resource === 'environments')).toBe(true)
    expect(result.suggestions).toEqual(['cf env migrate -e development'])
  })

  it('suggests per-app when that fits', async () => {
    const api = fakeOrgApi({
      workspaces: { existing: [] },
      limits: { workspaces: 1, environments: 3 },
    })
    expect((await plan({}, api)).plan.suggestions).toEqual(['cf env migrate --group per-app'])
  })

  it('refuses to apply a plan that does not fit, before changing anything', async () => {
    const api = fakeOrgApi({ workspaces: { existing: [] } })
    const { plan: result, remote } = await plan({}, api)
    const before = readFileSync(join(root, '.env'), 'utf-8')
    await expect(applyMigration(api.client, result, 'org_test', {}, remote.cache)).rejects.toThrow(
      /Nothing changed/,
    )
    expect(readFileSync(join(root, '.env'), 'utf-8')).toBe(before)
    expect(api.creates).toEqual({ workspaces: 0, environments: 0 })
  })
})

describe('-e: every file in one environment', () => {
  it('fits Free, encrypts every file and binds them to the one environment', async () => {
    const api = fakeOrgApi({ workspaces: { existing: [] } })
    const { plan: result, remote } = await plan({ environment: 'dev' }, api)
    expect(blockers(result)).toEqual([])
    expect(result.suggestions).toEqual([])
    const outcome = await applyMigration(api.client, result, 'org_test', {}, remote.cache)
    expect(outcome.files.map((file) => file.status)).toEqual([
      'encrypted',
      'encrypted',
      'encrypted',
      'encrypted',
    ])
    expect(api.creates).toEqual({ workspaces: 0, environments: 1 })
    const dev = api.pushed.get('existing/dev')
    expect(dev?.get('ROOT_TOKEN')).toBe(values.root)
    expect(dev?.get('API_TOKEN')).toBe(values.api)
    expect(readFileSync(join(root, 'apps/api/.dev.vars'), 'utf-8')).toMatch(
      /^API_TOKEN = "cf:v1:[^"]+"\n$/,
    )
    const manifest = loadManifest(root)
    expect(manifest.workspace).toBe('existing')
    expect(new Set(manifest.bindings.map((binding) => binding.environment))).toEqual(
      new Set(['dev']),
    )
  })

  it('refuses one name with different values in two files, naming no value', async () => {
    const other = gen()
    write('apps/web/.env.local', `ROOT_TOKEN=${other}\n`)
    const api = fakeOrgApi({ workspaces: { existing: [] } })
    const { plan: result, remote } = await plan({ environment: 'dev' }, api)
    const problems = blockers(result)
    expect(problems).toEqual([
      '.env: ROOT_TOKEN conflicts',
      'apps/web/.env.local: ROOT_TOKEN conflicts',
    ])
    expect(problems.join()).not.toContain(other)
    await expect(applyMigration(api.client, result, 'org_test', {}, remote.cache)).rejects.toThrow(
      /Nothing changed/,
    )
    expect(api.pushed.size).toBe(0)
  })

  it('allows one name with the same value in two files', async () => {
    write('apps/web/.env.local', `ROOT_TOKEN="${values.root}"\n`)
    const { plan: result } = await plan(
      { environment: 'dev' },
      fakeOrgApi({ workspaces: { existing: [] } }),
    )
    expect(blockers(result)).toEqual([])
  })
})
