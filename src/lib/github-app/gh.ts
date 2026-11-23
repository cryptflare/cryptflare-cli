/**
 * Optional help from the GitHub CLI (`gh`).
 *
 * When `gh` is installed and signed in, `cf dynamic github connect` uses it
 * to list the organisations the person belongs to, so `--github-org` can be
 * left out. Nothing else is read through it, and no `gh` token is sent
 * anywhere: the App is created and read with its own credentials.
 */

import spawn from 'cross-spawn'

const GH_TIMEOUT_MS = 15_000

/**
 * Logins of the organisations the signed-in `gh` user belongs to, or null
 * when `gh` is missing, signed out or cannot read them.
 */
export function listGhOrganisations(): string[] | null {
  const result = spawn.sync('gh', ['api', 'user/orgs', '--paginate', '--jq', '.[].login'], {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
