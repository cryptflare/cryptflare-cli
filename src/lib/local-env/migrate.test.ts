/**
 * `cf env migrate` on a fixture monorepo in the OS temp dir: what the plan
 * finds and skips, then the apply step against a fake API.
 *
 * Every secret-shaped value is generated per run.
 */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { CryptFlare } from '@cryptflare/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { decryptContent, keyRefsIn } from '@/lib/local-env/codec'
import { formatById } from '@/lib/local-env/formats'
import { Keyring } from '@/lib/local-env/keyring'
import { applyMigration, DIRENV_HOOK } from '@/lib/local-env/migrate-apply'
import { planMigration } from '@/lib/local-env/migrate-plan'
import { fakeKeyApi } from '@/lib/local-env/testing/fake-key-api'
import { loadManifest } from '@/lib/project-manifest'

const gen = (prefix = ''): string => `${prefix}${randomBytes(18).toString('base64url')}`

let root = ''
const stripe = gen('sk_test_')
const apiToken = gen()

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-migrate-'))
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'test')
  // A plaintext .dev.vars that was committed once, then untracked.
  write('apps/api/.dev.vars', `STRIPE_SECRET_KEY=${stripe}\nexport PORT=8787\n`)
  git('add', 'apps/api/.dev.vars')
  git('commit', '-q', '-m', 'oops')
  git('rm', '-q', '--cached', 'apps/api/.dev.vars')
  write('.gitignore', '.dev.vars\n')

  write('apps/web/.env.local', `VITE_PUBLIC_URL=https://example.com\r\nAPI_TOKEN="${apiToken}"\r\n`)
  write('apps/web/.env.example', 'API_TOKEN=changeme\n')
  write('.envrc', 'use flake\nexport GH_TOKEN=abc\n')
  write('.streamlit/secrets.toml', `db_password = "${gen()}"\ntitle = "demo"\n`)
  write(
    'docker-compose.yml',
    'services:\n  app:\n    env_file:\n      - ./docker/app.env\n    environment:\n      DB_PASSWORD: literal-value\n',
  )
  write('docker/app.env', `SESSION_SECRET=${gen()}\n`)
  write('infra/terraform.tfvars', `region = "eu-west-1"\ndb_password = "${gen()}"\n`)
  write('config/master.key', `${randomBytes(16).toString('hex')}\n`)
  write('.npmrc', `//registry.npmjs.org/:_authToken=${gen('npm_')}\n`)
  write('certs/server.pem', 'not really a key\n')
  write('node_modules/pkg/.env', 'IGNORED=1\n')
  write('pnpm-lock.yaml', 'lockfileVersion: 9\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function fakeClient(): { client: CryptFlare; pushed: Map<string, Map<string, string>> } {
  const keys = fakeKeyApi()
  const pushed = new Map<string, Map<string, string>>()
  const workspaces = new Set<string>()
  const environments = new Map<string, Set<string>>()
  const record = (scope: {
    environment: string
    secrets: Array<{ key: string; value: string }>
  }) => {
    const env = pushed.get(scope.environment) ?? new Map<string, string>()
    for (const secret of scope.secrets) env.set(secret.key, secret.value)
    pushed.set(scope.environment, env)
    return { results: scope.secrets.map((s) => ({ key: s.key, status: 'created' })) }
  }
  const client = {
    request: keys.client.request,
    workspaces: {
      list: async () => [...workspaces].map((slug) => ({ slug })),
      create: async (args: { slug: string }) => workspaces.add(args.slug),
    },
    environments: {
      list: async (args: { workspace: string }) =>
        [...(environments.get(args.workspace) ?? [])].map((slug) => ({ slug })),
      create: async (args: { workspace: string; slug: string }) => {
        const set = environments.get(args.workspace) ?? new Set<string>()
        set.add(args.slug)
        environments.set(args.workspace, set)
      },
    },
    secrets: { list: async () => [], batchCreate: record, batchUpdate: record },
  }
  return { client: client as unknown as CryptFlare, pushed }
}

