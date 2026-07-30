import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

import { getClient } from '../lib/api.js';
import { resolveContext } from '../lib/resolve.js';
import * as output from '../lib/output.js';

type ConflictPolicy = 'skip' | 'overwrite' | 'suffix';

const VALID_KEY = /^[A-Z][A-Z0-9_]*$/;
const VALID_KEY_LOOSE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type ImportItem = {
  key: string;
  value: string;
  description?: string;
  metadata?: Record<string, string>;
  podId?: string | null;
};

type ImportResult = {
  imported: number;
  skipped: number;
  failed: number;
  items: Array<{ key: string; status: 'imported' | 'skipped' | 'failed'; reason?: string }>;
};

const SOURCE_HELP = [
  '  dotenv      .env / .env.local / .env.production (KEY=VALUE format)',
  '  doppler     doppler secrets download --no-file --format json',
  '  1password   1Password .1pux export',
  '  bitwarden   Bitwarden .json (encrypted or unencrypted)',
  '  lastpass    LastPass CSV',
  '  protonpass  Proton Pass JSON / ZIP',
  '  dashlane    Dashlane CSV / ZIP',
  '  keepass     KeePass XML',
].join('\n');

/**
 * Builds the `POST /secrets/import/external` body.
 *
 * Exported so its shape can be tested against `ImportRequestSchema`. The array
 * field is `secrets`; this sent `items`, so every import failed validation
 * with "secrets: Required" *after* reporting a successful parse - the command
 * could never have worked. The request is hand-built rather than routed
 * through the SDK, so neither the contract audit nor the SDK types covered it.
 */
export function buildImportBody(input: {
  source: string;
  conflictPolicy: ConflictPolicy;
  pod?: unknown;
  items: ImportItem[];
}): Record<string, unknown> {
  return {
    source: input.source,
    conflictPolicy: input.conflictPolicy,
    ...(typeof input.pod === 'string' && input.pod !== '' ? { podId: input.pod } : {}),
    secrets: input.items,
  };
}

