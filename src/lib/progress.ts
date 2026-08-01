import ora, { type Ora } from 'ora';

/**
 * Shared progress indicator.
 *
 * Two rules make this safe to use anywhere:
 *
 * 1. It writes to **stderr**. Spinner frames on stdout would corrupt
 *    `cf env -f json | jq` and `cf pull --json > file`, which are the two
 *    things people pipe.
 * 2. It renders only on a TTY. In CI or a pipe the frames would be thousands
 *    of lines of escape codes in the log, so there it stays silent and the
 *    command's own output carries the story.
 */
const isInteractive = Boolean(process.stderr.isTTY);

let active: Ora | null = null;

/** Starts (or retargets) the spinner. Safe to call when one is already running. */
export function start(text: string): void {
  if (!isInteractive) return;
  if (active) {
    active.text = text;
    return;
  }
  active = ora({ text, stream: process.stderr }).start();
}

/**
 * Starts a spinner only when nothing is spinning.
 *
 * Used by the request hook so a generic "Fetching secrets..." never overwrites
 * a command's own, better label - "Comparing with remote...", "Pushing 23
 * secrets...". The command owns the message; the hook only covers the gaps.
 */
export function startIfIdle(text: string): void {
  if (active) return;
  start(text);
}

/** Updates the running spinner's label. No-op when nothing is spinning. */
export function update(text: string): void {
  if (active) active.text = text;
}

/** Stops and clears the spinner, leaving no residue on the line. */
export function stop(): void {
  if (!active) return;
  active.stop();
  active = null;
}

/**
 * Runs `fn` with a spinner, clearing it whether the work succeeds or throws.
 *
 * The `finally` matters: an error escaping with the spinner still running
 * leaves the terminal with a stuck frame and a hidden cursor.
 */
export async function withProgress<T>(text: string, fn: () => Promise<T>): Promise<T> {
  start(text);
  try {
    return await fn();
  } finally {
    stop();
  }
}

/**
 * Counts down while the SDK waits out a rate limit.
 *
 * This is the case that actually looked frozen. The reveal endpoint allows
 * 30/min, so a large pull hits it and the SDK sleeps for up to a minute -
 * previously in total silence, with no output and no exit, which is
 * indistinguishable from a hang. A ticking countdown says the tool is alive
 * and, more usefully, says exactly why it is waiting and for how long.
 *
 * Returns a function that cancels the countdown.
 */
export function countdown(prefix: string, ms: number): () => void {
  if (!isInteractive) return () => {};

  const endsAt = Date.now() + ms;
  const render = () => {
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    update(`${prefix} ${left}s`);
  };

  render();
  const timer = setInterval(render, 1000);
  // Never hold the process open just to animate a spinner.
  timer.unref?.();

  return () => clearInterval(timer);
}

/**
 * Turns a request into something worth reading.
 *
 * "GET /v1/organisations/5378a8ce-.../workspaces/peak-physique-api/environments/dev/secrets"
 * is noise. The resource and the verb are the useful part, and the scope is
 * already on screen from the command the user just typed.
 */
export function describeRequest(method: string, path: string): string {
  const verbs: Record<string, string> = {
    GET: 'Fetching',
    POST: 'Sending',
    PUT: 'Saving',
    PATCH: 'Updating',
    DELETE: 'Deleting',
  };
  const verb = verbs[method.toUpperCase()] ?? 'Working';

  // Last path segment that is not an id, so `.../secrets/DATABASE_URL` reads
  // as "secrets" rather than leaking a key name into the terminal.
  const segments = path.split('?')[0]!.split('/').filter(Boolean);
  const known = ['secrets', 'workspaces', 'environments', 'pods', 'tokens', 'organisations',
    'audit', 'members', 'billing', 'service-tokens', 'reveal', 'batch'];
  const resource = [...segments].reverse().find((s) => known.includes(s));

  return resource ? `${verb} ${resource}...` : `${verb}...`;
}

/** Stops the spinner and leaves a success line. */
export function succeed(text: string): void {
  if (active) { active.succeed(text); active = null; return; }
  console.error(text);
}

/** Stops the spinner and leaves a failure line. */
export function fail(text: string): void {
  if (active) { active.fail(text); active = null; return; }
  console.error(text);
}

/** Stops the spinner and leaves an informational line. */
export function info(text: string): void {
  if (active) { active.info(text); active = null; return; }
  console.error(text);
}
