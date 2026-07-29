/**
 * Parsing for timestamps returned by the API.
 *
 * The API emits two shapes for the same instant, and only one of them is
 * unambiguous:
 *
 *   rotate/update paths   `2026-07-29T02:51:23.000Z`   ISO-8601, UTC explicit
 *   DB column defaults    `2026-07-29 02:51:23`        SQLite `datetime('now')`
 *
 * The second has no `T` and no zone designator. Per ECMA-262 that is not a
 * valid ISO-8601 date-time string, so `new Date()` falls back to
 * implementation-defined parsing and treats it as **local time**. The value is
 * actually UTC, so every reader outside UTC is wrong by exactly their own
 * offset - which is why `cf secret list` reported a secret created seconds
 * earlier as "10h ago" from UTC+10, while a rotated one read "just now".
 *
 * 67 columns in the schema carry that default, so this is not one bad query.
 * Fixing it at the source means rewriting those defaults to emit
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now')`, and SQLite cannot alter a column
 * default in place - each table would have to be rebuilt. That is a large,
 * risky migration and it would still leave every existing row ambiguous.
 * Normalising on read fixes all of it, including historical rows.
 */

/** Matches `YYYY-MM-DD HH:MM:SS[.sss]` with no `T` and no zone designator. */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * Parses an API timestamp into a `Date`, treating zone-less SQLite datetimes
 * as UTC rather than local time.
 *
 * Returns an invalid `Date` for unparseable input, matching `new Date()` so
 * callers can keep using `Number.isNaN(d.getTime())`.
 */
export function parseApiTimestamp(value: string): Date {
  if (SQLITE_DATETIME.test(value)) {
    // Reformat rather than append 'Z': `2026-07-29 02:51:23Z` is still not
    // valid ISO-8601 and stays implementation-defined.
    return new Date(`${value.replace(' ', 'T')}Z`);
  }
  return new Date(value);
}

/**
 * Human-readable "time since" for an API timestamp.
 *
 * Clamps negative deltas to "just now": a row written a fraction of a second
 * ago can carry a timestamp marginally ahead of the local clock, and "-1m ago"
 * reads like a bug.
 */
export function timeAgo(value: string): string {
  const parsed = parseApiTimestamp(value);
  const ms = parsed.getTime();
  if (Number.isNaN(ms)) return 'unknown';

  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';

  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
