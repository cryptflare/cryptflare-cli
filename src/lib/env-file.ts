/**
 * Structure-preserving `.env` reader / writer.
 *
 * The pre-existing `formatEnvFile` in `commands/sync.ts` regenerates the whole
 * file from a key/value map, which throws away comments, blank-line grouping,
 * key ordering, and any line the CLI does not understand. That is acceptable
 * for a one-shot `cf pull` into a fresh file; it is not acceptable for a
 * long-running service that rewrites a developer's working `.env` every few
 * minutes. This module edits in place instead: only the lines whose values
 * actually changed are rewritten, and unknown lines are passed through byte
 * for byte.
 *
 * Deliberate limitation: multi-line quoted values (a value whose opening quote
 * has no closing quote on the same line) are parsed as `multiline` and marked
 * unmanaged. Rewriting them safely means tracking a line span and re-escaping,
 * and getting that subtly wrong corrupts a secret. Flagging and skipping is
 * the honest behaviour - the caller warns and leaves the key alone.
 */

/** One `KEY=value` assignment located in the file. */
export type EnvEntry = {
  key: string;
  value: string;
  /** Index into `ParsedEnvFile.lines` where this assignment lives. */
  lineIndex: number;
  /** `export ` prefix, if the line used one. Preserved on rewrite. */
  exported: boolean;
  /** Leading whitespace on the line. Preserved on rewrite. */
  indent: string;
  /** Trailing ` # comment` on an unquoted value. Preserved on rewrite. */
  trailingComment: string;
  /**
   * `true` when the value opened a quote that never closed on the same line.
   * Such keys are excluded from sync - see the module comment.
   */
  multiline: boolean;
};

export type ParsedEnvFile = {
  /** Raw file split on `\n`, no trailing-newline normalisation. */
  lines: string[];
  /** Last assignment wins, matching dotenv/shell semantics. */
  entries: Map<string, EnvEntry>;
  /** `true` when the source content ended with a newline. */
  trailingNewline: boolean;
};

const ASSIGNMENT_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/;

/** Header for the block where keys new to this file get appended. */
export const MANAGED_BLOCK_HEADER = '# --- managed by CryptFlare (cf sync) ---';

/**
 * Splits a raw right-hand side into its value plus any preserved trailing
 * comment, and reports whether the quoting ran off the end of the line.
 */
function readValue(rhs: string): { value: string; trailingComment: string; multiline: boolean } {
  const trimmed = rhs.trim();

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]!;
    // Walk the rest looking for the closing quote, honouring backslash escapes
    // inside double quotes only (single quotes are literal in shell/dotenv).
    let i = 1;
    let out = '';
    while (i < trimmed.length) {
      const ch = trimmed[i]!;
      if (quote === '"' && ch === '\\' && i + 1 < trimmed.length) {
        const next = trimmed[i + 1]!;
        out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        return { value: out, trailingComment: trimmed.slice(i + 1).trimEnd(), multiline: false };
      }
      out += ch;
      i++;
    }
    return { value: out, trailingComment: '', multiline: true };
  }

  // Unquoted: a `#` only begins a comment when it follows whitespace, so
  // `PASSWORD=abc#123` keeps the hash as part of the value.
  const hashIdx = trimmed.search(/\s#/);
  if (hashIdx !== -1) {
    return {
      value: trimmed.slice(0, hashIdx).trimEnd(),
      trailingComment: trimmed.slice(hashIdx).trim(),
      multiline: false,
    };
  }
  return { value: trimmed, trailingComment: '', multiline: false };
}

export function parseEnvContent(content: string): ParsedEnvFile {
  const trailingNewline = content.endsWith('\n');
  const lines = (trailingNewline ? content.slice(0, -1) : content).split('\n');
  const entries = new Map<string, EnvEntry>();

  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const match = ASSIGNMENT_RE.exec(line);
    if (!match) return;

    const [, indent = '', exportPrefix, key = '', rhs = ''] = match;
    const { value, trailingComment, multiline } = readValue(rhs);

    entries.set(key, {
      key,
      value,
      lineIndex,
      exported: Boolean(exportPrefix),
      indent,
      trailingComment,
      multiline,
    });
  });

  return { lines, entries, trailingNewline };
}

