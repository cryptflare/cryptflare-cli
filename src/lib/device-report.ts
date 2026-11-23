/**
 * Device reports: `cf sync` tells the dashboard's devices page what this
 * machine is doing (`PUT /v1/devices/self`). Counts, states and short codes
 * only. Nothing here ever reads a file path, project id, workspace,
 * environment, key or value into the report, and the API refuses any field
 * it does not know.
 *
 * Reporting is a side channel. It never throws, never retries, gives up
 * after a few seconds, and says why it failed at most once, and only when
 * `CF_DEBUG` is set. Turned off by `CRYPTFLARE_DEVICE_REPORT=0` or
 * `cf device report off`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { hostname, release } from 'node:os'
import { dirname } from 'node:path'

import { getClient } from '@/lib/api'
import { getDeviceReportSetting } from '@/lib/config'
import {
  DEVICE_ERROR_CODE,
  DEVICE_NAME_MAX_LENGTH,
  DEVICE_PASS_RESULT,
  DEVICE_REPORT_ENV,
  DEVICE_REPORT_INTERVAL_MS,
  DEVICE_REPORT_TIMEOUT_MS,
  DEVICE_SERVICE,
  DEVICE_SERVICE_STATE,
  devicePlatformFromOs,
  type DeviceErrorCode,
  type DeviceLastPass,
  type DevicePlatform,
  type DeviceReportBody,
  type DeviceService,
  type DeviceServiceState,
} from '@/lib/device-contract'
import { errorCode, errorMessage, errorStatus } from '@/lib/guards'
import * as output from '@/lib/output'
import { LAUNCHD_LABEL, launchdPlistPath } from '@/lib/service/launchd'
import { SYSTEMD_SERVICE_NAME, systemdUnitPath } from '@/lib/service/spec'
import { WINDOWS_TASK_NAME, windowsLauncherPath } from '@/lib/service/windows'
import { getRegistryPath, loadRegistry, type SyncRegistry } from '@/lib/sync-registry'
import { VERSION } from '@/version'

/** Off when the environment says so, else when `cf device report off` was run. */
export function isDeviceReportEnabled(
  env: NodeJS.ProcessEnv = process.env,
  saved: boolean | undefined = getDeviceReportSetting(),
): boolean {
  const flag = env[DEVICE_REPORT_ENV]?.trim().toLowerCase()
  if (flag === '0' || flag === 'false' || flag === 'off') return false
  return saved !== false
}

/** WSL's kernel says so in its release string; WSL also sets `WSL_DISTRO_NAME`. */
export function isWsl(kernelRelease: string = release(), env: NodeJS.ProcessEnv = process.env) {
  return /microsoft|wsl/i.test(kernelRelease) || Boolean(env.WSL_DISTRO_NAME)
}

/** This machine's platform, with WSL told apart from plain Linux. */
export function detectPlatform(
  platform: NodeJS.Platform = process.platform,
  kernelRelease: string = release(),
  env: NodeJS.ProcessEnv = process.env,
): DevicePlatform {
  return devicePlatformFromOs(platform, platform === 'linux' && isWsl(kernelRelease, env))
}

/** Which background service `cf sync install-service` left on this machine, if any. */
export function installedService(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): DeviceService {
  if (platform === 'linux' && exists(systemdUnitPath())) return DEVICE_SERVICE.SYSTEMD
  if (platform === 'darwin' && exists(launchdPlistPath())) return DEVICE_SERVICE.LAUNCHD
  if (platform === 'win32' && exists(windowsLauncherPath(dirname(getRegistryPath())))) {
    return DEVICE_SERVICE.WINDOWS_TASK
  }
  return DEVICE_SERVICE.NONE
}

/** Runs a status command: its output when it exits 0, else null. Never throws. */
function runStatus(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 })
      .toString()
      .trim()
  } catch {
    // Not running, not installed, or the tool is missing: all mean "not running".
    return null
  }
}

