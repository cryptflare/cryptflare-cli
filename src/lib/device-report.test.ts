import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/config', () => ({ getDeviceReportSetting: () => undefined }))
vi.mock('@/lib/api', () => ({ getClient: vi.fn() }))

import { DEVICE_REPORT_INTERVAL_MS, type DeviceReportBody } from '@/lib/device-contract'
import {
  buildDeviceReport,
  classifyError,
  countRegistry,
  createDeviceReporter,
  detectPlatform,
  isDeviceReportEnabled,
  isWsl,
  lastPassOf,
  reportDeviceSafely,
  type DeviceReportInput,
} from '@/lib/device-report'
import type { SyncRegistry } from '@/lib/sync-registry'

/** A registry full of things a report must never carry. */
function buildRegistry(): SyncRegistry {
  return {
    version: 1,
    projects: [
      {
        id: 'acme-billing-api',
        path: '/home/dev/code/acme-billing-api',
        workspace: 'acme-billing',
        enabled: true,
        bindings: [
          { file: '.env', environment: 'dev' },
          { file: 'apps/api/.dev.vars', environment: 'api-dev-worker', workspace: 'acme-api' },
        ],
      },
      {
        id: 'side-project',
        path: '/home/dev/code/side-project',
        workspace: 'side',
        enabled: false,
        bindings: [{ file: '.env.production', environment: 'production' }],
      },
    ],
  } as SyncRegistry
}

