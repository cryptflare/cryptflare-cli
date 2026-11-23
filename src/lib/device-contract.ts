/**
 * The CLI's copy of the device-report contract (`PUT /v1/devices/self`).
 *
 * The source of truth is `@cryptflare/shared` (`constants/device-statuses`,
 * `constants/devices`, `schemas/devices`). The published CLI is built in a
 * public mirror that has only `constants/brand` from that package
 * (`mirror-imports.test.ts`), so the values the CLI needs are repeated here.
 * `device-contract.test.ts` fails in this monorepo the moment the two drift,
 * and checks a built report against the API's own schema.
 */

export const DEVICE_PLATFORMS = ['linux', 'macos', 'windows', 'wsl', 'other'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

export const DEVICE_SERVICES = ['systemd', 'launchd', 'windows-task', 'none'] as const
export type DeviceService = (typeof DEVICE_SERVICES)[number]

export const DEVICE_SERVICE_STATES = [
  'running',
  'stopped',
  'not-installed',
  'needs-login',
  'unknown',
] as const
export type DeviceServiceState = (typeof DEVICE_SERVICE_STATES)[number]

export const DEVICE_PASS_RESULTS = ['ok', 'partial', 'failed'] as const
export type DevicePassResult = (typeof DEVICE_PASS_RESULTS)[number]

export const DEVICE_ERROR_CODES = [
  'auth',
  'network',
  'rate-limited',
  'plan-limit',
  'collision',
  'server',
  'local-file',
  'unknown',
] as const
export type DeviceErrorCode = (typeof DEVICE_ERROR_CODES)[number]

export const DEVICE_PLATFORM = {
  LINUX: 'linux',
  MACOS: 'macos',
  WINDOWS: 'windows',
  WSL: 'wsl',
  OTHER: 'other',
} as const satisfies Record<string, DevicePlatform>

export const DEVICE_SERVICE = {
  SYSTEMD: 'systemd',
  LAUNCHD: 'launchd',
  WINDOWS_TASK: 'windows-task',
  NONE: 'none',
} as const satisfies Record<string, DeviceService>

export const DEVICE_SERVICE_STATE = {
  RUNNING: 'running',
  STOPPED: 'stopped',
  NOT_INSTALLED: 'not-installed',
  NEEDS_LOGIN: 'needs-login',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, DeviceServiceState>

export const DEVICE_PASS_RESULT = {
  OK: 'ok',
  PARTIAL: 'partial',
  FAILED: 'failed',
} as const satisfies Record<string, DevicePassResult>

export const DEVICE_ERROR_CODE = {
  AUTH: 'auth',
  NETWORK: 'network',
  RATE_LIMITED: 'rate-limited',
  PLAN_LIMIT: 'plan-limit',
  COLLISION: 'collision',
  SERVER: 'server',
  LOCAL_FILE: 'local-file',
  UNKNOWN: 'unknown',
} as const satisfies Record<string, DeviceErrorCode>

/** Longest device name the API takes. */
export const DEVICE_NAME_MAX_LENGTH = 120

/** How often `cf sync watch` reports when nothing changed. */
export const DEVICE_REPORT_INTERVAL_MS = 5 * 60_000

/** How long a report may take before the CLI gives up on it. */
export const DEVICE_REPORT_TIMEOUT_MS = 5_000

/** `CRYPTFLARE_DEVICE_REPORT=0` turns device reports off. */
export const DEVICE_REPORT_ENV = 'CRYPTFLARE_DEVICE_REPORT'

/** What `cf sync install-service` installs, per platform. */
export const SYNC_SERVICE_NAMES = {
  systemdUnit: 'cryptflare-sync.service',
  launchdLabel: 'com.cryptflare.sync',
  launchdLog: '~/Library/Logs/cryptflare-sync.log',
  windowsTask: 'CryptFlare Sync',
  windowsLog: 'sync-service.log',
} as const

/** Node's `process.platform` as a device platform. */
export function devicePlatformFromOs(os: string, isWsl = false): DevicePlatform {
  if (os === 'linux') return isWsl ? DEVICE_PLATFORM.WSL : DEVICE_PLATFORM.LINUX
  if (os === 'darwin') return DEVICE_PLATFORM.MACOS
  if (os === 'win32') return DEVICE_PLATFORM.WINDOWS
  return DEVICE_PLATFORM.OTHER
}

/** The last pass, as `DeviceLastPassSchema` takes it. */
export type DeviceLastPass = {
  at: string
  result: DevicePassResult
  errorCode?: DeviceErrorCode | null
}

/** The request body, as `DeviceReportBodySchema` takes it. */
export type DeviceReportBody = {
  hostname?: string
  platform?: DevicePlatform
  cliVersion?: string
  service: DeviceService
  serviceState: DeviceServiceState
  projects: number
  bindings: number
  lastPass?: DeviceLastPass | null
}
