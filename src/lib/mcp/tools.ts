/**
 * Tools the local MCP server offers an AI agent working in a repository.
 *
 * ## No tool returns a secret value
 *
 * This is the rule everything here is built around. An agent can generate a
 * secret, store one that is sitting in a local file, and bring remote secrets
 * down into `.env` - and at no point does a value enter its context. Results
 * carry key names, versions, counts and a short fingerprint. There is no
 * reveal tool on purpose: the application reads its secrets from the file or
 * from `cf run`, and the agent never needs to.
 *
 * Values that do move (a generated value on its way to the API, a pulled
 * value on its way to the file) move inside this process only.
 */

import { existsSync } from 'node:fs';

import type { CryptFlare } from '@cryptflare/sdk';

import type { CaptureMode } from '../capture.js';
import { DEFAULT_GENERATED_BYTES, fingerprint, generateSecretValue } from '../generate.js';
import { KEY_PATTERN, MAX_KEY_LENGTH } from '../secret-validation.js';
import { upsertAcrossEnvironments } from '../secret-write.js';
import { loadManifestCapture, resolveCapture } from '../sync-capture.js';
import { applyPlan, planBinding, scopeFor, type ApplyResult, type BindingPlan, type SyncAction } from '../sync-engine.js';
import { bindingFilePath, type SyncBinding, type SyncProject, type SyncRegistry } from '../sync-registry.js';
import type { SyncState } from '../sync-state.js';

import type { McpTool } from './protocol.js';
import { resolveLocalProject, selectBinding } from './project.js';

/** Everything a tool touches outside its arguments, injected for tests. */
export type ToolDeps = {
  client: CryptFlare;
  /** Directory the agent is working in. */
  cwd: string;
  loadRegistry: () => SyncRegistry;
  loadState: () => SyncState;
  saveState: (state: SyncState) => void;
};

type Args = Record<string, unknown>;

function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`\`${name}\` must be a non-empty string`);
  return value;
}

function optionalStringList(args: Args, name: string): string[] | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new Error(`\`${name}\` must be a non-empty array of strings`);
  }
  return [...new Set(value as string[])];
}

function requireKey(args: Args): string {
  const key = optionalString(args, 'key');
  if (!key) throw new Error('`key` is required');
  if (key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
    throw new Error(`\`key\` must be UPPER_SNAKE_CASE, for example STRIPE_SECRET_KEY (got "${key}")`);
  }
  return key;
}

function describeScope(project: SyncProject, binding: SyncBinding): string {
  return `${binding.workspace ?? project.workspace}/${binding.environment}`;
}

/** Key names per kind of action. Names only - a plan never carries values out of here. */
function summarisePlan(plan: BindingPlan): Record<string, string[]> {
  const summary: Record<string, string[]> = {};
  for (const action of plan.actions) (summary[action.type] ??= []).push(action.key);
  return summary;
}

function summariseResult(result: ApplyResult) {
  return {
    pulledIntoFile: result.pulled,
    pushed: result.pushed,
    created: result.created,
    failed: result.failed,
    conflicts: result.conflicts,
    ...(result.conflictFile ? { conflictFile: result.conflictFile } : {}),
    skipped: result.skipped.map((action) => ({
      key: action.key,
      why: action.type,
      ...(action.type === 'skip-invalid-local' ? { reason: action.reason } : {}),
    })),
  };
}

/** Runs one binding through plan and apply, persisting the new merge base. */
async function syncBinding(
  deps: ToolDeps,
  project: SyncProject,
  binding: SyncBinding,
  options: { capture: CaptureMode; onlyCreate?: ReadonlySet<string> },
): Promise<ApplyResult> {
  const state = deps.loadState();
  const plan = await planBinding(deps.client, project, binding, state, { capture: options.capture });

  if (options.onlyCreate) {
    const allowed = options.onlyCreate;
    plan.actions = plan.actions.map((action): SyncAction =>
      action.type === 'create' && !allowed.has(action.key) ? { type: 'skip-new-local', key: action.key } : action);
  }

  const result = await applyPlan(deps.client, plan, state, { push: true });
  deps.saveState(state);
  return result;
}

