/**
 * `.cryptflare.json` - the committed, per-repository sync manifest.
 *
 * The sync registry (`~/.config/cryptflare-nodejs/sync.json`) is machine-local, so the
 * knowledge of which file maps to which workspace lived only on the machine
 * where it was set up. A fresh clone - a new laptop, or a new teammate - had no
 * way to discover it, and setting up a six-app monorepo meant thirteen commands
 * and remembering six workspace slugs.
 *
 * This manifest is committed alongside the code so the mapping travels with the
 * repository:
 *
 *   git clone …
 *   cf sync init          # reads .cryptflare.json, pulls every file, registers
 *
 * ## It contains no secrets
 *
 * Only names: file paths, workspace slugs, environment slugs, pod slugs. That
 * is why it is safe to commit, and why it must never grow a field that holds a
 * value. The files it points AT hold the secrets and stay gitignored.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Conventional filename at the repository root. */
export const MANIFEST_FILENAME = '.cryptflare.json';

export type ManifestBinding = {
  /** Path to the env-shaped file, relative to the manifest's directory. */
  file: string;
  /** Workspace slug. Falls back to the manifest-level `workspace`. */
  workspace?: string;
  /** Environment slug. Falls back to the manifest-level `environment`. */
  environment?: string;
  /** Optional pod (secret folder) within the environment. */
  pod?: string;
};

export type ProjectManifest = {
  version: 1;
  /** Project id used when registering. Defaults to the directory name. */
  id?: string;
  /** Organisation ID. Falls back to the CLI default. */
  org?: string;
  /** Default workspace for bindings that do not name one. */
  workspace?: string;
  /** Default environment for bindings that do not name one. */
  environment?: string;
  bindings: ManifestBinding[];
};

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

const MANIFEST_VERSION = 1;

export function manifestPath(projectRoot: string): string {
  return join(projectRoot, MANIFEST_FILENAME);
}

export function hasManifest(projectRoot: string): boolean {
  return existsSync(manifestPath(projectRoot));
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManifestError(`${path} must be a non-empty string when present`);
  }
  return value;
}

export function parseManifest(raw: unknown): ProjectManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ManifestError(`${MANIFEST_FILENAME} must contain a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  if (obj['version'] !== MANIFEST_VERSION) {
    throw new ManifestError(
      `unsupported version ${JSON.stringify(obj['version'])}; expected ${MANIFEST_VERSION}`,
    );
  }

  const bindingsRaw = obj['bindings'];
  if (!Array.isArray(bindingsRaw) || bindingsRaw.length === 0) {
    throw new ManifestError('"bindings" must be a non-empty array');
  }

  const defaultWorkspace = optionalString(obj['workspace'], 'workspace');
  const defaultEnvironment = optionalString(obj['environment'], 'environment');

  const bindings = bindingsRaw.map((entry, i) => {
    const at = `bindings[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      throw new ManifestError(`${at} must be an object`);
    }
    const b = entry as Record<string, unknown>;

    const file = optionalString(b['file'], `${at}.file`);
    if (!file) throw new ManifestError(`${at}.file is required`);
    if (isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      // The manifest is committed, so a malicious or careless entry would
      // otherwise let `cf sync init` write outside the repository on every
      // machine that clones it.
      throw new ManifestError(`${at}.file must be a relative path inside the project (got "${file}")`);
    }

    const workspace = optionalString(b['workspace'], `${at}.workspace`) ?? defaultWorkspace;
    if (!workspace) {
      throw new ManifestError(`${at} has no workspace and no top-level "workspace" default is set`);
    }
    const environment = optionalString(b['environment'], `${at}.environment`) ?? defaultEnvironment;
    if (!environment) {
      throw new ManifestError(`${at} has no environment and no top-level "environment" default is set`);
    }

    const pod = optionalString(b['pod'], `${at}.pod`);
    return { file, workspace, environment, ...(pod ? { pod } : {}) };
  });

  const seen = new Set<string>();
  for (const b of bindings) {
    if (seen.has(b.file)) {
      // Two bindings for one file means two environments racing to own the
      // same bytes on every sync pass.
      throw new ManifestError(`"${b.file}" is bound more than once`);
    }
    seen.add(b.file);
  }

  return {
    version: MANIFEST_VERSION,
    ...(optionalString(obj['id'], 'id') ? { id: obj['id'] as string } : {}),
    ...(optionalString(obj['org'], 'org') ? { org: obj['org'] as string } : {}),
    ...(defaultWorkspace ? { workspace: defaultWorkspace } : {}),
    ...(defaultEnvironment ? { environment: defaultEnvironment } : {}),
    bindings,
  };
}

export function loadManifest(projectRoot: string): ProjectManifest {
  const path = manifestPath(projectRoot);
  if (!existsSync(path)) {
    throw new ManifestError(`No ${MANIFEST_FILENAME} in ${projectRoot}. Create one with \`cf sync init --write\`.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new ManifestError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  try {
    return parseManifest(raw);
  } catch (err) {
    throw new ManifestError(`${path}: ${(err as Error).message}`);
  }
}

/**
 * Serialises a manifest for committing. Bindings keep only the fields that
 * differ from the defaults, so a single-workspace project stays terse.
 */
export function renderManifest(manifest: ProjectManifest): string {
  const out: Record<string, unknown> = { version: MANIFEST_VERSION };
  if (manifest.id) out['id'] = manifest.id;
  if (manifest.org) out['org'] = manifest.org;
  if (manifest.workspace) out['workspace'] = manifest.workspace;
  if (manifest.environment) out['environment'] = manifest.environment;

  out['bindings'] = manifest.bindings.map((b) => ({
    file: b.file,
    ...(b.workspace && b.workspace !== manifest.workspace ? { workspace: b.workspace } : {}),
    ...(b.environment && b.environment !== manifest.environment ? { environment: b.environment } : {}),
    ...(b.pod ? { pod: b.pod } : {}),
  }));

  return `${JSON.stringify(out, null, 2)}\n`;
}

export function writeManifest(projectRoot: string, manifest: ProjectManifest): string {
  const path = manifestPath(projectRoot);
  writeFileSync(path, renderManifest(manifest), 'utf-8');
  return path;
}
