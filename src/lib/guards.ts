/**
 * Narrowing helpers for values the CLI does not control: caught errors,
 * parsed JSON from disk or the network. They replace structural `as`
 * casts, so a missing field reads as `undefined` instead of being assumed.
 */

/** True for a non-null, non-array object, safe to read with string keys. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Message of a caught value, whether or not it is an `Error`. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** HTTP status carried by a caught error (SDK `APIError` or a fetch-style error), if any. */
export function errorStatus(err: unknown): number | undefined {
  const status = isRecord(err) || err instanceof Error ? Reflect.get(err, 'status') : undefined
  return typeof status === 'number' ? status : undefined
}

/** String `code` carried by a caught error (SDK error code or Node `errno` code), if any. */
export function errorCode(err: unknown): string | undefined {
  const code = isRecord(err) || err instanceof Error ? Reflect.get(err, 'code') : undefined
  return typeof code === 'string' ? code : undefined
}

/** Reads a nested property path from an untrusted value; `undefined` when any level is missing. */
export function readPath(root: unknown, ...keys: string[]): unknown {
  let current: unknown = root
  for (const key of keys) {
    if (!isRecord(current) && !(current instanceof Error)) return undefined
    current = Reflect.get(current, key)
  }
  return current
}

/** Reads a string at a nested path, or `undefined` when absent or not a string. */
export function readString(root: unknown, ...keys: string[]): string | undefined {
  const value = readPath(root, ...keys)
  return typeof value === 'string' ? value : undefined
}

/** Reads a number at a nested path, or `undefined` when absent or not a number. */
export function readNumber(root: unknown, ...keys: string[]): number | undefined {
  const value = readPath(root, ...keys)
  return typeof value === 'number' ? value : undefined
}

/** True for an array whose every element is a string. */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Type guard: `value` is one of `values`. Replaces `(LIST as readonly string[]).includes(x)`. */
export function isOneOf<T extends string | number>(
  values: readonly T[],
  value: unknown,
): value is T {
  return values.some((candidate) => candidate === value)
}
