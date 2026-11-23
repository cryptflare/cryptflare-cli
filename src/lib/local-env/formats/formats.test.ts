/**
 * Every format: parse, encrypt, decrypt. Encryption must change nothing but
 * the managed values, and decryption must give the original values back.
 *
 * Secret-shaped fixture values are generated per run, never written literally.
 */
import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { decryptContent, encryptContent } from '@/lib/local-env/codec'
import { detectFormat, formatById, type FileFormat } from '@/lib/local-env/formats'
import { keyIdOf, type LocalKey } from '@/lib/local-env/value-crypto'

function key(version = 1): LocalKey {
  const raw = randomBytes(32)
  const keyId = keyIdOf(raw)
  return { environmentId: 'env_dev', version, keyId, keyRef: `${version}.${keyId}`, raw }
}

/** A random, high-entropy fixture value. */
const gen = (prefix = ''): string => `${prefix}${randomBytes(18).toString('base64url')}`

/** Text outside every value span, which encryption must leave byte for byte. */
function skeleton(content: string, format: FileFormat): string {
  const entries = [...format.parse(content).entries].sort((a, b) => b.start - a.start)
  let out = content
  for (const entry of entries) out = `${out.slice(0, entry.start)}<V>${out.slice(entry.end)}`
  return out
}

function roundTrip(format: FileFormat, content: string, opts = {}) {
  const k = key()
  const encrypted = encryptContent(content, format, k, opts)
  const decrypted = decryptContent(encrypted.content, format, new Map([[k.keyRef, k]]))
  return { k, encrypted, decrypted }
}

function valuesOf(format: FileFormat, content: string): Map<string, string> {
  return new Map(format.parse(content).entries.map((e) => [format.envName(e), e.value]))
}

const DOTENV = [
  '# comment line',
  '',
  'PLAIN=abc123',
  'export EXPORTED=exp-value',
  '  INDENTED = spaced  # trailing comment',
  'DOUBLE="has spaces and \\"escapes\\" and $dollar"',
  "SINGLE='literal $HOME'",
  'MULTI="-----BEGIN KEY-----',
  'line two',
  '-----END KEY-----"',
  'EMPTY=',
  'REF=${OTHER}',
  'NEXT_PUBLIC_SITE=https://example.com',
  'DUP=first',
  'DUP=second',
  'HASH=abc#123',
  'NO_NEWLINE_AT_END=last',
].join('\n')

