# @cryptflare/cli

## 0.5.2

### Patch Changes

- bc0656b: Fix `cf import`, and make several listings usable.
  - `cf import` sent its secrets array as `items`, but the server validates `secrets`, so every import failed with "secrets: Required" after reporting a successful parse - the command could not have worked. The body is now built by an exported, tested function checked against `ImportRequestSchema`.
  - `cf config list` printed the API token in full; it is masked to its prefix unless `--reveal` is passed. `cf config get` printed `[object Object]` for the two keys whose values are objects.
  - `cf token list` joined every scope into one cell, producing a ~1,000-character-wide table; it now shows a count plus the resources touched, and marks expired tokens.
  - Added `cf audit list`, which every other resource group already had, and `cf config path`.
  - `cf status` now names the missing `billing:read` permission up front instead of surfacing a server 403 that reads as a role problem.

- bc0656b: Quote written `.env` values so sourcing the file cannot execute them.

  `cf pull` wrote every value needing quotes in double quotes, escaping only `\`, `"` and newlines. A shell expands `$VAR` and runs `` `cmd` `` inside double quotes, so a secret containing either was both corrupted and executed on `set -a; . .env` - a command injection, since a secret's contents are attacker-influenced in the general case. Values are now written in single quotes, which are literal in both a shell and dotenv; double quotes are used only for values containing a single quote or newline, where `$`, backtick, `"` and `\` are escaped. Verified by round-tripping thirteen hostile values through both the parser and a real shell.

- Updated dependencies [bc0656b]
  - @cryptflare/sdk@1.0.2

## 0.5.1

### Patch Changes

- 2423622: Stop `cf sync status` from spending the reveal rate limit.

  Planning decrypts a value only on first contact with a key that exists both locally and remotely, where nothing else can distinguish "already in sync" from "diverged". Across a dozen newly registered files that exhausted the 30/min reveal limit, and the dry run failed with "Too many requests to reveal-secret" instead of reporting anything. `status` now plans without decrypting and reports those keys as `needs-compare`; `cf sync run` resolves them. Applying a plan built that way is refused rather than rebaselining keys that were never compared.

  Also fixes `cf sync status` printing `undefined/<environment>` for any binding that names its own workspace, and adds `cf config path`, which prints where the config, sync registry, and sync state actually live (under `~/.config/cryptflare-nodejs`, since `conf` appends the suffix - the docs claimed `~/.config/cryptflare`).

- Updated dependencies [2423622]
  - @cryptflare/sdk@1.0.1

## 0.5.0

### Minor Changes

- 2063de1: `cf push` now validates the whole file before writing anything, and writes in
  batches instead of one request per key.

  Previously each key was sent individually with no rollback and no summary. A
  rejection partway through left the environment half-written and reported only
  the failing field - not which keys had already landed. That is how a
  `STAFF_ADMIN_EMAILS` ended up orphaned in the wrong environment after an
  interrupted push.

  Now:
  - **Validated up front.** Keys and values are checked against the same rules the
    server enforces, and every problem is reported at once rather than one per
    round trip. Nothing is written if anything is invalid.
  - **Batched writes.** A 23-key push is one request instead of 23, using the
    batch endpoints, each of which is a single multi-row insert server-side.
  - **Honest failure.** If a batch does fail, the output names the keys that
    landed and notes that re-running is safe.
  - **`--dry-run` validates too**, so a preview no longer passes on a file the
    real push would reject.

- a55fd37: Stop requiring secret values on the command line.

  `cf secret set KEY VALUE` took the value as a positional argument and
  `cf secret rotate KEY --value VALUE` required a flag. Both write the secret into
  shell history (`~/.bash_history`, `~/.zsh_history`), expose it in `ps` output to
  any other user on the machine while the command runs, and leave it in terminal
  scrollback and CI logs.

  There are now three safer routes, matching what other secrets tooling does
  (`gh secret set` reads stdin, `wrangler secret put` prompts, `vault kv put`
  accepts `@file`):

  ```bash
  cf secret set API_KEY                          # prompts, hidden input
  echo -n "$API_KEY" | cf secret set API_KEY     # stdin
  cf secret set API_KEY --file ./key.txt         # file
  cf secret set API_KEY @./key.txt               # file, shorthand

  openssl rand -hex 32 | cf secret rotate API_KEY
  ```

  The inline forms still work so existing scripts keep running, but they now warn
  on stderr - never stdout, so `--json` output and pipelines stay clean.

  A single trailing newline is stripped from file and stdin input, since
  `echo "$V" |` adds one and a secret rarely wants it. Interior newlines are
  preserved, so a PEM key survives intact.

- 6d4edc2: Fix `cf run`, which had never worked, and make `cf env -f shell` safe to eval.

  **`cf run` was completely broken in every published version.** It declared no
  positional argument, so commander rejected the command outright:

  ```
  $ cf run -w my-app -e production -- node server.js
  error: too many arguments for 'run'. Expected 0 arguments but got 2.
  ```

  That is the headline example in the README. It now works, and three further
  problems were fixed in the process:
  - **Exit codes are propagated.** The child ran under `execSync`, which throws on
    any non-zero exit; that became a CryptFlare-branded error and exit 1. So
    `cf run -- npm test` reported 1 whether tests failed with 1 or 2, and buried
    the reason. A signal death now becomes 128+signal, and a missing command
    exits 127, as a shell would report them.
  - **No shell.** The argv was reassembled with `join(' ')` and run through a
    shell, so any argument containing a space, quote, `;` or `$(...)` was
    reinterpreted. It now spawns with the argv vector intact.
  - **Child flags reach the child.** `cf run -- vitest --watch` no longer has
    `--watch` parsed by the CLI.

  **`cf env -f shell` emitted double-quoted values**, leaving `$`, backticks and
  `\` live. A secret containing `$(...)` executed when the output was eval'd -
  the documented usage is `eval "$(cf env -f shell)"`. Values are now
  single-quoted, with embedded quotes escaped.

- 70885dd: Make `--slug` optional on `cf workspace create`, `cf environment create` and
  `cf pod create`. It is derived from `--name` when omitted.

  Creating anything meant typing the same string twice:

  ```bash
  cf workspace create -n peak-physique-api -s peak-physique-api
  ```

  Now:

  ```bash
  cf workspace create -n peak-physique-api          # slug: peak-physique-api
  cf workspace create -n "Peak Physique API"        # slug: peak-physique-api
  cf environment create -n Development -s dev       # explicit slug still wins
  ```

  Derivation folds accents to their base letter (`Café` becomes `cafe`, not
  `caf`), collapses separator runs, and trims edges. An explicitly supplied slug
  is validated locally, so a malformed one fails immediately with a suggested
  correction instead of as a server validation error. A name that cannot be
  slugged at all - punctuation only, or non-Latin script - asks for `--slug`
  rather than sending something the server would reject.

  `--slug` on the `update` commands is unchanged.

- 45c39d2: Add `cf sync init` and the committed `.cryptflare.json` manifest, so a fresh
  clone is one command.

  The sync registry is machine-local, so the mapping of files to workspaces lived
  only on the machine where it was set up. A new laptop - or a new teammate - had
  no way to discover it, and a six-app monorepo meant thirteen commands plus six
  remembered workspace slugs.

  ```bash
  git clone git@github.com:acme/my-monorepo.git
  cd my-monorepo
  cf sync init          # pulls every bound file, registers for ongoing sync
  ```

  `.cryptflare.json` is committed alongside the code and holds **no secrets** -
  only file paths and workspace/environment/pod names. Generate it from an
  existing setup with `cf sync init --write`.

  Also in this release:
  - **Per-binding `workspace`.** A binding may name its own workspace, so one
    repository can map each app to its own - which matters because tokens are
    scoped per workspace, keeping each app's secrets in a separate access
    boundary. `cf sync add` accepts `--bind <file>=<workspace>/<environment>`.
  - **Per-binding `pod`** for grouping within an environment.
  - Existing files are merged rather than clobbered on `cf sync init`, so a
    template `.env` shipped in the repo keeps its comments and unmanaged lines.
  - `cf sync add` points you at `cf sync init` when the directory already has a
    manifest, rather than letting the two drift apart.

- c468066: Add `cf completion` and fix destructive commands reporting success when they did
  nothing.

  **Shell completions.** `cf completion bash|zsh|fish` emits a completion script,
  generated by walking the live command tree so it cannot drift from the commands
  that actually exist.

  ```bash
  source <(cf completion bash)                        # try it now
  cf completion zsh > "${fpath[1]}/_cf"               # persist
  cf completion fish > ~/.config/fish/completions/cf.fish
  ```

  **Confirmation.** Five destructive commands - `secret delete`, `secret
