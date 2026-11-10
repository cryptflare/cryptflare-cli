/**
 * Capture policy: what the sync engine does with a key that appears in a
 * local env file and does not exist in CryptFlare yet.
 *
 * - `off`    report it and leave it. The engine never creates a secret.
 * - `prompt` ask before creating, when someone is there to ask. Unattended
 *            (the background service), it behaves like `off`.
 * - `auto`   create it. The key was typed into a file bound to this
 *            environment, so it is taken to belong there.
 *
 * `off` is the default because a wrong auto-create is not private: every
 * teammate bound to the environment pulls the key on their next pass. Turn
 * `auto` on per binding, for the environments where that is what you want -
 * typically a personal or development environment, not production.
 */
export const CAPTURE_MODES = ['off', 'prompt', 'auto'] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];

export const DEFAULT_CAPTURE_MODE: CaptureMode = 'off';

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === 'string' && (CAPTURE_MODES as readonly string[]).includes(value);
}

/**
 * Reads an optional capture mode from untrusted JSON.
 *
 * @throws Error naming `path` when the value is present but not a known mode.
 */
export function readCaptureMode(value: unknown, path: string): CaptureMode | undefined {
  if (value === undefined) return undefined;
  if (!isCaptureMode(value)) {
    throw new Error(`${path} must be one of ${CAPTURE_MODES.join(', ')} (got ${JSON.stringify(value)})`);
  }
  return value;
}
