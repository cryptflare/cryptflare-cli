import { GITHUB_PERMISSION_LEVELS } from '@/lib/github-app/contract'
import type { GitHubPermissions } from '@/lib/github-app/manifest'

/** Unknown levels rank below `read`, so they never count as enough. */
function rank(level: string | undefined): number {
  return level === undefined ? -1 : (GITHUB_PERMISSION_LEVELS as readonly string[]).indexOf(level)
}

/**
 * Permissions the leases need that the installation does not hold at that
 * level, as `name:level`. An installation holds what its owner approved,
 * which lags the App's settings until the owner accepts a change.
 */
export function missingInstallationPermissions(
  wanted: GitHubPermissions,
  granted: Record<string, string>,
): string[] {
  return Object.entries(wanted)
    .filter(([name, level]) => rank(granted[name]) < rank(level))
    .map(([name, level]) => `${name}:${level}`)
}