describe('dotenv family', () => {
  const format = formatById('dotenv')

  it('changes only the managed values', () => {
    const { encrypted } = roundTrip(format, DOTENV)
    expect(skeleton(encrypted.content, format)).toBe(skeleton(DOTENV, format))
    expect(encrypted.content).not.toMatch(/abc123|exp-value|BEGIN KEY|literal \$HOME|second/)
  })

  it('decrypts to the original values, multi-line included', () => {
    const { decrypted } = roundTrip(format, DOTENV)
    for (const [name, value] of valuesOf(format, DOTENV)) {
      expect(decrypted.values.get(name), name).toBe(value)
    }
    expect(decrypted.values.get('MULTI')).toBe('-----BEGIN KEY-----\nline two\n-----END KEY-----')
    expect(decrypted.values.get('HASH')).toBe('abc#123')
    expect(decrypted.values.get('INDENTED')).toBe('spaced')
  })

  it('leaves empty values, references and browser-public names plaintext', () => {
    const { encrypted } = roundTrip(format, DOTENV)
    expect(encrypted.content).toContain('EMPTY=\n')
    expect(encrypted.content).toContain('REF=${OTHER}')
    expect(encrypted.content).toContain('NEXT_PUBLIC_SITE=https://example.com')
  })

  it('encrypts browser-public names only when asked', () => {
    const { encrypted } = roundTrip(format, DOTENV, { includePublic: true })
    expect(encrypted.content).not.toContain('https://example.com')
  })

  it('encrypts every copy of a duplicate key; the last one wins on decrypt', () => {
    const { encrypted, decrypted } = roundTrip(format, DOTENV)
    expect(encrypted.encrypted.filter((name) => name === 'DUP')).toHaveLength(2)
    expect(decrypted.values.get('DUP')).toBe('second')
  })

  it('keeps CRLF line endings', () => {
    const crlf = 'A=one\r\nexport B="two"\r\n# c\r\n'
    const { encrypted, decrypted } = roundTrip(format, crlf)
    expect(encrypted.content).toMatch(/^A=cf:v1:[^\r\n]+\r\nexport B="cf:v1:[^"]+"\r\n# c\r\n$/)
    expect(decrypted.values.get('A')).toBe('one')
    expect(decrypted.plaintext).toBe(crlf)
  })

  it('is idempotent: encrypting twice leaves ciphertext alone', () => {
    const k = key()
    const once = encryptContent(DOTENV, format, k).content
    expect(encryptContent(once, format, k).content).toBe(once)
  })

  it('rotates every value to the next key version', () => {
    const k1 = key(1)
    const k2 = key(2)
    const v1 = encryptContent('A=one\nB=two\n', format, k1).content
    const v2 = encryptContent(v1, format, k2, {
      rotate: true,
      existing: new Map([[k1.keyRef, k1]]),
    })
    expect(v2.content).not.toContain(k1.keyRef)
    expect(decryptContent(v2.content, format, new Map([[k2.keyRef, k2]])).values.get('B')).toBe(
      'two',
    )
  })

  it('round-trips a plain file exactly through decryption', () => {
    const plain = 'A=one\n# keep\nexport B=two\n\nC=three'
    expect(roundTrip(format, plain).decrypted.plaintext).toBe(plain)
  })

  it('gives back each quote style and the spacing around = after decryption', () => {
    const plain = `A="${gen()}"\nB='${gen()}'\nC = "${gen()}"\nexport D="x $HOME \\"q\\" \\\\ y"\n`
    const result = roundTrip(format, plain)
    expect(result.encrypted.content).toMatch(/^A="cf:v1:[^"]+"\nB='cf:v1:[^']+'\nC = "cf:v1:/)
    expect(result.decrypted.plaintext).toBe(plain)
    expect(result.decrypted.values.get('D')).toBe('x $HOME "q" \\ y')
  })

  it('treats .envrc with the same parser and leaves shell lines alone', () => {
    const envrc = 'use flake\nexport TOKEN=abc\nwatch_file x\n'
    const result = roundTrip(formatById('envrc'), envrc)
    expect(result.encrypted.content.startsWith('use flake\nexport TOKEN=cf:v1:')).toBe(true)
    expect(result.encrypted.content.endsWith('\nwatch_file x\n')).toBe(true)
    expect(result.decrypted.values.get('TOKEN')).toBe('abc')
  })
})

describe('toml', () => {
  const format = formatById('toml')
  const apiKey = gen('sk_')
  const toml = [
    '# Dynaconf secrets',
    `api_key = "${apiKey}"`,
    "password = 'p w'",
    'debug = true',
    'port = 8080',
    'name = "my-app"',
    '',
    '[database]',
    'password = "db-\\"x\\""',
    'hosts = ["a", "b"]',
    'notes = """',
    'multi',
    '"""',
  ].join('\n')

  it('encrypts secret-looking strings only, by table path', () => {
    const { encrypted, decrypted } = roundTrip(format, toml)
    expect(encrypted.encrypted.sort()).toEqual(['api_key', 'database.password', 'password'])
    expect(encrypted.content).toContain('name = "my-app"')
    expect(encrypted.content).toContain('debug = true')
    expect(encrypted.content).not.toContain(apiKey)
    expect(skeleton(encrypted.content, format)).toBe(skeleton(toml, format))
    expect(decrypted.values.get('DATABASE_PASSWORD')).toBe('db-"x"')
    expect(decrypted.values.get('API_KEY')).toBe(apiKey)
  })

  it('reports multi-line strings and arrays as unmanaged', () => {
    const reasons = format.parse(toml).unmanaged.map((item) => item.reason)
    expect(reasons).toContain('multi-line string')
    expect(reasons).toContain('array or inline table')
  })

  it('claims Streamlit and Dynaconf paths', () => {
    expect(detectFormat('.streamlit/secrets.toml')?.id).toBe('toml')
    expect(detectFormat('app/.secrets.toml')?.id).toBe('toml')
    expect(detectFormat('pyproject.toml')).toBeNull()
  })
})