rollback`, `workspace delete`, `pod delete`, `token revoke` - printed "Pass
  --yes to confirm" and **exited 0**. So `cf secret delete X && echo done` printed
  `done` having deleted nothing, and interactively you had to retype the whole
  command with a flag.

  They now prompt when there is a terminal, and exit 1 with an explanation when
  there is not, so a script can tell refusal from success. `workspace delete`
  requires typing the workspace slug, since it takes every environment, pod and
  secret with it.

- 227406d: Add `cf service-token` (alias `cf svc-token`).

  Service tokens existed in the API and the dashboard but had no CLI surface, so
  you could not mint the token your pipeline authenticates with from the tool your
  pipeline uses.

  ```bash
  cf service-token list
  cf service-token create -n ci-deploy -s secrets:read --expires 2027-01-01T00:00:00Z
  cf service-token disable <id>     # reversible - pause a misbehaving pipeline
  cf service-token enable <id>
  cf service-token revoke <id>      # permanent, prompts first
  ```

  Distinct from `cf token`, which manages _personal_ access tokens scoped to one
  workspace. A service token belongs to the organisation, is not tied to a person,
  and can be disabled without being destroyed - which is what you want at 3am when
  you would rather pause a pipeline than lose its audit trail.

  `create` warns when no `--expires` is given, since an unexpiring token is one you
  will never notice has leaked.

- 3004f9b: `cf pull` no longer writes world-readable secrets, and merges instead of
  refusing.

  **File permissions.** Pulled files were written with the default mode, which on
  a typical umask is `0644` - readable by every other user on the machine,
  including on a shared CI runner. They are now `0600`, matching what the sync
  service already did.

  **Merging.** An existing file caused `cf pull` to refuse and point at
  `--overwrite`, which regenerated the file from scratch and discarded comments,
  ordering, and any key the CLI does not manage. The safe-looking path was the
  destructive one.

  It now merges by default - pulled keys updated in place, new ones appended,
  everything else preserved - and reports what changed:

  ```
  ✓ Merged into .env: +1 new, ~1 updated, 0 unchanged
  ```

  `--overwrite` still regenerates wholesale when that is what you want.

### Patch Changes

- 7217aa4: Fix relative timestamps being wrong by the reader's UTC offset.

  `cf secret list` reported a secret created seconds earlier as "10h ago" from
  UTC+10, while a rotated one on the same line read "just now".

  The API returns two shapes for the same instant. Rotate and update paths emit
  ISO-8601 with an explicit zone (`2026-07-29T02:51:23.000Z`), but column
  defaults use SQLite's `datetime('now')`, which yields `2026-07-29 02:51:23` -
  no `T`, no zone designator. That is not a valid ISO-8601 date-time string, so
  `new Date()` parses it as local time. The value is UTC, so every reader outside
  UTC is wrong by exactly their own offset.

  Timestamps are now parsed through a helper that treats the zone-less shape as
  UTC. 67 columns in the schema carry that default, so this affects far more than
  secret listings; normalising on read also corrects historical rows, which a
  schema change could not.

- fd8a2e1: Store the auth token in a private config file.

  `~/.config/cryptflare*/config.json` holds the bearer token and was written with
  `conf`'s default mode, which under a typical `0o022` umask lands at `0644` -
  readable by every other user on the machine. A full-access credential should not
  be.

  It is now created `0600`, and an existing loose file is tightened the next time
  any command runs, so the fix does not depend on re-authenticating. The repair is
  best-effort and skipped on Windows, where `chmod` does not apply.

- 7c20bdf: Fix `cf push`, `cf pull` and `cf diff` mangling `export KEY=value` lines.

  Those commands carried their own `.env` parser that did not understand a leading
  `export `, so a direnv `.envrc` line became the key `export CLOUDFLARE_API_TOKEN`
  and the API rejected the push:

  ```
  Request validation failed - key: Key must be UPPER_SNAKE_CASE
  ```

  They now share the same structure-preserving parser as `cf sync`, so every
  command agrees about the same file. This also brings quoted values, escapes,
  inline comments and multi-line detection to the one-shot commands.

- Updated dependencies [d154236]
- Updated dependencies [023d039]
  - @cryptflare/sdk@1.0.0

## 0.4.1

### Patch Changes

- 0fd1499: Fix `cf auth login` failing with an unhandled `ConfigurationError` when no token
  is stored.

  Login built its API client with `getClient()`, which throws when the config
  holds no token. That made authentication impossible in exactly the two states it
  exists to resolve: immediately after `cf auth logout`, and on a fresh machine.
  The throw also sat outside the command's try/catch, so it surfaced as a raw Node
  stack trace rather than a readable message.

  The device-authorization flow takes no credentials by design - `POST