/** Asks the service manager whether the installed service is running. */
export function probeServiceState(service: DeviceService): DeviceServiceState {
  switch (service) {
    case DEVICE_SERVICE.SYSTEMD:
      return runStatus('systemctl', ['--user', 'is-active', SYSTEMD_SERVICE_NAME]) === 'active'
        ? DEVICE_SERVICE_STATE.RUNNING
        : DEVICE_SERVICE_STATE.STOPPED
    case DEVICE_SERVICE.LAUNCHD:
      return runStatus('launchctl', ['list', LAUNCHD_LABEL]) === null
        ? DEVICE_SERVICE_STATE.STOPPED
        : DEVICE_SERVICE_STATE.RUNNING
    case DEVICE_SERVICE.WINDOWS_TASK: {
      const csv = runStatus('schtasks.exe', [
        '/Query',
        '/TN',
        WINDOWS_TASK_NAME,
        '/FO',
        'CSV',
        '/NH',
      ])
      if (csv === null) return DEVICE_SERVICE_STATE.STOPPED
      return /"Running"/i.test(csv) ? DEVICE_SERVICE_STATE.RUNNING : DEVICE_SERVICE_STATE.STOPPED
    }
    default:
      return DEVICE_SERVICE_STATE.NOT_INSTALLED
  }
}

/** Enabled projects and their bound files. A registry that cannot be read counts as empty. */
export function countRegistry(read: () => SyncRegistry = loadRegistry): {
  projects: number
  bindings: number
} {
  try {
    const enabled = read().projects.filter((project) => project.enabled)
    return {
      projects: enabled.length,
      bindings: enabled.reduce((n, project) => n + project.bindings.length, 0),
    }
  } catch {
    // Half-edited or missing: the next report counts again.
    return { projects: 0, bindings: 0 }
  }
}

/** A failure as a short code, never its message (which names files and keys). */
export function classifyError(err: unknown): DeviceErrorCode {
  const status = errorStatus(err)
  if (status === 401 || status === 403) return DEVICE_ERROR_CODE.AUTH
  if (status === 429) return DEVICE_ERROR_CODE.RATE_LIMITED
  if (status === 402) return DEVICE_ERROR_CODE.PLAN_LIMIT
  if (status !== undefined && status >= 500) return DEVICE_ERROR_CODE.SERVER
  if (status !== undefined) return DEVICE_ERROR_CODE.UNKNOWN
  const code = errorCode(err) ?? ''
  if (/^(ENOENT|EACCES|EPERM|EISDIR|ENOTDIR|EROFS|EBUSY)$/.test(code)) {
    return DEVICE_ERROR_CODE.LOCAL_FILE
  }
  if (err instanceof Error && /connection|timeout|network|fetch/i.test(err.name)) {
    return DEVICE_ERROR_CODE.NETWORK
  }
  if (/^(ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|UND_ERR)/.test(code)) return DEVICE_ERROR_CODE.NETWORK
  return DEVICE_ERROR_CODE.UNKNOWN
}

/** What a sync pass tells the dashboard: the pass summary's counts, nothing else. */
export type PassOutcome = {
  bindings: number
  failures: number
  authFailures: number
  collisions: number
  errorCode?: DeviceErrorCode | undefined
}

/** How a pass ended: `ok`, `partial` (some files failed or collided) or `failed` (every file failed). */
export function lastPassOf(outcome: PassOutcome, at: Date = new Date()): DeviceLastPass {
  const troubled = outcome.failures + outcome.collisions
  const result =
    troubled === 0
      ? DEVICE_PASS_RESULT.OK
      : outcome.bindings > 0 && outcome.failures >= outcome.bindings
        ? DEVICE_PASS_RESULT.FAILED
        : DEVICE_PASS_RESULT.PARTIAL
  const errorCode: DeviceErrorCode | null =
    result === DEVICE_PASS_RESULT.OK
      ? null
      : outcome.authFailures > 0
        ? DEVICE_ERROR_CODE.AUTH
        : outcome.failures === 0 && outcome.collisions > 0
          ? DEVICE_ERROR_CODE.COLLISION
          : (outcome.errorCode ?? DEVICE_ERROR_CODE.UNKNOWN)
  return { at: at.toISOString(), result, errorCode }
}