export const importCommand = new Command('import')
  .description('Import secrets from .env, Doppler, or a password-manager export')
  .option('-s, --source <id>', 'Source format: dotenv, doppler, 1password, bitwarden, lastpass, protonpass, dashlane, keepass')
  .option('-f, --file <path>', 'Path to the export file')
  .option('-w, --workspace <slug>', 'Workspace ID or slug')
  .option('-e, --env <slug>', 'Environment ID or slug')
  .option('-o, --org <id>', 'Organisation ID')
  .option('--pod <id>', 'Place every imported secret in this pod (overrides per-item podId)')
  .option('--conflict <policy>', 'How to resolve key collisions: skip, overwrite, suffix', 'skip')
  .option('--passphrase <pass>', 'Passphrase for encrypted exports (Bitwarden, KeePass, ...)')
  .option('--dry-run', 'Parse the file and print a preview without writing to CryptFlare')
  .option('--json', 'Output results as JSON')
  .addHelpText('after', `\nSupported sources:\n${SOURCE_HELP}\n`)
  .action(async (opts) => {
    try {
      // Validate inputs ---------------------------------------------------
      if (!opts.source) {
        output.warn('Missing --source. Pick one of:');
        console.error(SOURCE_HELP);
        process.exit(1);
      }
      if (!opts.file) {
        output.warn('Missing --file. Path to the export file is required.');
        process.exit(1);
      }
      if (!existsSync(opts.file)) {
        output.warn(`File not found: ${opts.file}`);
        process.exit(1);
      }
      const stat = statSync(opts.file);
      if (stat.size > 10 * 1024 * 1024) {
        output.warn(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Cap is 10 MB.`);
        process.exit(1);
      }
      const conflictPolicy = String(opts.conflict).toLowerCase();
      if (!['skip', 'overwrite', 'suffix'].includes(conflictPolicy)) {
        output.warn('--conflict must be one of: skip, overwrite, suffix');
        process.exit(1);
      }

      const ctx = resolveContext(opts);
      const scope = { organisation: ctx.org, workspace: ctx.workspace, environment: ctx.env };
      const client = getClient();

      const spinner = ora(`Parsing ${opts.file}...`).start();

      const fileBytes = readFileSync(opts.file);

      // Source-specific parsing happens client-side for `dotenv` and
      // `doppler` so the user gets fast feedback before any network
      // call. The pwmgr family keeps the existing browser/UI flow as
      // the canonical path; the CLI submits already-parsed plaintext
      // through the same `/import/external` endpoint.
      let items: ImportItem[];
      try {
        items = await parseSource(opts.source, fileBytes, opts.passphrase as string | undefined);
      } catch (err) {
        spinner.fail(`Parse failed: ${(err as Error).message}`);
        process.exit(1);
      }

      spinner.succeed(`Parsed ${items.length} secret${items.length === 1 ? '' : 's'} from ${opts.source}`);

      if (items.length === 0) {
        output.warn('Nothing to import.');
        return;
      }

      // Apply --pod override at item level so the API does not need a
      // second request to relocate them.
      if (typeof opts.pod === 'string' && opts.pod !== '') {
        for (const item of items) {
          item.podId = opts.pod;
        }
      }

      if (opts.dryRun) {
        renderDryRun(items, opts.json);
        return;
      }

      // Send to API -------------------------------------------------------
      const sendSpinner = ora(`Pushing ${items.length} secret${items.length === 1 ? '' : 's'}...`).start();
      const result = await client.runner.send<{ data: ImportResult }>({
        method: 'POST',
        path: `/v1/organisations/${encodeURIComponent(ctx.org)}/workspaces/${encodeURIComponent(ctx.workspace)}/environments/${encodeURIComponent(ctx.env)}/secrets/import/external`,
        body: buildImportBody({
          source: opts.source,
          conflictPolicy: conflictPolicy as ConflictPolicy,
          pod: opts.pod,
          items,
        }),
      });
      sendSpinner.stop();

      if (opts.json) {
        output.json(result.data);
        return;
      }

      renderResult(result.data, scope.workspace, scope.environment);
    } catch (err) {
      output.handleError(err);
    }
  });

// -- parsing -----------------------------------------------------------

async function parseSource(source: string, bytes: Buffer, passphrase?: string): Promise<ImportItem[]> {
  switch (source) {
    case 'dotenv':
      return parseDotenv(bytes.toString('utf-8'));
    case 'doppler':
      return parseDoppler(bytes.toString('utf-8'));
    default:
      // Pwmgr family - delegate parsing to the in-browser flow by
      // posting raw bytes via the API's multipart endpoint. CLI-side
      // parsing for these formats lives in @cryptflare/shared but is
      // gated behind a runtime toggle until the CLI ships an embedded
      // Web Crypto polyfill story for older Node versions.
      throw new Error(`source "${source}" not yet supported by the CLI - upload via the dashboard`);
  }
}

function parseDotenv(text: string): ImportItem[] {
  const out: ImportItem[] = [];
  // Strip BOM.
  const cleaned = text.replace(/^﻿/, '');
  const lines = readLogicalLines(cleaned);

  for (const raw of lines) {
    const trimmed = stripExportPrefix(raw.trim());
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!VALID_KEY_LOOSE.test(key)) continue;
    const rawValue = trimmed.slice(eqIdx + 1);
    const value = unquoteDotenvValue(rawValue);
    if (value === null) continue;
    if (!VALID_KEY.test(key)) {
      // Server requires UPPER_SNAKE_CASE; uppercase the key locally.
      out.push({ key: key.toUpperCase(), value });
    } else {
      out.push({ key, value });
    }
  }
  return out;
}

function parseDoppler(text: string): ImportItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error('doppler export is not valid JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('doppler export must be an object of KEY -> value');
  }
  const out: ImportItem[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.startsWith('DOPPLER_')) continue;
    if (!VALID_KEY.test(key)) continue;
    let str: string | null = null;
    if (typeof value === 'string') {
      str = value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (typeof obj['computed'] === 'string') str = obj['computed'] as string;
      else if (typeof obj['raw'] === 'string') str = obj['raw'] as string;
    }
    if (str === null) continue;
    out.push({ key, value: str });
  }
  return out;
}

function stripExportPrefix(line: string): string {
  return line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
}

/**
 * Reads logical lines from a dotenv string. Multi-line double-quoted
 * values are coalesced into a single logical line; everything else is
 * one physical line == one logical line.
 */
function readLogicalLines(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDoubleQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inDoubleQuote) {
      if (ch === '\\' && next !== undefined) {
        buf += ch + next;
        i++;
        continue;
      }
      if (ch === '"') inDoubleQuote = false;
      buf += ch;
      continue;
    }
    if (ch === '"') inDoubleQuote = true;
    if (ch === '\n') {
      out.push(buf);
      buf = '';
      continue;
    }
    if (ch === '\r') {
      out.push(buf);
      buf = '';
      if (next === '\n') i++;
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

function unquoteDotenvValue(raw: string): string | null {
  if (raw.length === 0) return '';
  const first = raw[0];
  if (first !== '"' && first !== '\'') {
    const hashIdx = raw.indexOf(' #');
    return (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
  }
  if (first === '\'') {
    if (!raw.endsWith('\'') || raw.length < 2) return null;
    return raw.slice(1, -1);
  }
  // first === '"'
  if (!raw.endsWith('"') || raw.length < 2) return null;
  let out = '';
  for (let j = 1; j < raw.length - 1; j++) {
    const ch = raw[j]!;
    if (ch === '\\' && j + 1 < raw.length - 1) {
      const nxt = raw[j + 1]!;
      switch (nxt) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case '\\': out += '\\'; break;
        case '"': out += '"'; break;
        default: out += nxt; break;
      }
      j++;
      continue;
    }
    out += ch;
  }
  return out;
}

// -- rendering ---------------------------------------------------------

function renderDryRun(items: ImportItem[], asJson?: boolean) {
  if (asJson) {
    output.json({
      preview: items.map((i) => ({ key: i.key, valueLength: i.value.length, podId: i.podId ?? null })),
    });
    return;
  }
  console.log();
  console.log(chalk.bold('  Dry run preview - nothing was sent to CryptFlare'));
  console.log();
  for (const item of items) {
    console.log(`  ${chalk.cyan(item.key.padEnd(40))} ${chalk.dim(`(${item.value.length} bytes)`)}`);
  }
  console.log();
  console.log(chalk.dim(`  ${items.length} secret${items.length === 1 ? '' : 's'} would be imported. Re-run without --dry-run to apply.`));
  console.log();
}

function renderResult(result: ImportResult, workspace: string, environment: string) {
  console.log();
  output.success(`Imported ${chalk.bold(String(result.imported))} secrets into ${chalk.bold(workspace)}/${chalk.bold(environment)}`);
  if (result.skipped > 0) console.log(chalk.dim(`  ${result.skipped} skipped (key already existed)`));
  if (result.failed > 0) {
    console.log(chalk.red(`  ${result.failed} failed`));
    for (const item of result.items) {
      if (item.status === 'failed') {
        console.log(chalk.red(`    - ${item.key}: ${item.reason ?? 'unknown error'}`));
      }
    }
  }
  console.log();
}