/v1/cli/device` and `POST /v1/cli/token` ignore the Authorization header - so
  login now uses a new `getAnonymousClient()` that needs no stored token. It is
  deliberately uncached, so it cannot leak into later authenticated calls, and the
  client cache is reset once the new token is saved.

## 0.4.0

### Minor Changes

- 02994f4: Add `cf sync`: a multi-project, bidirectional env-file sync service.

  Registers project directories in `~/.config/cryptflare/sync.json`, binding each
  `.env`-shaped file to one environment, and keeps them reconciled against
  CryptFlare in both directions. Ships `cf sync install-service` to generate a
  systemd user unit for unattended operation.
  - Three-way merge against a recorded baseline, so local edits push up and
    remote rotations pull down without guessing direction. Remote change
    detection reads the version from `secrets.list`, so values are only decrypted
    for keys that actually changed.
  - Guarded push: keys already present remotely are updated; keys new to a local
    file are reported, never auto-created. Deletion is never propagated either
    way.
  - Conflicts resolve remote-wins with the local value preserved in a
    `.cf-conflict-<timestamp>` sidecar.
  - Writes preserve comments, ordering, `export` prefixes, and any line the CLI
    does not manage. Multi-line quoted values are detected and left alone.

  Subcommands: `add`, `list`, `remove`, `enable`, `disable`, `status`, `run`,
  `watch`, `install-service`. The existing `cf pull` / `cf push` / `cf diff` /
  `cf daemon` commands are unchanged.

## 0.3.0

### Minor Changes

- 8fb25cf: Expose access-token IP allowlist on the TypeScript SDK and CLI.
  - `tokens.create` and `tokens.update` accept an optional `ipAllowlist?: string[]` (max 50 entries; IPv4 / IPv6 addresses or CIDR blocks). Requests from outside the list are rejected with `403 ACCESS_TOKEN_IP_BLOCKED`.
  - `tokens.update` accepts `ipAllowlist: null` to clear an existing allowlist; omitting the field leaves it unchanged.
  - New CLI flag `cf token create --ip-allow=10.0.0.0/8,203.0.113.5,...` (comma-separated). `cf token list` shows the allowlist size per token.

  Mirrors the long-standing service-token allowlist behaviour for personal access tokens.

- cfe749b: `audit.export(...)` SDK method + `cf audit export` CLI command.

  ```ts
  const stream = await client.audit.export({
    startDate: "2026-04-01T00:00:00Z",
    endDate: "2026-04-30T23:59:59Z",
  });
  // stream is a ReadableStream<Uint8Array> of JSON Lines.
  ```

  ```bash
  cf audit export --start 2026-04-01T00:00:00Z --end 2026-04-30T23:59:59Z --file audit-april.jsonl
  ```

  Streams the API's `POST /v1/organisations/:org/audit/export` JSON Lines response directly to disk (or stdout when `--file -`). No buffering, so memory stays flat for arbitrarily large exports up to the server's 100 000-row + 366-day caps. Throttled server-side to one request per hour per organisation.

  Closes the audit-export loop end to end (API endpoint shipped previously).

- 718b5cf: Client-side permission gate for destructive commands.

  `cf secret rotate`, `cf secret delete`, `cf secret rollback`, `cf token create`, `cf token revoke`, and `cf workspace delete` now check the bearer token's scopes via `auth.whoami` before issuing the destructive API request. A missing scope prints `Insufficient permission. Need: X. Have: Y.` and exits non-zero before any state changes.

  Permissions are cached for 5 minutes per (token, server) pair under the existing `conf` config so commands don't hammer `/v1/auth/whoami`. `cf logout` clears the cache alongside the bearer token.

  The server is still the source of truth; this is defensive UX so a misconfigured token fails fast instead of after a destructive request has already partially landed.

- 6621c52: Expose secret version history on `cf secret`.
  - `cf secret versions <key>` lists every historical version (metadata only).
  - `cf secret reveal-version <key> <version>` decrypts a specific past version.
  - `cf secret rollback <key> <version>` creates a new version with the value from the chosen historical version. Requires `--yes` to confirm.

  The backend endpoints + TypeScript SDK methods already shipped; this commit wires them through the CLI so version history is available without the dashboard.

- 3367583: `cf sync daemon` - long-running polling loop that keeps a local `.env` file in lockstep with a remote workspace/environment.

  ```
  cf sync daemon --workspace prod --env production --file .env
  ```

  - Pulls every secret in the scope, writes them to the target file atomically (`.env.tmp` -> rename), and rewatches.
  - Default poll interval 30s. Five consecutive no-change polls double the interval up to a 5-minute ceiling so an idle scope does not hammer the API; a change resets the interval. ±10 % jitter avoids a thundering herd across multiple daemons.
  - SIGTERM / SIGINT triggers a clean shutdown after the in-flight pull completes; the file is never half-written.
  - `--once` runs a single pass (useful in CI).
  - `requires secrets:read` (gated by the new client-side RBAC helper before the first pull).

  SSE-driven streaming is tracked as a server-side follow-up; switching from poll to push is a one-line change in the daemon loop once `/v1/secrets/stream` ships.

### Patch Changes

- Updated dependencies [8fb25cf]
- Updated dependencies [cfe749b]
  - @cryptflare/sdk@0.4.0

## 0.2.1

### Patch Changes

- 09e31bf: Implement package version synchronization
  - Adds a new script `sync:package-versions` to update in-source VERSION constants
    of published packages (CLI and SDK) to match the version defined in their respective package.json files.
  - Integrates version synchronization into the `test`, `test:run`, and `typecheck` scripts across CLI and SDK packages.
  - Updates the root `version-packages` script to run version synchronization after changing the version.
  - Adds a CI workflow step to verify that in-source VERSION constants match package.json before running tests.
  - Implements a new utility script `scripts/sync-package-versions.mjs` to handle the version syncing logic.
  - Updates the CLI and SDK packages to use the new version synchronization script for build and test steps.

- Updated dependencies [09e31bf]
- Updated dependencies [8d8c10f]
  - @cryptflare/sdk@0.3.0

## 0.2.0

### Minor Changes

- 4ce9bfd: - Add `cf init` interactive setup wizard. Walks you through picking a default org, workspace, and environment after authenticating, then writes them to your config so you can drop the `-w` and `-e` flags from every subsequent command. `--yes` accepts the first match at every step for scripted setups.
  - Add `cf doctor` diagnostic checklist - Node version, config file, saved credential, API reachability + token introspection, default org/workspace/environment presence, and CLI version vs npm latest. Exits non-zero only on hard failures so it is safe to run from CI / runbooks. `--json` for machine-readable output.
  - Add `cf telemetry on|off|status` command. Opt-in only, honours `DO_NOT_TRACK=1` and `CF_TELEMETRY=on|off` overrides.
  - Add `cf update [--check]` for self-update against npm. Detects the package manager that installed the CLI (`npm`, `pnpm`, `bun`, `yarn`) from `npm_config_user_agent` and runs the matching global-install command.
  - Fix `version` constant drift; new test asserts it matches `package.json`.
  - New runtime dependency on `prompts` for the interactive wizard.

### Patch Changes

- 9f37e22: Update package manifest and build configurations
  - Update repository URLs in package.json files to use git+https:// format
  - Adjust package exports in mcp-client and sdk/typescript to support modern module resolution (default/types/require)
  - Update tsup configuration to output both esm and cjs formats for better type compatibility

- Updated dependencies [9f37e22]
- Updated dependencies [4ce9bfd]
  - @cryptflare/sdk@0.2.0

## 0.1.0

Initial public release. Built on top of `@cryptflare/sdk@^0.1.0`.

### Added

- `cf auth login` browser device flow plus `cf auth status`, `cf auth logout`, `cf whoami`.
- `cf secret` family - list, get, set, rotate, delete, move.
- `cf pod` family - list, get, create, update, delete, tree.
- `cf pull / push / diff` for syncing remote secrets with local `.env` files.
- `cf run -- <cmd>` injects decrypted secrets as env vars.
- `cf env -f shell|dotenv|json` exports secrets in machine-readable formats.
- `cf org`, `cf workspace`, `cf environment`, `cf token` resource commands.
- `cf status` showing plan usage and limits.
- `cf config get/set/unset` for managing local defaults.
- Env-var configuration: `CF_TOKEN`, `CF_ORG`, `CF_WORKSPACE`, `CF_ENVIRONMENT`, `CF_API_URL`, `NO_COLOR`.
