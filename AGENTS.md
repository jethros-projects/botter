# Contributor guide

Keep Botter small, typed, and easy to follow. This file guides work on the
repository. For an agent using Botter, read [the agent runbook](docs/agents.md).

## Start here

- Read [the SDK guide](docs/SDK.md) for the public contract and examples.
- Read [the architecture map](docs/architecture.md) before changing module boundaries.
- Read [Contributing](CONTRIBUTING.md) for development and verification.
- Use Node.js 22 or newer; CI also checks Node.js 24.

```sh
npm ci --ignore-scripts
npm run check
```

There is no build step. Checks run offline regression tests, API coverage,
strict TypeScript consumers against a packed package, and installation smoke checks.

## Module boundaries

- `src/index.mjs` is the small public entrypoint; `src/sdk.mjs` owns orchestration.
- `src/index.d.ts` defines canonical SDK inputs, results, errors, and subscriptions.
- `src/sdk-errors.mjs` maps transport failures to stable, safe SDK errors.
- CLI modules parse arguments, handle stdin and signals, render results, and set exits.
- Keep send, history, search, watch, and file-transfer behavior in the SDK.
- `src/advanced.mjs` exposes explicit native helpers and transports.
- Keep advanced declarations aligned; `src/core.mjs` preserves legacy imports.
- `schema/verified-support.json` enforces support; reference schemas do not prove it.

## Verify changes

Use fake transports and temporary files for focused offline regression tests.
Check typed exports and runnable examples when changing the public API.
Preserve credential storage compatibility and exact sequence cursor precision.
For live checks, follow [opt-in live verification](CONTRIBUTING.md#opt-in-live-verification).

## Protect release privacy

Use synthetic identities and account data in tests and documentation. Never add
personal filesystem paths, credentials, callback URLs, or raw live responses to
tracked files or package contents. Terminal screenshots must use actual offline
help output. Keep historical live evidence distinct from verification of the
current release archive.

Maintainers must use [the release guide](docs/releasing.md) for repository-local
Git identity, pre-push hooks, and guarded publication. The release privacy check
is separate from ordinary contributor tests. Publish from a source directory
through the reviewed publisher; passing a tarball path can expose its source
path in public npm metadata.
