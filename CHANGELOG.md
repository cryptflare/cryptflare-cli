# @cryptflare/cli

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