function buildReport(overrides: Partial<DeviceReportInput> = {}): DeviceReportBody {
  return buildDeviceReport({
    platform: 'linux',
    hostname: 'dev-laptop',
    cliVersion: '0.10.0',
    service: 'systemd',
    serviceState: 'running',
    projects: 1,
    bindings: 2,
    lastPass: lastPassOf({ bindings: 2, failures: 0, authFailures: 0, collisions: 0 }),
    ...overrides,
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('buildDeviceReport', () => {
  it('carries counts and states only, never a path, project, workspace or environment', () => {
    const counts = countRegistry(buildRegistry)
    expect(counts).toEqual({ projects: 1, bindings: 2 })
    const report = buildReport(counts)
    expect(Object.keys(report).sort()).toEqual([
      'bindings',
      'cliVersion',
      'hostname',
      'lastPass',
      'platform',
      'projects',
      'service',
      'serviceState',
    ])
    const sent = JSON.stringify(report)
    for (const leak of [
      '/home/dev',
      'acme-billing',
      'side-project',
      '.env',
      '.dev.vars',
      'api-dev-worker',
      'production',
    ]) {
      expect(sent).not.toContain(leak)
    }
  })

  it('counts nothing when the registry cannot be read', () => {
    expect(
      countRegistry(() => {
        throw new Error('half-edited /home/dev/.config/sync.json')
      }),
    ).toEqual({ projects: 0, bindings: 0 })
  })

  it('strips control characters from the hostname and leaves out an empty one', () => {
    expect(buildReport({}).hostname).toBe('dev-laptop')
    const report = buildDeviceReport({
      platform: 'linux',
      hostname: '\u0007\n',
      cliVersion: '0.10.0',
      service: 'none',
      serviceState: 'not-installed',
      projects: 0,
      bindings: 0,
    })
    expect(report).not.toHaveProperty('hostname')
    expect(report).not.toHaveProperty('lastPass')
  })
})

describe('platform detection', () => {
  it('tells WSL from Linux by the kernel release or WSL_DISTRO_NAME', () => {
    expect(isWsl('5.15.153.1-microsoft-standard-WSL2', {})).toBe(true)
    expect(isWsl('6.8.0-45-generic', {})).toBe(false)
    expect(isWsl('6.8.0-45-generic', { WSL_DISTRO_NAME: 'Ubuntu' })).toBe(true)
    expect(detectPlatform('linux', '5.15.153.1-microsoft-standard-WSL2', {})).toBe('wsl')
    expect(detectPlatform('linux', '6.8.0-45-generic', {})).toBe('linux')
    expect(detectPlatform('darwin', '24.0.0', {})).toBe('macos')
    expect(detectPlatform('win32', '10.0.22631', {})).toBe('windows')
  })
})

describe('lastPassOf', () => {
  it('reads ok, partial and failed from the pass summary, with a short code', () => {
    const at = new Date('2026-11-23T12:00:00.000Z')
    expect(lastPassOf({ bindings: 3, failures: 0, authFailures: 0, collisions: 0 }, at)).toEqual({
      at: at.toISOString(),
      result: 'ok',
      errorCode: null,
    })
    expect(
      lastPassOf({
        bindings: 3,
        failures: 1,
        authFailures: 0,
        collisions: 0,
        errorCode: 'network',
      }),
    ).toMatchObject({ result: 'partial', errorCode: 'network' })
    expect(lastPassOf({ bindings: 3, failures: 3, authFailures: 3, collisions: 0 })).toMatchObject({
      result: 'failed',
      errorCode: 'auth',
    })
    expect(lastPassOf({ bindings: 3, failures: 0, authFailures: 0, collisions: 1 })).toMatchObject({
      result: 'partial',
      errorCode: 'collision',
    })
  })
})

describe('classifyError', () => {
  it('maps a failure to a code, never its message', () => {
    expect(classifyError(Object.assign(new Error('x'), { status: 401 }))).toBe('auth')
    expect(classifyError(Object.assign(new Error('x'), { status: 429 }))).toBe('rate-limited')
    expect(classifyError(Object.assign(new Error('x'), { status: 503 }))).toBe('server')
    expect(
      classifyError(
        Object.assign(new Error("ENOENT: no such file '/home/dev/app/.env'"), { code: 'ENOENT' }),
      ),
    ).toBe('local-file')
    expect(classifyError(Object.assign(new Error('down'), { code: 'ECONNREFUSED' }))).toBe(
      'network',
    )
    expect(classifyError('something else')).toBe('unknown')
  })
})

describe('isDeviceReportEnabled', () => {
  it('is on by default, off by the environment variable or the saved setting', () => {
    expect(isDeviceReportEnabled({}, undefined)).toBe(true)
    expect(isDeviceReportEnabled({ CRYPTFLARE_DEVICE_REPORT: '0' }, undefined)).toBe(false)
    expect(isDeviceReportEnabled({ CRYPTFLARE_DEVICE_REPORT: 'off' }, true)).toBe(false)
    expect(isDeviceReportEnabled({}, false)).toBe(false)
  })
})

describe('reportDeviceSafely', () => {
  it('swallows a failed report', async () => {
    const send = vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { status: 401 }))
    await expect(reportDeviceSafely(buildReport(), send)).resolves.toBeUndefined()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('gives up on a report that never answers', async () => {
    vi.useFakeTimers()
    const pending = reportDeviceSafely(buildReport(), () => new Promise<void>(() => undefined))
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toBeUndefined()
  })

  it('sends nothing when reporting is off', async () => {
    vi.stubEnv('CRYPTFLARE_DEVICE_REPORT', '0')
    const send = vi.fn().mockResolvedValue(undefined)
    await reportDeviceSafely(buildReport(), send)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('createDeviceReporter', () => {
  it('sends the first report, a change of state at once, and otherwise every interval', async () => {
    let clock = 1_000_000
    const send = vi.fn().mockResolvedValue(undefined)
    const report = createDeviceReporter({ send, now: () => clock })

    expect(await report(buildReport())).toBe(true)
    clock += 60_000
    expect(await report(buildReport())).toBe(false)

    expect(await report(buildReport({ serviceState: 'stopped' }))).toBe(true)
    clock += 60_000
    expect(await report(buildReport({ serviceState: 'stopped' }))).toBe(false)

    clock += DEVICE_REPORT_INTERVAL_MS
    expect(await report(buildReport({ serviceState: 'stopped' }))).toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
  })
})
