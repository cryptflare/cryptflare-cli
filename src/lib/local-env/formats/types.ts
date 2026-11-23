/**
 * The contract every local-secrets file format implements.
 *
 * A format parses a file into entries that carry the exact character span of
 * each value, so a rewrite replaces those spans and nothing else: comments,
 * blank lines, ordering, indentation and line endings survive byte for byte.
 * Adding a format is one module that exports a {@link FileFormat} plus a line
 * in `./index.ts`.
 */

/** How the running program gets this file's values. */
export type InjectionMode =
  /** The program reads its environment; `cf run` injects the decrypted values. */
  | 'env'
  /** The program reads the file itself; `cf run --materialize` writes plaintext for its lifetime. */
  | 'materialize'
  /** Nothing to inject (registry auth files reference `${VAR}` instead). */
  | 'none'

/**
 * What is encrypted by default.
 *
 * - `env`: every value (env files hold nothing but configuration and secrets).
 * - `structured`: values whose key or content looks secret; the rest is config.
 * - `whole-file`: the file is one value.
 * - `registry`: never encrypted; tokens move to CryptFlare behind `${VAR}`.
 */
export type FormatStyle = 'env' | 'structured' | 'whole-file' | 'registry'

export type FormatId =
  | 'dotenv'
  | 'dev-vars'
  | 'envrc'
  | 'compose-env'
  | 'toml'
  | 'json'
  | 'tfvars'
  | 'rails-master-key'
  | 'registry-auth'

/** Quoting of a value as written, kept when the value is replaced. */
export type QuoteStyle = 'none' | 'single' | 'double' | 'backtick'

/** One value in a file. */
export type FileEntry = {
  /** Variable name, or dotted key path for structured formats. */
  name: string
  /** Decoded value (quotes removed, escapes resolved). */
  value: string
  /** Start offset of the raw value token, quotes included. */
  start: number
  /** End offset (exclusive) of the raw value token. */
  end: number
  quote: QuoteStyle
  /** 1-based line number, for messages. */
  line: number
}

/** A value the format recognised but will not rewrite. */
export type UnmanagedEntry = { name: string; line: number; reason: string }

export type ParsedFile = {
  entries: FileEntry[]
  unmanaged: UnmanagedEntry[]
}

export type FileFormat = {
  id: FormatId
  /** One line for `cf env status` and the migration plan. */
  label: string
  injection: InjectionMode
  style: FormatStyle
  /** Whether a path (relative, forward slashes) is this format. */
  matches(path: string): boolean
  parse(content: string): ParsedFile
  /** Renders `value` as the raw token to put in place of `entry`'s span. */
  render(value: string, entry: FileEntry): string
  /** Environment variable / CryptFlare key name for an entry. */
  envName(entry: FileEntry): string
}
