# github-push

Sets up pushes of CryptFlare environments to GitHub Actions secrets from the terminal: `cf github connect` (`packages/cli/src/commands/github.ts`).

Governed by `docs/standards/security.md` (no personal token is stored; `gh` runs as its own process) and `docs/patterns/imports.md` (import through this folder's barrel).

| File         | Purpose                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------ |
| `gh-repo.ts` | Runs `gh` to find the repository, check admin access, list and create GitHub environments  |
| `targets.ts` | Reads `--env <env>[:<github-environment>]` into push targets; spots connections that exist |
| `install.ts` | Finds the CryptFlare GitHub App installation on the repository's owner                     |
| `index.ts`   | Barrel                                                                                     |

`gh` is only used while setting up, and always as its own process, so its token never enters this process or reaches CryptFlare. The pushes run through the CryptFlare GitHub App installed on the owner, which mints a short-lived token per push.