/**
 * Renders a value so that reading the file back - with this parser, with
 * dotenv, or by sourcing it in a shell - yields the original bytes.
 *
 * Single quotes are preferred because they are literal everywhere. Double
 * quotes are not: a shell expands `$VAR` and runs `` `cmd` `` inside them, so
 * writing `SECRET="it's $HOME `id`"` (which this did) both corrupted the value
 * and executed the secret's contents on `set -a; . .env`. A secret is attacker
 * -influenced data in the general case, which makes that a command injection,
 * not just a quoting bug.
 *
 * Double quotes are used only when the value contains a single quote or a
 * newline, neither of which a single-quoted form can represent - the shell has
 * no escape inside single quotes, and dotenv does not accept the `'\''`
 * concatenation trick. There `$`, backtick, `"` and `\` are escaped, which
 * this parser and a shell both undo.
 */
function renderValue(value: string): string {
  if (value === '') return "''";

  if (value.includes("'") || value.includes('\n')) {
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/`/g, '\\`')
      .replace(/\n/g, '\\n');
    return `"${escaped}"`;
  }

  if (/[\s#"=$`\\]/.test(value)) return `'${value}'`;
  return value;
}

function renderLine(entry: Pick<EnvEntry, 'indent' | 'exported' | 'key' | 'trailingComment'>, value: string): string {
  const prefix = `${entry.indent}${entry.exported ? 'export ' : ''}`;
  const comment = entry.trailingComment ? ` ${entry.trailingComment}` : '';
  return `${prefix}${entry.key}=${renderValue(value)}${comment}`;
}

/**
 * Applies value updates and key additions to `content`, preserving every line
 * the change set does not touch.
 *
 * - `updates` rewrites in place at the original line. Keys marked `multiline`
 *   are ignored and returned in `skippedMultiline` so the caller can warn.
 * - `additions` are appended under {@link MANAGED_BLOCK_HEADER}, reusing the
 *   block if one already exists so repeated syncs do not stack headers.
 * - Deletion is intentionally not supported. Removing a developer's local line
 *   because a key vanished server-side is a data-loss shape the sync engine
 *   refuses to take unattended.
 */
export function applyEnvChanges(
  content: string,
  updates: Map<string, string>,
  additions: Map<string, string> = new Map(),
): { content: string; skippedMultiline: string[] } {
  const parsed = parseEnvContent(content);
  const lines = [...parsed.lines];
  const skippedMultiline: string[] = [];

  for (const [key, value] of updates) {
    const entry = parsed.entries.get(key);
    if (!entry) continue;
    if (entry.multiline) {
      skippedMultiline.push(key);
      continue;
    }
    if (entry.value === value) continue;
    lines[entry.lineIndex] = renderLine(entry, value);
  }

  const newKeys = [...additions.entries()].filter(([key]) => !parsed.entries.has(key));
  if (newKeys.length > 0) {
    let blockIdx = lines.findIndex((l) => l.trim() === MANAGED_BLOCK_HEADER);
    if (blockIdx === -1) {
      if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') lines.push('');
      lines.push(MANAGED_BLOCK_HEADER);
      blockIdx = lines.length - 1;
    }
    // Insert directly after the header so the block stays contiguous even when
    // the file has content below it.
    const rendered = newKeys
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => renderLine({ indent: '', exported: false, key, trailingComment: '' }, value));
    lines.splice(blockIdx + 1, 0, ...rendered);
  }

  const body = lines.join('\n');
  return { content: parsed.trailingNewline || body === '' ? `${body}\n` : body, skippedMultiline };
}

/**
 * Renders a complete `.env` from scratch. Used only when the target file does
 * not exist yet - once it exists, {@link applyEnvChanges} takes over.
 */
export function renderEnvFile(secrets: Map<string, string>, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(header, '');
  for (const [key, value] of [...secrets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${key}=${renderValue(value)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Flat key/value view, dropping multi-line entries the writer cannot manage. */
export function toValueMap(parsed: ParsedEnvFile): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, entry] of parsed.entries) {
    if (entry.multiline) continue;
    map.set(key, entry.value);
  }
  return map;
}
