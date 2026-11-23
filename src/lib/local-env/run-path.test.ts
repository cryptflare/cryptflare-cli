/**
 * The `cf run` path against a fake key API: bound encrypted files are
 * decrypted in memory, wrangler gets `--env-file`, `--materialize` writes
 * plaintext only while the child runs, and an unreachable API fails closed.
 *
 * Fixture values are generated per run.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runChildWithCleanup } from '@/lib/local-env/child'
import { encryptContent } from '@/lib/local-env/codec'
import { formatById } from '@/lib/local-env/formats'
import { Keyring } from '@/lib/local-env/keyring'
import { RESTORE_SUFFIX } from '@/lib/local-env/materialize'
import { prepareRun } from '@/lib/local-env/prepare-run'
import { loadLocalFiles } from '@/lib/local-env/run-files'
import { decryptValues, encryptValues } from '@/lib/local-env/sync-codec'
import { fakeKeyApi, type FakeKeyApi } from '@/lib/local-env/testing/fake-key-api'
import { adaptWrangler } from '@/lib/local-env/wrangler'

const gen = (): string => randomBytes(18).toString('base64url')

let root = ''
let api: FakeKeyApi
const scope = { org: 'org_test', workspace: 'app', env: 'dev' }
const apiValue = gen()
const pw = gen()
const tomlLine = (value: string) => `db_password = "${value}"\n`

function write(rel: string, content: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), content)
}

/** Encrypts a file in the fixture with the fake API's key for `dev`. */
async function encryptFixture(rel: string, id: Parameters<typeof formatById>[0]): Promise<void> {
  const key = await new Keyring(api.client).get(
    { org: scope.org, workspace: scope.workspace, environment: scope.env },
    1,
  )
  const path = join(root, rel)
  writeFileSync(path, encryptContent(readFileSync(path, 'utf-8'), formatById(id), key).content)
}