describe('json', () => {
  const format = formatById('json')
  const stripe = gen('sk_test_')
  const json = `{
  // .NET allows comments
  "Logging": { "LogLevel": { "Default": "Information" } },
  "ConnectionStrings": { "Default": "Server=db;Password=x;" },
  "Stripe": { "SecretKey": "${stripe}" },
  "servers": [ { "password": "pw1" } ],
  "enabled": true,
}
`

  it('encrypts secret-looking string values by key path and keeps the rest byte for byte', () => {
    const { encrypted, decrypted } = roundTrip(format, json)
    expect(encrypted.encrypted.sort()).toEqual([
      'ConnectionStrings.Default',
      'Stripe.SecretKey',
      'servers.0.password',
    ])
    expect(encrypted.content).toContain('"Default": "Information"')
    expect(skeleton(encrypted.content, format)).toBe(skeleton(json, format))
    expect(decrypted.values.get('STRIPE_SECRET_KEY')).toBe(stripe)
  })

  it('reports a file it cannot scan instead of rewriting it', () => {
    expect(format.parse('{ "a": ').unmanaged).toHaveLength(1)
  })
})

describe('tfvars', () => {
  const format = formatById('tfvars')
  const tfvars = [
    'region = "eu-west-1"',
    'db_password = "x-y"  # comment',
    'tags = {',
    '  token = "inside-a-map"',
    '}',
    'policy = <<EOT',
    'other = "inside-a-heredoc"',
    'EOT',
  ].join('\n')

  it('manages top-level strings only', () => {
    expect(format.parse(tfvars).entries.map((entry) => entry.name)).toEqual([
      'region',
      'db_password',
    ])
    const { encrypted, decrypted } = roundTrip(format, tfvars)
    expect(encrypted.encrypted).toEqual(['db_password'])
    expect(encrypted.content).toContain('token = "inside-a-map"')
    expect(encrypted.content).toContain('# comment')
    expect(decrypted.values.get('DB_PASSWORD')).toBe('x-y')
  })
})

describe('whole-file and registry formats', () => {
  it('encrypts a Rails master key as RAILS_MASTER_KEY', () => {
    const format = formatById('rails-master-key')
    const master = randomBytes(16).toString('hex')
    const { encrypted, decrypted } = roundTrip(format, `${master}\n`)
    expect(encrypted.content).toMatch(/^cf:v1:\S+\n$/)
    expect(decrypted.values.get('RAILS_MASTER_KEY')).toBe(master)
    expect(detectFormat('config/master.key')?.id).toBe('rails-master-key')
  })

  it('never encrypts registry tokens in place', () => {
    const format = formatById('registry-auth')
    const npmrc = `//registry.npmjs.org/:_authToken=${gen('npm_')}\n//npm.acme.dev/:_authToken=\${ACME}\n`
    const { encrypted } = roundTrip(format, npmrc)
    expect(encrypted.content).toBe(npmrc)
    const [token] = format.parse(npmrc).entries
    expect(token && format.envName(token)).toBe('NPM_TOKEN')
  })

  it('reads yarn tokens too', () => {
    const format = formatById('registry-auth')
    expect(format.parse('npmScopes:\n  acme:\n    npmAuthToken: "abc"\n').entries[0]?.value).toBe(
      'abc',
    )
  })
})

describe('detection', () => {
  it.each([
    ['.env', 'dotenv'],
    ['apps/web/.env.local', 'dotenv'],
    ['.env.production.local', 'dotenv'],
    ['.flaskenv', 'dotenv'],
    ['apps/api/.dev.vars', 'dev-vars'],
    ['.dev.vars.staging', 'dev-vars'],
    ['.envrc', 'envrc'],
    ['infra/prod.auto.tfvars', 'tfvars'],
    ['.runtimeconfig.json', 'json'],
    ['src/appsettings.Development.json', 'json'],
    ['.npmrc', 'registry-auth'],
  ])('%s is %s', (path, id) => {
    expect(detectFormat(path)?.id).toBe(id)
  })

  it.each([
    '.env.example',
    '.env.sample',
    '.dev.vars.example',
    'secrets.sample.toml',
    '.env.cf-restore',
    '.env.bak',
  ])('%s is never encrypted', (path) => {
    expect(detectFormat(path)).toBeNull()
  })

  it('treats a compose env_file target as materialised dotenv whatever its name', () => {
    expect(detectFormat('docker/app.env', new Set(['docker/app.env']))?.id).toBe('compose-env')
  })
})
