# @cryptflare/cli

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