function load(overrides: { env?: string; files?: string[] } = {}) {
  return loadLocalFiles({
    cwd: root,
    scope: { ...scope, ...(overrides.env ? { env: overrides.env } : {}) },
    files: overrides.files ?? [],
    keyring: new Keyring(api.client),
  })
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cf-run-'))
  api = fakeKeyApi()
  write(
    '.cryptflare.json',
    JSON.stringify({
      version: 1,
      org: scope.org,
      workspace: scope.workspace,
      bindings: [
        { file: '.dev.vars', environment: 'dev', encrypted: true },
        { file: '.streamlit/secrets.toml', environment: 'dev', encrypted: true },
        { file: '.env.production', environment: 'production' },
      ],
    }),
  )
  write('.dev.vars', `API_SECRET=${apiValue}\nPLAIN_FLAG=on\n`)
  write('.streamlit/secrets.toml', tomlLine(pw))
  write('.env.production', 'UNRELATED=1\n')
  await encryptFixture('.dev.vars', 'dev-vars')
  await encryptFixture('.streamlit/secrets.toml', 'toml')
  api.requests.length = 0
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('loadLocalFiles', () => {
  it('decrypts the bound files of the scope with one key request', async () => {
    const plan = await load()
    expect(plan.env).toEqual({ API_SECRET: apiValue, PLAIN_FLAG: 'on' })
    expect(plan.devVars.map((file) => file.rel)).toEqual(['.dev.vars'])
    expect(plan.materialize.map((file) => file.rel)).toEqual(['.streamlit/secrets.toml'])
    expect(plan.materialize[0]?.plaintext).toContain(pw)
    expect(api.requests).toHaveLength(1)
    // Nothing plaintext on disk.
    expect(readFileSync(join(root, '.dev.vars'), 'utf-8')).not.toContain(apiValue)
  })

  it('fails closed when the key cannot be fetched', async () => {
    api.goOffline()
    await expect(load()).rejects.toThrow(/ENOTFOUND/)
  })

  it('refuses a file encrypted for another environment', async () => {
    await expect(load({ env: 'staging', files: [join(root, '.dev.vars')] })).rejects.toThrow(
      /another environment/,
    )
  })
})

describe('wrangler adapter', () => {
  it('passes the encrypted .dev.vars as --env-file to a direct wrangler dev', () => {
    const adapted = adaptWrangler(['npx', 'wrangler', 'dev', '--port', '8787'], ['/p/.dev.vars'])
    expect(adapted.args).toEqual([
      'npx',
      'wrangler',
      'dev',
      '--env-file',
      '/p/.dev.vars',
      '--port',
      '8787',
    ])
    expect(adapted.env).toEqual({ CLOUDFLARE_INCLUDE_PROCESS_ENV: 'true' })
  })

  it('picks .dev.vars.<env> for --env and leaves an explicit --env-file alone', () => {
    const files = ['/p/.dev.vars', '/p/.dev.vars.staging']
    expect(adaptWrangler(['wrangler', 'dev', '--env', 'staging'], files).args).toContain(
      '/p/.dev.vars.staging',
    )
    expect(adaptWrangler(['wrangler', 'dev', '--env-file', 'x'], files).adapted).toBe(false)
    expect(adaptWrangler(['pnpm', 'dev'], files).adapted).toBe(false)
    expect(adaptWrangler(['wrangler', 'deploy'], files).adapted).toBe(false)
  })
})

describe('--materialize', () => {
  it('writes plaintext only while the child runs, then restores the ciphertext', async () => {
    const plan = await load()
    const toml = join(root, '.streamlit/secrets.toml')
    const ciphertext = readFileSync(toml, 'utf-8')
    const prepared = prepareRun([process.execPath, '-e', ''], plan, 'in-place')
    expect(prepared.cleanup).not.toBeNull()

    const probe = `process.exit(require('fs').readFileSync(${JSON.stringify(toml)}, 'utf8').includes(${JSON.stringify(pw)}) ? 0 : 3)`
    const status = await runChildWithCleanup(
      process.execPath,
      ['-e', probe],
      process.env,
      prepared.cleanup ?? (() => undefined),
    )
    expect(status).toBe(0)
    expect(readFileSync(toml, 'utf-8')).toBe(ciphertext)
    expect(existsSync(`${toml}${RESTORE_SUFFIX}`)).toBe(false)
  })

  it('restores a sidecar left by a killed run before reading', async () => {
    const toml = join(root, '.streamlit/secrets.toml')
    const ciphertext = readFileSync(toml, 'utf-8')
    writeFileSync(`${toml}${RESTORE_SUFFIX}`, ciphertext)
    writeFileSync(toml, tomlLine(pw))
    const plan = await load()
    expect(plan.restored).toEqual([toml])
    expect(readFileSync(toml, 'utf-8')).toBe(ciphertext)
  })

  it('writes temp copies and exposes their paths', async () => {
    const prepared = prepareRun(['streamlit', 'run'], await load(), 'temp')
    const copy = prepared.env['CF_MATERIALIZED_STREAMLIT_SECRETS_TOML'] ?? ''
    expect(readFileSync(copy, 'utf-8')).toContain(pw)
    prepared.cleanup?.()
    expect(existsSync(copy)).toBe(false)
  })

  it('without --materialize says which files the tool reads directly', async () => {
    const prepared = prepareRun(['streamlit', 'run'], await load(), null)
    expect(prepared.cleanup).toBeNull()
    expect(prepared.notes.join('\n')).toContain('.streamlit/secrets.toml')
  })
})

describe('sync engine codec', () => {
  const syncScope = { organisation: scope.org, workspace: scope.workspace, environment: 'dev' }

  it('decrypts what it reads and encrypts what it writes', async () => {
    const written = await encryptValues(
      api.client,
      syncScope,
      new Map([['NEW_KEY', apiValue]]),
      new Map(),
    )
    expect(written.get('NEW_KEY')).toMatch(/^cf:v1:1\./)
    const read = await decryptValues(api.client, syncScope, new Map([...written, ['PLAIN', 'x']]))
    expect(read).toEqual(
      new Map([
        ['NEW_KEY', apiValue],
        ['PLAIN', 'x'],
      ]),
    )
  })

  it('never asks for a key when a file holds no ciphertext', async () => {
    await decryptValues(api.client, syncScope, new Map([['A', '1']]))
    expect(api.requests).toHaveLength(0)
  })
})