/** Everything a report is built from. Each field is a count, a state or a code. */
export type DeviceReportInput = {
  platform: DevicePlatform
  hostname: string
  cliVersion: string
  service: DeviceService
  serviceState: DeviceServiceState
  projects: number
  bindings: number
  /** Omitted when this command ran no pass; the API then keeps the last one it has. */
  lastPass?: DeviceLastPass | undefined
}

/** The request body, from counts and states only. Pure: tested for what it can never contain. */
export function buildDeviceReport(input: DeviceReportInput): DeviceReportBody {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is stripped
  const name = input.hostname.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return {
    ...(name ? { hostname: name.slice(0, DEVICE_NAME_MAX_LENGTH) } : {}),
    platform: input.platform,
    cliVersion: input.cliVersion,
    service: input.service,
    serviceState: input.serviceState,
    projects: input.projects,
    bindings: input.bindings,
    ...(input.lastPass === undefined ? {} : { lastPass: input.lastPass }),
  }
}

/** The report for this machine right now, reading the registry and the installed service. */
export function currentDeviceReport(opts: {
  /** True from `cf sync watch`: this process is the sync loop. */
  running?: boolean
  serviceState?: DeviceServiceState
  lastPass?: DeviceLastPass | undefined
}): DeviceReportBody {
  const service = installedService()
  const serviceState =
    opts.serviceState ?? (opts.running ? DEVICE_SERVICE_STATE.RUNNING : probeServiceState(service))
  return buildDeviceReport({
    platform: detectPlatform(),
    hostname: hostname(),
    cliVersion: VERSION,
    service,
    serviceState,
    ...countRegistry(),
    lastPass: opts.lastPass,
  })
}

export type SendReport = (body: DeviceReportBody) => Promise<void>

/** `PUT /v1/devices/self` through the CLI's client: no retries, a short timeout. */
export const sendDeviceReport: SendReport = async (body) => {
  await getClient().request<void>(
    { method: 'PUT', path: '/v1/devices/self', body },
    { timeoutMs: DEVICE_REPORT_TIMEOUT_MS, retry: false },
  )
}

let failureLogged = false

/** Logs the first failed report of the process, only under `CF_DEBUG`. */
function noteFailure(err: unknown): void {
  if (failureLogged || !process.env.CF_DEBUG) return
  failureLogged = true
  output.printError(
    `[device] report not sent (${errorStatus(err) ?? errorMessage(err)}); sync is unaffected`,
  )
}

/** Sends one report, swallowing every failure. Resolves within the timeout either way. */
export async function reportDeviceSafely(
  body: DeviceReportBody,
  send: SendReport = sendDeviceReport,
): Promise<void> {
  if (!isDeviceReportEnabled()) return
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      send(body),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DEVICE_REPORT_TIMEOUT_MS + 500)
        timer.unref?.()
      }),
    ])
  } catch (err) {
    noteFailure(err)
  } finally {
    clearTimeout(timer)
  }
}

/** The part of a report that, when it changes, is worth sending at once. */
function stateKey(body: DeviceReportBody): string {
  return [
    body.service,
    body.serviceState,
    body.projects,
    body.bindings,
    body.lastPass?.result ?? '',
    body.lastPass?.errorCode ?? '',
  ].join('|')
}

/**
 * The watch loop's reporter: the first pass, any change of state, and
 * otherwise once every `DEVICE_REPORT_INTERVAL_MS`.
 */
export function createDeviceReporter(
  deps: { send?: SendReport; now?: () => number } = {},
): (body: DeviceReportBody) => Promise<boolean> {
  const send = deps.send ?? sendDeviceReport
  const now = deps.now ?? Date.now
  let lastKey: string | undefined
  let lastSentAt = 0
  return async (body) => {
    const key = stateKey(body)
    const due =
      lastKey === undefined || key !== lastKey || now() - lastSentAt >= DEVICE_REPORT_INTERVAL_MS
    if (!due) return false
    lastKey = key
    lastSentAt = now()
    await reportDeviceSafely(body, send)
    return true
  }
}
