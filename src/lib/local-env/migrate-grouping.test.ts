/**
 * Grouping files into environments for `cf env migrate`, and the refusal of
 * names two files of one environment define with different values.
 *
 * Every value is generated per run.
 */
import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  describeConflict,
  findValueConflicts,
  groupedEnvironment,
  isGrouping,
} from '@/lib/local-env/migrate-grouping'

const gen = (): string => randomBytes(12).toString('base64url')

const file = (rel: string, environment: string, values: Array<[string, string]>) => ({
  rel,
  workspace: 'ws',
  environment,
  push: new Map(values),
})

describe('groupedEnvironment', () => {
  it('per-app is <app>-<stage>, keeping production apart', () => {
    expect(groupedEnvironment('apps/web/.env.local', 'per-app')).toBe('web-dev')
    expect(groupedEnvironment('apps/web/.env', 'per-app')).toBe('web-dev')
    expect(groupedEnvironment('apps/web/.env.production', 'per-app')).toBe('web-production')
    expect(groupedEnvironment('apps/api/.dev.vars', 'per-app')).toBe('api-dev')
    expect(groupedEnvironment('.envrc', 'per-app')).toBe('root-dev')
  })

  it('single uses -e, or dev', () => {
    expect(groupedEnvironment('apps/api/.dev.vars', 'single', 'local')).toBe('local')
    expect(groupedEnvironment('apps/api/.dev.vars', 'single')).toBe('dev')
  })

  it('knows its modes', () => {
    expect(isGrouping('per-app')).toBe(true)
    expect(isGrouping('per-folder')).toBe(false)
  })
})

describe('findValueConflicts', () => {
  it('allows one name with one value across files of an environment', () => {
    const shared = gen()
    expect(
      findValueConflicts([
        file('.env', 'dev', [['API_URL', shared]]),
        file('apps/web/.env', 'dev', [['API_URL', shared]]),
      ]),
    ).toEqual([])
  })

  it('refuses one name with two values in one environment, and names no value', () => {
    const first = gen()
    const second = gen()
    const conflicts = findValueConflicts([
      file('.env', 'dev', [
        ['TOKEN_A', first],
        ['OTHER', gen()],
      ]),
      file('apps/web/.env', 'dev', [['TOKEN_A', second]]),
    ])
    expect(conflicts).toEqual([
      { name: 'TOKEN_A', target: 'ws/dev', files: ['.env', 'apps/web/.env'] },
    ])
    const text = describeConflict(conflicts[0]!)
    expect(text).toContain('TOKEN_A')
    expect(text).not.toContain(first)
    expect(text).not.toContain(second)
  })

  it('ignores the same name in different environments', () => {
    expect(
      findValueConflicts([
        file('.env', 'root-dev', [['TOKEN_A', gen()]]),
        file('apps/web/.env', 'web-dev', [['TOKEN_A', gen()]]),
      ]),
    ).toEqual([])
  })
})
