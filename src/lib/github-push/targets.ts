/**
 * Which CryptFlare environment pushes to which GitHub environment.
 *
 * `--env staging` pushes the `staging` environment to the GitHub environment
 * of the same name; `--env prod:production` names it; `--repository-secrets`
 * pushes one environment to the repository's own Actions secrets instead.
 */

/** GitHub caps an environment name at 255 characters and refuses a few. */
const MAX_GITHUB_ENV_LENGTH = 255

export type PushTarget = {
  /** CryptFlare environment slug or id. */
  env: string
  /** GitHub environment name, or null for repository-level secrets. */
  githubEnvironment: string | null
}

/** Commander collector for a repeatable `--env`. */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value]
}

/**
 * Reads the `--env` values into targets. With no `--env`, `fallbackEnv` (the
 * project's bound environment) is pushed to the GitHub environment of the
 * same name.
 *
 * @throws Error on an empty side, a repeated environment, or `--repository-secrets` with more than one.
 */
export function parsePushTargets(
  values: string[],
  fallbackEnv: string | undefined,
  repositorySecrets: boolean,
): PushTarget[] {
  const entries = values.length > 0 ? values : fallbackEnv ? [fallbackEnv] : []
  if (entries.length === 0) {
    throw new Error(
      'Name the environment to push with --env <env>[:<github-environment>], or run this inside a project with a .cryptflare.json.',
    )
  }
  if (repositorySecrets && entries.length > 1) {
    throw new Error('--repository-secrets pushes one environment; pass a single --env.')
  }

  const targets: PushTarget[] = []
  for (const entry of entries) {
    const [env = '', githubEnv, ...rest] = entry.split(':').map((part) => part.trim())
    if (!env || rest.length > 0 || githubEnv === '') {
      throw new Error(`--env "${entry}" is not <env> or <env>:<github-environment>.`)
    }
    const githubEnvironment = repositorySecrets ? null : (githubEnv ?? env)
    if (githubEnvironment !== null && githubEnvironment.length > MAX_GITHUB_ENV_LENGTH) {
      throw new Error(`GitHub environment names are at most ${MAX_GITHUB_ENV_LENGTH} characters.`)
    }
    if (targets.some((target) => target.env === env)) {
      throw new Error(`--env ${env} is given twice.`)
    }
    targets.push({ env, githubEnvironment })
  }
  return targets
}

/** Reads `A,B` into a list, or undefined when nothing is named. */
export function parseKeyList(list: string | undefined): string[] | undefined {
  if (list === undefined) return undefined
  const keys = list
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean)
  return keys.length > 0 ? keys : undefined
}

type ExistingConnection = {
  environmentId: string
  provider: string
  providerConfig: Record<string, unknown>
}

/** True when a GitHub push for this environment, repository and GitHub environment already exists. */
export function alreadyConnected(
  existing: ExistingConnection[],
  environmentId: string,
  repo: { owner: string; name: string },
  githubEnvironment: string | null,
): boolean {
  return existing.some((connection) => {
    const config = connection.providerConfig
    const sameEnvironment = (config['environment'] ?? null) === githubEnvironment
    return (
      connection.provider === 'github' &&
      connection.environmentId === environmentId &&
      String(config['owner'] ?? '').toLowerCase() === repo.owner.toLowerCase() &&
      String(config['repo'] ?? '').toLowerCase() === repo.name.toLowerCase() &&
      sameEnvironment
    )
  })
}
