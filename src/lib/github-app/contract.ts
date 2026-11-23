/**
 * The CLI's copy of the `github_app` dynamic provider contract.
 *
 * The source of truth is `@cryptflare/shared` (`constants/dynamic-github`,
 * `constants/dynamic-secrets`). The published CLI is built in a public
 * mirror that has only `constants/brand` from that package
 * (`mirror-imports.test.ts`), so the values the CLI needs are repeated here.
 * `contract.test.ts` fails in this monorepo the moment the two drift.
 */

export const GITHUB_APP_DYNAMIC = {
  API_URL: 'https://api.github.com',
  WEB_URL: 'https://github.com',
  API_VERSION: '2022-11-28',
  MAX_TTL_SECONDS: 60 * 60,
  DEFAULT_PERMISSIONS: { contents: 'read' },
  MAX_REPOSITORIES: 500,
} as const

export const GITHUB_PERMISSION_LEVELS = ['read', 'write', 'admin'] as const

export type GitHubPermissionLevel = (typeof GITHUB_PERMISSION_LEVELS)[number]

export const GITHUB_PERMISSION_NAME_PATTERN = /^[a-z][a-z_]{1,63}$/

export const DYNAMIC_MIN_TTL_SECONDS = 60
export const DYNAMIC_DEFAULT_TTL_SECONDS = 30 * 60
export const DYNAMIC_DEFAULT_MAX_CONCURRENT_LEASES = 50
export const DYNAMIC_DEFAULT_MAX_LEASES_PER_IDENTITY = 5

/** The provider key the API stores the config under. */
export const GITHUB_APP_PROVIDER = 'github_app'
