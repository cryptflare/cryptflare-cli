import Conf from 'conf';

type PermissionCacheEntry = {
  /** First 12 chars of the bearer token; identifies which token the cache
   * belongs to so a different login wipes the entry on access. */
  tokenPrefix: string;
  permissions: string[];
  /** ISO 8601 stamp; refreshed from `auth.whoami` after PERMISSIONS_TTL_MS. */
  fetchedAt: string;
};

type CfConfig = {
  token?: string;
  org?: string;
  defaults?: {
    workspace?: string;
    environment?: string;
  };
  /**
   * `true` enables anonymous CLI telemetry (command name + version + duration
   * + outcome). No tokens, args, or workspace identifiers are ever sent.
   * Default: `undefined` (treated as off until the user opts in).
   */
  telemetry?: boolean;
  /** Permissions cache. Keyed implicitly by tokenPrefix - if the bearer
   * token changes, the entry is treated as a miss and refetched. */
  permissions?: PermissionCacheEntry;
};

const config = new Conf<CfConfig>({
  projectName: 'cryptflare',
  schema: {
    token: { type: 'string' },
    org: { type: 'string' },
    defaults: {
      type: 'object',
      properties: {
        workspace: { type: 'string' },
        environment: { type: 'string' },
      },
    },
    telemetry: { type: 'boolean' },
    permissions: {
      type: 'object',
      properties: {
        tokenPrefix: { type: 'string' },
        permissions: { type: 'array', items: { type: 'string' } },
        fetchedAt: { type: 'string' },
      },
    },
  },
});

export function isTelemetryEnabled(): boolean {
  // DO_NOT_TRACK and CF_TELEMETRY override the saved config.
  if (process.env.DO_NOT_TRACK === '1' || process.env.CF_TELEMETRY === 'off') return false;
  if (process.env.CF_TELEMETRY === 'on') return true;
  return config.get('telemetry') === true;
}

export function setTelemetry(enabled: boolean) {
  config.set('telemetry', enabled);
}

export function getToken(): string | undefined {
  return process.env.CF_TOKEN ?? config.get('token');
}

export function setToken(token: string) {
  config.set('token', token);
}

export function clearToken() {
  config.delete('token');
  // A different identity should never inherit the previous user's
  // cached permissions. Wipe alongside the bearer token.
  config.delete('permissions');
}

export function getCachedPermissions(): PermissionCacheEntry | undefined {
  return config.get('permissions');
}

export function setCachedPermissions(entry: PermissionCacheEntry) {
  config.set('permissions', entry);
}

export function clearCachedPermissions() {
  config.delete('permissions');
}

export function getOrg(): string | undefined {
  return process.env.CF_ORG ?? config.get('org');
}

export function setOrg(org: string) {
  config.set('org', org);
}

export function getDefault(key: 'workspace' | 'environment'): string | undefined {
  const envMap = { workspace: 'CF_WORKSPACE', environment: 'CF_ENVIRONMENT' } as const;
  return process.env[envMap[key]] ?? config.get(`defaults.${key}`);
}

export function setDefault(key: string, value: string) {
  config.set(key, value);
}

export function deleteKey(key: string) {
  config.delete(key as keyof CfConfig);
}

export function getAllConfig(): Record<string, unknown> {
  return config.store;
}

export function getConfigPath(): string {
  return config.path;
}
