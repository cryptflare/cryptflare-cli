/**
 * Derives URL-safe slugs from display names.
 *
 * The API requires a slug on workspace, environment and pod creation, and the
 * CLI used to require the caller to supply it. In practice that meant typing
 * the same string twice:
 *
 *   cf workspace create -n peak-physique-api -s peak-physique-api
 *
 * The slug is derivable from the name in every case where they differ only by
 * formatting, so the CLI now derives it and `--slug` is only needed when the
 * two should genuinely differ (`-n Development -s dev`).
 *
 * Implemented here rather than imported from `@cryptflare/shared` on purpose:
 * the CLI mirror vendors exactly one shared module (BRAND), so a second shared
 * import would break the published package. See
 * `scripts/vendor-shared-for-cli-mirror.mjs`.
 *
 * Must satisfy the server's rule, which is `/^[a-z0-9-]+$/` across pods,
 * environments and workspaces.
 */

/** Matches the server-side slug constraint. Kept adjacent to the generator. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Converts a display name into a valid slug.
 *
 * Returns an empty string when nothing survives - e.g. a name of only
 * punctuation or non-Latin script. Callers must treat that as "cannot derive"
 * and ask for an explicit `--slug` rather than sending it, since the server
 * would reject it with a less obvious message.
 */
export function toSlug(name: string): string {
  return name
    .normalize('NFKD')
    // Strip combining marks so accented characters fold to their base letter
    // (Café -> Cafe) instead of being dropped entirely (Caf).
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // Collapse runs introduced by adjacent separators ("a -- b" -> "a-b").
    .replace(/-{2,}/g, '-');
}

/**
 * Resolves the slug for a create command: an explicit value wins, otherwise it
 * is derived from the name.
 *
 * Throws with an actionable message rather than letting an underivable name
 * reach the server, and validates an explicitly supplied slug locally so the
 * failure arrives before the request instead of as a validation error.
 */
export function resolveSlug(name: string, explicit?: string): string {
  if (explicit) {
    if (!SLUG_PATTERN.test(explicit)) {
      throw new Error(
        `Invalid slug "${explicit}". Use lowercase letters, numbers and hyphens only (e.g. "${toSlug(explicit) || 'my-slug'}").`,
      );
    }
    return explicit;
  }

  const derived = toSlug(name);
  if (!derived) {
    throw new Error(
      `Could not derive a slug from "${name}". Pass one explicitly with --slug (lowercase letters, numbers and hyphens).`,
    );
  }
  return derived;
}
