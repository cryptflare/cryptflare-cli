import Conf from 'conf';

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
