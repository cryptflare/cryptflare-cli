/** Shared constants and option parsing for the `cf sync` subcommands. */

import { CAPTURE_MODES, isCaptureMode, type CaptureMode } from '@/lib/capture'
import { getRegistryPath, loadRegistry, type SyncProject } from '@/lib/sync-registry'
import { EXIT_CODES } from '@/lib/exit-codes'
import { SYSTEMD_SERVICE_NAME } from '@/lib/service/spec'

export const DEFAULT_INTERVAL_S = 60
export const MIN_INTERVAL_S = 15
export const BACKOFF_CEILING_MS = 600_000
export const BACKOFF_MULTIPLIER = 2
export const NO_CHANGE_GRACE = 5
const JITTER_PCT = 0.1
export const SERVICE_NAME = SYSTEMD_SERVICE_NAME
/** Consecutive passes in which every binding was refused as unauthenticated before the loop gives up. */
export const AUTH_FAILURE_LIMIT = 3
/** sysexits EX_CONFIG. The unit lists it under RestartPreventExitStatus. */
export const EXIT_NEEDS_LOGIN = EXIT_CODES.NEEDS_LOGIN
/** How often the watch loop looks for repositories to set up under the auto roots. */
export const ONBOARD_INTERVAL_MS = 600_000
/** How long a repository that failed to set up is left alone before another try. */
export const ONBOARD_RETRY_MS = 3_600_000
/**
 * The least time between two looks for new env files in registered
 * repositories, when nothing on disk said to look. A file event skips it.
 */
export const REDISCOVER_MIN_INTERVAL_MS = 30_000

export function jittered(ms: number): number {
  return Math.max(5_000, Math.round(ms + ms * JITTER_PCT * (Math.random() * 2 - 1)))
}

export function parseCaptureOption(value: unknown): CaptureMode | undefined {
  if (value === undefined) return undefined
  if (!isCaptureMode(value)) {
    throw new Error(`--capture must be one of ${CAPTURE_MODES.join(', ')} (got "${String(value)}")`)
  }
  return value
}

export function selectProjects(projectId?: string): SyncProject[] {
  const registry = loadRegistry()
  const enabled = registry.projects.filter((p) => p.enabled)
  if (!projectId) return enabled
  const match = registry.projects.find((p) => p.id === projectId)
  if (!match) {
    throw new Error(`No project "${projectId}" in ${getRegistryPath()}. Run \`cf sync list\`.`)
  }
  return [match]
}
