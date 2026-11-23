/**
 * The CLI's copy of the device contract against the source of truth in
 * `@cryptflare/shared`, and a built report against the API's own schema.
 *
 * The shared files are loaded by path at run time, not imported by name:
 * the public mirror has no `@cryptflare/shared` (`mirror-imports.test.ts`),
 * so there the files are missing and this test is skipped. In this
 * monorepo it fails the moment the two copies drift.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as contract from '@/lib/device-contract'
import { buildDeviceReport, lastPassOf } from '@/lib/device-report'

const SHARED_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../shared/src')
const STATUSES = join(SHARED_SRC, 'constants/device-statuses.ts')
const DEVICES = join(SHARED_SRC, 'constants/devices.ts')
const SCHEMAS = join(SHARED_SRC, 'schemas/devices.ts')
const inMonorepo = [STATUSES, DEVICES, SCHEMAS].every((path) => existsSync(path))

/** Loads a shared module by path; the mirror never gets here. */
async function load(path: string): Promise<Record<string, unknown>> {
  const module: unknown = await import(/* @vite-ignore */ path)
  return module as Record<string, unknown>
}

describe.skipIf(!inMonorepo)('device contract', () => {
  it('repeats the shared enums and limits exactly', async () => {
    const statuses = await load(STATUSES)
    const devices = await load(DEVICES)
    for (const name of [
      'DEVICE_PLATFORMS',
      'DEVICE_SERVICES',
      'DEVICE_SERVICE_STATES',
      'DEVICE_PASS_RESULTS',
      'DEVICE_ERROR_CODES',
      'DEVICE_PLATFORM',
      'DEVICE_SERVICE',
      'DEVICE_SERVICE_STATE',
      'DEVICE_PASS_RESULT',
      'DEVICE_ERROR_CODE',
    ] as const) {
      expect(contract[name], name).toEqual(statuses[name])
    }
    for (const name of [
      'DEVICE_NAME_MAX_LENGTH',
      'DEVICE_REPORT_INTERVAL_MS',
      'DEVICE_REPORT_TIMEOUT_MS',
      'DEVICE_REPORT_ENV',
      'SYNC_SERVICE_NAMES',
    ] as const) {
      expect(contract[name], name).toEqual(devices[name])
    }
  })

  it('builds a report the API schema accepts', async () => {
    const schemas = await load(SCHEMAS)
    const schema = schemas.DeviceReportBodySchema as {
      safeParse: (value: unknown) => { success: boolean }
    }
    for (const platform of contract.DEVICE_PLATFORMS) {
      const report = buildDeviceReport({
        platform,
        hostname: 'dev-laptop',
        cliVersion: '0.10.0',
        service: 'systemd',
        serviceState: 'running',
        projects: 2,
        bindings: 5,
        lastPass: lastPassOf({
          bindings: 5,
          failures: 1,
          authFailures: 0,
          collisions: 0,
          errorCode: 'network',
        }),
      })
      expect(schema.safeParse(report).success, platform).toBe(true)
    }
  })
})
