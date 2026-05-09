# @cryptflare/cli

[![npm version](https://img.shields.io/npm/v/@cryptflare/cli.svg)](https://www.npmjs.com/package/@cryptflare/cli)
[![npm downloads](https://img.shields.io/npm/dm/@cryptflare/cli.svg)](https://www.npmjs.com/package/@cryptflare/cli)
[![License](https://img.shields.io/npm/l/@cryptflare/cli.svg)](LICENSE)
[![CI](https://github.com/cryptflare/cryptflare-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/cryptflare/cryptflare-cli/actions/workflows/ci.yml)

Command-line interface for [CryptFlare](https://cryptflare.com). Manage secrets, pods, environments, and tokens from your terminal.

> This repository is the **public mirror** of `packages/cli` from the CryptFlare platform monorepo. Source-of-truth lives in the monorepo and is synced here on every release. **Open issues and pull requests in this repository.**

## Features

- Passwordless device login (`cf login`)
- List, reveal, set, rotate secrets
- `cf import` for `.env`, Doppler, and other formats
- `cf inject` runs a process with secrets in its environment - no `.env` on disk
- `cf sync` triggers cloud sync connections
- Works on macOS, Linux, Windows
- Provenance-attested builds via [npm sigstore](https://docs.npmjs.com/generating-provenance-statements)

## Install

### npm

```bash
npm install -g @cryptflare/cli
```

### Homebrew (macOS / Linux)

```bash
brew install cryptflare/tap/cf
```

### Standalone binary

Pre-built binaries are published with each release at https://github.com/cryptflare/cryptflare-cli/releases.

## Quick start

```bash
cf login                                              # device-flow auth
cf pods list
cf secrets list --pod prod --environment production
cf import .env --pod prod --environment production
cf inject --pod prod --environment production -- node server.js
```

## Documentation

- **Full reference**: https://cryptflare.com/cli
- **Commands**: https://cryptflare.com/cli/commands
- **Examples**: https://github.com/cryptflare/examples

## Versioning

We follow [Semantic Versioning](https://semver.org/):
- **Major** - breaking command, flag, or output changes
- **Minor** - new commands or flags
- **Patch** - bug fixes

Pre-1.0 minors may include breaking changes - we will call this out in the changelog.

## Supply chain

Every release is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). The Verified badge on npm proves the package was built from this exact commit by GitHub Actions.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Most code changes are made in the upstream monorepo; doc, README, and tooling fixes can be PR'd here.

## Security

Vulnerabilities: email **security@cryptflare.com**. See [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) (c) BUUN GROUP PTY LTD
