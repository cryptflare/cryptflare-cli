/**
 * The repository side of `cf github connect`, through the GitHub CLI.
 *
 * Every call runs `gh` itself, so gh signs in the way it already does
 * (`gh auth login`, keyring or `GH_TOKEN`) and its token never passes
 * through this process or reaches CryptFlare. `gh` is only used while
 * setting up: finding the repository, checking you administer it, and
 * listing or creating its GitHub environments. The pushes afterwards run
 * through the CryptFlare GitHub App.
 */

import spawn from 'cross-spawn'

const GH_TIMEOUT_MS = 30_000

export type GhResult = { ok: true; stdout: string } | { ok: false; message: string }

/** Runs `gh` with arguments (never a shell) and returns stdout, or why it failed. */
export type GhRunner = (args: string[]) => GhResult

export const runGh: GhRunner = (args) => {
  const result = spawn.sync('gh', args, {
    encoding: 'utf8',
    timeout: GH_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    const missing = 'code' in result.error && result.error.code === 'ENOENT'
    return {
      ok: false,
      message: missing
        ? 'The GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.'
        : result.error.message,
    }
  }
  if (result.status !== 0) {
    const firstLine =
      String(result.stderr ?? '')
        .trim()
        .split('\n')[0] ?? ''
    return { ok: false, message: firstLine || `gh exited with status ${result.status}` }
  }
  return { ok: true, stdout: String(result.stdout ?? '') }
}

export type GitHubRepo = {
  owner: string
  name: string
  /** True when the signed-in gh user can administer it, which managing environments needs. */
  admin: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `owner/name` into its parts. */
export function splitRepo(slug: string): { owner: string; name: string } {
  const [owner = '', name = '', ...rest] = slug.trim().split('/')
  if (!owner || !name || rest.length > 0) {
    throw new Error(`--repo must be owner/name, for example acme/api (got "${slug}").`)
  }
  return { owner, name }
}

/**
 * The repository named, or the one the current directory's git remote
 * points at when none is named.
 */
export function viewRepo(repo: string | undefined, gh: GhRunner = runGh): GitHubRepo {
  const args = ['repo', 'view', ...(repo ? [repo] : []), '--json', 'nameWithOwner,viewerPermission']
  const result = gh(args)
  if (!result.ok) {
    throw new Error(
      repo
        ? `gh could not read ${repo}: ${result.message}`
        : `gh could not find a GitHub repository here: ${result.message}. Pass --repo owner/name.`,
    )
  }
  const body = parseJson(result.stdout)
  const slug =
    isRecord(body) && typeof body['nameWithOwner'] === 'string' ? body['nameWithOwner'] : ''
  const { owner, name } = splitRepo(slug)
  return { owner, name, admin: isRecord(body) && body['viewerPermission'] === 'ADMIN' }
}

/** Names of the repository's GitHub environments. */
export function listEnvironments(repo: GitHubRepo, gh: GhRunner = runGh): string[] {
  const result = gh([
    'api',
    `repos/${repo.owner}/${repo.name}/environments?per_page=100`,
    '--jq',
    '.environments[].name',
  ])
  if (!result.ok) throw new Error(`gh could not list the environments: ${result.message}`)
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Creates a GitHub environment with no protection rules. Needs admin on the repository. */
export function createEnvironment(repo: GitHubRepo, name: string, gh: GhRunner = runGh): void {
  const result = gh([
    'api',
    '--method',
    'PUT',
    `repos/${repo.owner}/${repo.name}/environments/${encodeURIComponent(name)}`,
    '--silent',
  ])
  if (!result.ok) throw new Error(`gh could not create the environment ${name}: ${result.message}`)
}
