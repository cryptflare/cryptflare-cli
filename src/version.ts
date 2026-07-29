/**
 * Single source of truth for the CLI version. Used by `cf --version`,
 * the user-agent header on outbound requests, and `cf update` to compare
 * against the latest published release on npm. Bumped via changesets.
 */
export const VERSION = '0.5.0';
