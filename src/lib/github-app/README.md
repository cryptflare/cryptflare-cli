# github-app

Connects a GitHub organisation to CryptFlare dynamic secrets from the terminal: `cf dynamic github connect` (`packages/cli/src/commands/dynamic-github.ts`).

Governed by `docs/standards/security.md` (credentials stay in memory, nothing is written to disk) and `docs/patterns/imports.md` (import through this folder's barrel).

| File              | Purpose                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `manifest.ts`     | Parses `--permissions` and `--repos`, builds the App manifest, GitHub URLs, local HTML pages |
| `browser-flow.ts` | Local 127.0.0.1 server for the manifest flow: start page, code callback, install redirect    |
| `app-api.ts`      | GitHub REST calls: manifest code conversion, App JWT, installation lookup                    |
| `permissions.ts`  | Which wanted permissions an installation does not hold                                       |
| `gh.ts`           | Optional `gh` CLI lookup of the person's organisations                                       |
| `contract.ts`     | CLI copy of the shared `github_app` constants; `contract.test.ts` fails if they drift        |
| `index.ts`        | Barrel                                                                                       |

The App's private key comes back from GitHub's manifest conversion, is held in memory, and is sent once to the CryptFlare API as the config's root credentials, where it is encrypted at rest. The client secret and webhook secret GitHub also returns are dropped.