const FILE_PROPERTY = {
  type: 'string',
  description: 'Bound env file, relative to the project root (for example `apps/api/.dev.vars`). Defaults to the bound file nearest the working directory.',
} as const;

/** Builds the tool set for one working directory. */
export function buildTools(deps: ToolDeps): McpTool[] {
  const project = () => resolveLocalProject(deps.cwd, deps.loadRegistry());

  return [
    {
      name: 'project_status',
      description: 'Shows which local env files in this repository are bound to which CryptFlare environment, and what a sync would do: which keys would be pulled, pushed, or are new locally. Returns key names only, never values. Read-only. Call this first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => {
        const current = project();
        const manifestCapture = loadManifestCapture(current);
        const state = deps.loadState();

        const bindings = [];
        for (const binding of current.bindings) {
          const capture = resolveCapture(binding, manifestCapture);
          // reveal:false - a status check must not decrypt anything or spend
          // the reveal budget.
          const plan = await planBinding(deps.client, current, binding, state, { reveal: false, capture });
          bindings.push({
            file: binding.file,
            scope: describeScope(current, binding),
            capture,
            fileExists: existsSync(bindingFilePath(current, binding)),
            pending: summarisePlan(plan),
          });
        }
        return { project: current.id, root: current.path, bindings };
      },
    },
    {
      name: 'secret_generate',
      description: 'Generates a random secret, stores it in CryptFlare, and writes it into the bound local env file. Use for anything nobody needs to read: session secrets, signing keys, webhook secrets, passwords. The value is never returned. If the key exists it is rotated to the new value.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'UPPER_SNAKE_CASE name, for example SESSION_SECRET.' },
          bytes: { type: 'integer', minimum: 16, maximum: 1024, description: `Random bytes. Defaults to ${DEFAULT_GENERATED_BYTES}.` },
          file: FILE_PROPERTY,
          environments: {
            type: 'array',
            items: { type: 'string' },
            description: 'Environment slugs to store the same value in, for example ["dev", "production"]. Defaults to the bound file\'s environment.',
          },
          description: { type: 'string', description: 'What the secret is for.' },
        },
        required: ['key'],
        additionalProperties: false,
      },
      run: async (args) => {
        const key = requireKey(args);
        const bytes = args['bytes'] === undefined ? DEFAULT_GENERATED_BYTES : Number(args['bytes']);
        const description = optionalString(args, 'description');
        const current = project();
        const binding = selectBinding(current, deps.cwd, optionalString(args, 'file'));
        const scope = scopeFor(current, binding);
        if (!scope.organisation) {
          throw new Error('The project names no organisation. Add "org" to .cryptflare.json.');
        }
        const environments = optionalStringList(args, 'environments') ?? [scope.environment];

        const value = generateSecretValue(bytes);
        const stored = await upsertAcrossEnvironments(
          deps.client,
          { organisation: scope.organisation, workspace: scope.workspace, ...(scope.podId ? { podId: scope.podId } : {}) },
          environments,
          key,
          value,
          description ? { description } : {},
        );

        // Bring it down into the file the application reads, so the agent
        // never has to copy it there - which it could not do anyway.
        const wroteLocal = environments.includes(scope.environment)
          && stored.written.some((write) => write.environment === scope.environment);
        const local = wroteLocal
          ? await syncBinding(deps, current, binding, { capture: 'off' })
          : null;

        return {
          key,
          stored: stored.written,
          failed: stored.failed,
          fingerprint: await fingerprint(value),
          localFile: local?.pulled.includes(key) ? binding.file : null,
          note: 'The value was generated and stored without being shown. Read it in code from the environment variable.',
        };
      },
    },
    {
      name: 'secret_capture',
      description: 'Stores secrets that are already in a local env file but not yet in CryptFlare - for example an API key the user just pasted into .env. Reads the value from the file itself, so you never see or pass it. Returns the key names stored. Omit `keys` to capture every new key in the file.',
      inputSchema: {
        type: 'object',
        properties: {
          file: FILE_PROPERTY,
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Only capture these keys. Omit to capture every key in the file that CryptFlare does not have yet.',
          },
        },
        additionalProperties: false,
      },
      run: async (args) => {
        const current = project();
        const binding = selectBinding(current, deps.cwd, optionalString(args, 'file'));
        const keys = optionalStringList(args, 'keys');
        if (!existsSync(bindingFilePath(current, binding))) {
          throw new Error(`${binding.file} does not exist, so there is nothing to capture from it.`);
        }

        // Asking for this tool is the consent `capture: auto` stands for, so
        // it applies whatever mode the binding is configured with.
        const result = await syncBinding(deps, current, binding, {
          capture: 'auto',
          ...(keys ? { onlyCreate: new Set(keys) } : {}),
        });

        const notFound = (keys ?? []).filter((key) =>
          !result.created.includes(key)
          && !result.failed.some((failure) => failure.key === key)
          && !result.skipped.some((skip) => skip.key === key));

        return {
          file: binding.file,
          scope: describeScope(current, binding),
          ...summariseResult(result),
          ...(notFound.length > 0
            ? { notNew: notFound, notNewMeaning: 'These keys are already in CryptFlare, or are not in the file.' }
            : {}),
        };
      },
    },
    {
      name: 'secrets_sync',
      description: 'Syncs the bound env files of this repository with CryptFlare in both directions: pulls new and changed remote secrets into the files, pushes local edits to existing keys, and creates new local keys where the binding allows it. Returns key names only. Use after the user says secrets changed, or to populate .env on a fresh checkout.',
      inputSchema: {
        type: 'object',
        properties: { file: { ...FILE_PROPERTY, description: `${FILE_PROPERTY.description} Omit to sync every bound file.` } },
        additionalProperties: false,
      },
      run: async (args) => {
        const current = project();
        const file = optionalString(args, 'file');
        const bindings = file ? [selectBinding(current, deps.cwd, file)] : current.bindings;
        const manifestCapture = loadManifestCapture(current);

        const results = [];
        for (const binding of bindings) {
          try {
            const result = await syncBinding(deps, current, binding, {
              capture: resolveCapture(binding, manifestCapture),
            });
            results.push({ file: binding.file, scope: describeScope(current, binding), ...summariseResult(result) });
          } catch (err) {
            // One unreachable environment must not hide the result of the others.
            results.push({ file: binding.file, scope: describeScope(current, binding), error: (err as Error).message });
          }
        }
        return { project: current.id, bindings: results };
      },
    },
    {
      name: 'secret_list',
      description: 'Lists the secret key names and versions in the CryptFlare environment a local env file is bound to. Names and versions only, never values. Use to check whether a key already exists before generating or capturing it.',
      inputSchema: {
        type: 'object',
        properties: { file: FILE_PROPERTY },
        additionalProperties: false,
      },
      run: async (args) => {
        const current = project();
        const binding = selectBinding(current, deps.cwd, optionalString(args, 'file'));

        const secrets: Array<{ key: string; version: number }> = [];
        for await (const secret of await deps.client.secrets.list(scopeFor(current, binding))) {
          secrets.push({ key: secret.key, version: secret.version });
        }
        return {
          file: binding.file,
          scope: describeScope(current, binding),
          secrets: secrets.sort((a, b) => a.key.localeCompare(b.key)),
        };
      },
    },
  ];
}

/** Shown to the model when the server initialises. */
export const SERVER_INSTRUCTIONS = [
  'CryptFlare keeps this repository\'s secrets. These tools never return a secret value, and you never need one.',
  'To create a secret nobody has to read (session secret, signing key), call secret_generate.',
  'When the user pastes a real credential into an env file, call secret_capture so it is stored - do not copy the value anywhere yourself.',
  'To fill in .env on a fresh checkout, or after secrets changed, call secrets_sync.',
  'Never print, echo, log or commit a secret value, and never ask the user to paste one into the chat.',
].join(' ');
