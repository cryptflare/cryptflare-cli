/**
 * The CLI's copy of the encrypted local env file contract.
 *
 * The source of truth is `@cryptflare/shared/constants/local-env-files`. The
 * published CLI is built in a public mirror that has only `constants/brand`
 * from that package (`mirror-imports.test.ts`), so the values are repeated
 * here and `contract.test.ts` fails in this monorepo the moment they drift.
 */

export const LOCAL_ENV_FILE = {
  VALUE_PREFIX: 'cf:v1:',
  FORMAT: 'cf:v1',
  HKDF_INFO_PREFIX: 'cryptflare-local-env-file-v1:',
  KEY_ID_LABEL: 'cryptflare-local-env-file-key-id',
  KEY_ID_BYTES: 6,
  KEY_BYTES: 32,
  NONCE_BYTES: 12,
  ALGORITHM: 'A256GCM',
  MAX_KEY_VERSION: 1000,
  KEY_MEMORY_TTL_MS: 60 * 60 * 1000,
} as const

export const BROWSER_PUBLIC_PREFIXES = [
  'NEXT_PUBLIC_',
  'NUXT_PUBLIC_',
  'VITE_',
  'PUBLIC_',
  'REACT_APP_',
  'EXPO_PUBLIC_',
  'GATSBY_',
] as const
