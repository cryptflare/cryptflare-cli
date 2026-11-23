import { describe, expect, it } from 'vitest'

import {
  alreadyConnected,
  createEnvironment,
  findOwnerIntegration,
  installationSettingsUrl,
  listEnvironments,
  parseKeyList,
  parsePushTargets,
  viewRepo,
  type GhResult,
  type GitHubIntegration,
} from '@/lib/github-push'

/** A fake `gh` that answers by the first argument after `gh`, and records each call. */
function fakeGh(answers: Record<string, GhResult>) {
  const calls: string[][] = []
  const run = (args: string[]): GhResult => {
    calls.push(args)
    const key = args[0] === 'api' && args[1] === '--method' ? 'api-put' : (args[0] ?? '')
    return answers[key] ?? { ok: false, message: 'unexpected call' }
  }
  return { run, calls }
}

describe('parsePushTargets', () => {
  it('pushes each environment to the GitHub environment it names, or of the same name', () => {
    expect(parsePushTargets(['staging', 'prod:production'], undefined, false)).toEqual([
      { env: 'staging', githubEnvironment: 'staging' },
      { env: 'prod', githubEnvironment: 'production' },
    ])
  })

  it('falls back to the bound environment', () => {
    expect(parsePushTargets([], 'dev', false)).toEqual([{ env: 'dev', githubEnvironment: 'dev' }])
  })

  it('pushes one environment to repository secrets', () => {
    expect(parsePushTargets(['ci'], undefined, true)).toEqual([
      { env: 'ci', githubEnvironment: null },
    ])
    expect(() => parsePushTargets(['a', 'b'], undefined, true)).toThrow(/single --env/)
  })

  it('refuses an empty side, a repeat, or nothing to push', () => {
    expect(() => parsePushTargets(['prod:'], undefined, false)).toThrow(/"prod:"/)
    expect(() => parsePushTargets(['a', 'a:b'], undefined, false)).toThrow(/twice/)
    expect(() => parsePushTargets([], undefined, false)).toThrow(/--env/)
  })
})

describe('parseKeyList', () => {
  it('reads a comma separated list, or nothing', () => {
    expect(parseKeyList('A, B,,')).toEqual(['A', 'B'])
    expect(parseKeyList(' , ')).toBeUndefined()
    expect(parseKeyList(undefined)).toBeUndefined()
  })
})

describe('alreadyConnected', () => {
  const existing = [
    {
      environmentId: 'env_1',
      provider: 'github',
      providerConfig: { owner: 'Acme', repo: 'API', environment: 'production' },
    },
  ]
  it('matches the same environment, repository and GitHub environment', () => {
    const repo = { owner: 'acme', name: 'api' }
    expect(alreadyConnected(existing, 'env_1', repo, 'production')).toBe(true)
    expect(alreadyConnected(existing, 'env_1', repo, 'staging')).toBe(false)
    expect(alreadyConnected(existing, 'env_1', repo, null)).toBe(false)
    expect(alreadyConnected(existing, 'env_2', repo, 'production')).toBe(false)
  })
})

describe('gh', () => {
  it('reads the repository and whether you administer it', () => {
    const gh = fakeGh({
      repo: { ok: true, stdout: '{"nameWithOwner":"acme/api","viewerPermission":"ADMIN"}' },
    })
    expect(viewRepo(undefined, gh.run)).toEqual({ owner: 'acme', name: 'api', admin: true })
    expect(gh.calls[0]).toEqual(['repo', 'view', '--json', 'nameWithOwner,viewerPermission'])
  })

  it('says to pass --repo when there is no repository here', () => {
    const gh = fakeGh({ repo: { ok: false, message: 'no git remotes found' } })
    expect(() => viewRepo(undefined, gh.run)).toThrow(/no git remotes found.*--repo/)
  })

  it('lists environments and creates one with PUT', () => {
    const repo = { owner: 'acme', name: 'api', admin: true }
    const gh = fakeGh({
      api: { ok: true, stdout: 'staging\nproduction\n' },
      'api-put': { ok: true, stdout: '' },
    })
    expect(listEnvironments(repo, gh.run)).toEqual(['staging', 'production'])
    createEnvironment(repo, 'qa env', gh.run)
    expect(gh.calls[1]).toEqual([
      'api',
      '--method',
      'PUT',
      'repos/acme/api/environments/qa%20env',
      '--silent',
    ])
  })
})

describe('the CryptFlare GitHub App installation', () => {
  const org: GitHubIntegration = {
    id: 'int_1',
    provider: 'github',
    externalOrgLogin: 'Acme',
    installationId: 42,
    accountType: 'Organization',
    repositorySelection: 'selected',
    status: 'active',
  }

  it('finds the active installation on the owner', () => {
    expect(findOwnerIntegration([org], 'acme')).toBe(org)
    expect(findOwnerIntegration([{ ...org, status: 'suspended' }], 'acme')).toBeUndefined()
    expect(findOwnerIntegration([org], 'other')).toBeUndefined()
  })

  it('links to the settings where repositories are added', () => {
    expect(installationSettingsUrl(org)).toBe(
      'https://github.com/organizations/Acme/settings/installations/42',
    )
    expect(installationSettingsUrl({ ...org, accountType: 'User' })).toBe(
      'https://github.com/settings/installations/42',
    )
  })
})
