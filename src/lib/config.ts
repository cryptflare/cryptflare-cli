import { chmodSync, existsSync, statSync } from 'node:fs';

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
  // This file holds the bearer token. `conf` defaults to 0o666 before umask,
  // which on a typical 0o022 umask lands at 0o644 - readable by every other
  // user on the machine. `~/.config` being "typically protected", as conf's own
  // docs put it, is not a property to rely on for a credential.
  configFileMode: 0o600,
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

/**
 * Tightens permissions on an existing config file.
 *
 * `configFileMode` only applies when conf creates the file, so anyone who
 * authenticated before that option was set still has a 0644 file containing
 * their token. Repair it on load rather than leaving the fix to a re-login
 * nobody will think to do.
 *
 * Best-effort: a failure here must never stop the CLI working. chmod is a
 * no-op on Windows, so it is skipped there.
 */
function ensureConfigFileIsPrivate(): void {
  if (process.platform === 'win32') return;
  try {
    const path = config.path;
    if (!existsSync(path)) return;
    const mode = statSync(path).mode & 0o777;
    if (mode !== 0o600) chmodSync(path, 0o600);
  } catch {
    // Unreadable, on a filesystem without permissions, or owned by someone
    // else - none of which should prevent the command the user actually ran.
  }
}

ensureConfigFileIsPrivate();

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
