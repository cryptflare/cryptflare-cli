/**
 * Registry of local projects the sync service keeps in step with CryptFlare.
 *
 * Lives beside the existing CLI config (`sync.json` next to `config.json`) so
 * one directory holds everything `cf` owns and `cf doctor` has one place to
 * look. Plain JSON rather than TOML: the CLI ships four runtime dependencies
 * today and a config-file format is not worth a fifth.
 *
 * Hand-editing is expected and supported - {@link loadRegistry} validates
 * structurally and reports the offending path instead of throwing a bare
 * JSON parse error at 3am on a machine you are not sitting in front of.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';

import { getConfigPath } from './config.js';

/** One `.env`-shaped file bound to one remote environment, optionally scoped to a pod. */
export type SyncBinding = {
  /** Path to the env file, relative to the project root (e.g. `.env.local`). */
  file: string;
  /** Environment slug in the bound workspace. */
  environment: string;
  /**
   * Pod (secret folder) within the environment. Omitted means the root pod.
   *
   * Required for monorepos: several apps commonly define the same key with
   * different values (`VITE_SENTRY_DSN`, `VITE_ENVIRONMENT`), so binding each
   * app's file to the same environment root would have them silently overwrite
   * one another. A pod per app keeps them separate without inventing an
   * environment per app.
   */
  pod?: string;
  /**
   * Workspace slug for this binding, overriding the project's.
   *
   * A monorepo commonly maps one app per workspace - which is the layout that
   * keeps each app's secrets in a separate access boundary, since tokens are
   * scoped per workspace. Without this, every app in one repository would need
   * its own registered project pointing at the same directory.
   */
  workspace?: string;
};

export type SyncProject = {
  /** Stable identifier used in log lines, state keys, and `cf sync remove`. */
  id: string;
  /** Absolute path to the project root. */
  path: string;
  /** Organisation ID. Falls back to the CLI default when omitted. */
  org?: string;
  /**
   * Default workspace for bindings that do not name their own. Optional only
   * when every binding carries a `workspace`; validation enforces that, so a
   * binding can never end up with no workspace at all.
   */
  workspace?: string;
  /** `false` parks the project without deleting its config. */
  enabled: boolean;
  bindings: SyncBinding[];
};

export type SyncRegistry = {
  version: 1;
  projects: SyncProject[];
};

const REGISTRY_VERSION = 1;

export function getRegistryPath(): string {
  return join(dirname(getConfigPath()), 'sync.json');
}

export function emptyRegistry(): SyncRegistry {
  return { version: REGISTRY_VERSION, projects: [] };
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

function assertString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RegistryError(`${path} must be a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

function parseBinding(raw: unknown, path: string): SyncBinding {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegistryError(`${path} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const file = assertString(obj['file'], `${path}.file`);
  if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    // Bindings resolve against the project root. Allowing `..` or an absolute
    // path would let a registry entry write anywhere on the filesystem, which
    // is a needlessly large blast radius for a background service.
    throw new RegistryError(`${path}.file must be a relative path inside the project (got "${file}")`);
  }
  const pod = obj['pod'];
  if (pod !== undefined && (typeof pod !== 'string' || pod.trim() === '')) {
    throw new RegistryError(`${path}.pod must be a non-empty string when present`);
  }
  const workspace = obj['workspace'];
  if (workspace !== undefined && (typeof workspace !== 'string' || workspace.trim() === '')) {
    throw new RegistryError(`${path}.workspace must be a non-empty string when present`);
  }
  return {
    file,
    environment: assertString(obj['environment'], `${path}.environment`),
    ...(typeof pod === 'string' ? { pod } : {}),
    ...(typeof workspace === 'string' ? { workspace } : {}),
  };
}

function parseProject(raw: unknown, path: string): SyncProject {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegistryError(`${path} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const bindingsRaw = obj['bindings'];
  if (!Array.isArray(bindingsRaw) || bindingsRaw.length === 0) {
    throw new RegistryError(`${path}.bindings must be a non-empty array`);
  }
  const org = obj['org'];
  if (org !== undefined && typeof org !== 'string') {
    throw new RegistryError(`${path}.org must be a string when present`);
  }

  const bindings = bindingsRaw.map((b, i) => parseBinding(b, `${path}.bindings[${i}]`));

  // The project-level workspace is a default, so it may be omitted - but only
  // if every binding supplies its own. Checked here rather than at sync time so
  // a registry that cannot resolve a workspace fails on load, naming the
  // binding, instead of mid-pass against a live API.
  const workspace = obj['workspace'];
  if (workspace !== undefined && (typeof workspace !== 'string' || workspace.trim() === '')) {
    throw new RegistryError(`${path}.workspace must be a non-empty string when present`);
  }
  if (workspace === undefined) {
    const orphan = bindings.findIndex((b) => !b.workspace);
    if (orphan !== -1) {
      throw new RegistryError(
        `${path}.bindings[${orphan}] has no workspace and ${path} sets no default. ` +
          `Add a workspace to the binding, or a project-level "workspace".`,
      );
    }
  }

  return {
    id: assertString(obj['id'], `${path}.id`),
    path: resolve(assertString(obj['path'], `${path}.path`)),
    ...(typeof org === 'string' ? { org } : {}),
    ...(typeof workspace === 'string' ? { workspace } : {}),
    enabled: obj['enabled'] !== false,
    bindings,
  };
}

export function parseRegistry(raw: unknown): SyncRegistry {
  if (typeof raw !== 'object' || raw === null) {
    throw new RegistryError('registry root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj['version'] !== REGISTRY_VERSION) {
    throw new RegistryError(`unsupported registry version ${String(obj['version'])}; expected ${REGISTRY_VERSION}`);
  }
  const projectsRaw = obj['projects'];
  if (!Array.isArray(projectsRaw)) {
    throw new RegistryError('registry.projects must be an array');
  }
  const projects = projectsRaw.map((p, i) => parseProject(p, `projects[${i}]`));

  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.id)) {
      throw new RegistryError(`duplicate project id "${project.id}"`);
    }
    seen.add(project.id);

    const files = new Set<string>();
    for (const binding of project.bindings) {
      if (files.has(binding.file)) {
        // Two bindings for one file means two environments racing to own the
        // same bytes. Reject at load rather than let the daemon flap.
        throw new RegistryError(`project "${project.id}" binds ${binding.file} more than once`);
      }
      files.add(binding.file);
    }
  }

  return { version: REGISTRY_VERSION, projects };
}

export function loadRegistry(path = getRegistryPath()): SyncRegistry {
  if (!existsSync(path)) return emptyRegistry();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new RegistryError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseRegistry(raw);
  } catch (err) {
    throw new RegistryError(`${path}: ${(err as Error).message}`);
  }
}

export function saveRegistry(registry: SyncRegistry, path = getRegistryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(registry, null, 2)}\n`;
  const tmp = `${path}.tmp-${process.pid}`;
  // 0600: the registry names workspaces and environments. Not secret material,
  // but it maps this machine's directories to vault scopes - no reason for it
  // to be world-readable.
  writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Absolute path of a binding's env file. */
export function bindingFilePath(project: SyncProject, binding: SyncBinding): string {
  return join(project.path, binding.file);
}

/** Stable key for state lookups and log prefixes. */
export function bindingKey(project: SyncProject, binding: SyncBinding): string {
  return `${project.id}::${binding.file}`;
}