describe('planMigration', () => {
  it('finds every format across the monorepo and skips what it must', () => {
    const plan = planMigration(root)
    const byFile = new Map(plan.files.map((file) => [file.rel, file]))
    expect([...byFile.keys()].sort()).toEqual([
      '.envrc',
      '.npmrc',
      '.streamlit/secrets.toml',
      'apps/api/.dev.vars',
      'apps/web/.env.local',
      'config/master.key',
      'docker/app.env',
      'infra/terraform.tfvars',
    ])
    expect(byFile.get('docker/app.env')?.format.id).toBe('compose-env')
    expect(plan.scan.templates).toEqual(['apps/web/.env.example'])
    expect(plan.scan.review.map((item) => item.rel)).toEqual(['certs/server.pem'])
    expect(plan.scan.composeInline.map((item) => item.name)).toEqual(['DB_PASSWORD'])
  })

  it('flags browser-public names, history and environments per app', () => {
    const plan = planMigration(root)
    const web = plan.files.find((file) => file.rel === 'apps/web/.env.local')
    expect(web?.decisions.get('public')).toEqual(['VITE_PUBLIC_URL'])
    expect(web?.decisions.get('encrypt')).toEqual(['API_TOKEN'])
    expect(web?.environment).toBe('web-dev')
    const api = plan.files.find((file) => file.rel === 'apps/api/.dev.vars')
    expect(api?.inHistory).toBe(true)
    expect(api?.environment).toBe('api-dev-worker')
    expect(plan.files.find((file) => file.rel === '.envrc')?.inHistory).toBe(false)
  })

  it('changes nothing on disk', () => {
    const before = readFileSync(join(root, 'apps/web/.env.local'), 'utf-8')
    planMigration(root)
    expect(readFileSync(join(root, 'apps/web/.env.local'), 'utf-8')).toBe(before)
    expect(existsSync(join(root, '.cryptflare.json'))).toBe(false)
  })
})

describe('applyMigration', () => {
  it('pushes values, rewrites files as ciphertext and binds them', async () => {
    const { client, pushed } = fakeClient()
    const plan = planMigration(root, { moveRegistryTokens: true })
    const outcome = await applyMigration(client, plan, 'org_test', { moveRegistryTokens: true })
    expect(outcome.files.filter((file) => file.status === 'failed')).toEqual([])

    expect(pushed.get('api-dev-worker')?.get('STRIPE_SECRET_KEY')).toBe(stripe)
    expect(pushed.get('web-dev')?.get('API_TOKEN')).toBe(apiToken)

    const web = readFileSync(join(root, 'apps/web/.env.local'), 'utf-8')
    expect(web).not.toContain(apiToken)
    expect(web).toMatch(/^VITE_PUBLIC_URL=https:\/\/example\.com\r\nAPI_TOKEN="cf:v1:[^"]+"\r\n$/)

    const keyring = new Keyring(client)
    const format = formatById('dotenv')
    const keys = await keyring.forRefs(
      { org: 'org_test', workspace: plan.workspace, environment: 'web-dev' },
      keyRefsIn(format.parse(web)),
    )
    expect(decryptContent(web, format, keys).values.get('API_TOKEN')).toBe(apiToken)

    expect(readFileSync(join(root, '.envrc'), 'utf-8')).toContain(DIRENV_HOOK)
    expect(readFileSync(join(root, '.npmrc'), 'utf-8')).toBe(
      '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n',
    )
    expect(readFileSync(join(root, 'apps/web/.env.example'), 'utf-8')).toBe('API_TOKEN=changeme\n')

    const manifest = loadManifest(root)
    expect(manifest.bindings.every((binding) => binding.encrypted === true)).toBe(true)
    expect(manifest.bindings.map((binding) => binding.file)).not.toContain('.npmrc')
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toContain('*.cf-restore')
  })

  it('leaves a file untouched when its values cannot be pushed', async () => {
    const { client } = fakeClient()
    const broken = {
      ...client,
      secrets: {
        list: async () => [],
        batchCreate: async () => {
          throw new Error('API unavailable')
        },
      },
    } as unknown as CryptFlare
    const before = readFileSync(join(root, 'apps/web/.env.local'), 'utf-8')
    const outcome = await applyMigration(broken, planMigration(root), 'org_test')
    expect(outcome.files.find((file) => file.rel === 'apps/web/.env.local')?.status).toBe('failed')
    expect(readFileSync(join(root, 'apps/web/.env.local'), 'utf-8')).toBe(before)
  })
})
