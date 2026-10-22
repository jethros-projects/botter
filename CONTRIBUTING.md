# Contributing to botter

Keep Botter easy to learn and easy to maintain. Prefer small modules, typed inputs, and one clear way to perform an operation. The SDK owns application behavior; the CLI is a thin adapter. Keep everyday help short and put detailed flags in command help.

## Local setup

Use Node.js **22.23.4+, 24.22.1+, or 26.12.1+** within those release lines.
The repository default is 24.22.1 (`.node-version`); unsupported runtimes fail
before SDK or CLI startup. See [the security update](docs/security-2026-10.md).

```sh
npm ci --ignore-scripts
npm run check
npm pack --dry-run
node bin/botter.mjs --help
```

There is no build step. `npm run check` runs the regression suite, offline API coverage check, strict TypeScript consumers against the packed package, and an isolated tarball installation smoke check. No credentials or live account access should be needed. CI checks Node.js 22.23.4, 24.22.1, and 26.12.1 on Linux and macOS.

## Structure

- `bin/` contains the executable entry point.
- `src/index.mjs` exposes the public SDK; `src/sdk.mjs` owns validation, orchestration, lifecycle, and subscriptions.
- `src/index.d.ts` defines the canonical typed contract; `src/sdk-errors.mjs` provides stable public errors.
- `src/commands.mjs` defines convenience commands and help.
- `src/cli.mjs`, `src/api-cli.mjs`, and `src/gateway-cli.mjs` handle command parsing and presentation.
- `src/advanced.mjs` exposes native helpers and transports; `src/core.mjs` retains the legacy API. Keep their declarations aligned.
- Other `src/` modules implement authentication, transport protocols, schemas, and native features.
- `schema/verified-support.json` controls the managed SDK and executable API surface; other schema files are references.
- `test/` contains fake-transport and offline regression tests; `test/types/` checks typed consumers; `scripts/` contains maintenance checks.

Read [the architecture map](docs/architecture.md) for module boundaries,
[the SDK guide](docs/SDK.md) for the public API, and
[the agent runbook](docs/agents.md) for agents using the CLI.

## Changes

Describe the user-visible problem and the resulting behavior in a pull request. Include the commands used to verify it. Add focused regression coverage for behavior changes; avoid tests that merely repeat the implementation.

Validate arguments before accessing credentials, request files, or the network. Keep stdout machine-readable and send diagnostics to stderr. Never retry a write automatically or introduce hidden account mutations.

An operation's presence in a reference schema is not evidence that it works. Add support only with a documented scope, enforced request restrictions, and appropriate tests. Keep previous constraints until new evidence justifies changing them.

Keep examples runnable from a clean checkout. Update command help and relevant documentation in the same change. Preserve existing authentication storage compatibility unless a migration is part of the change.

Use synthetic identities, messages, and resource IDs in examples and fixtures.
Never commit personal filesystem paths, account recordings, credentials, login
callback URLs, or raw live responses. Screenshots must show actual offline CLI
output without account data. Review the packed package as well as the source:
release metadata and archive headers are public too.

Use fake transports and temporary files to test SDK behavior without account access. Cover meaningful validation, cancellation, delivery, subscription, and compatibility boundaries. Keep command tests focused on argument handling, SDK delegation, and output.

## Releases

The scoped package `@jethros-projects/botter` contains both SDK and CLI. Preview
releases use the `next` channel. Maintainers should follow
[the release guide](docs/releasing.md) for local Git identity and pre-push setup,
privacy checks, and directory-based publication.

`npm run release:check` and `npm run release:publish` require a complete source
checkout and the reviewed npm 11.11.1 publisher. These maintainer checks are
separate from ordinary contributor CI. Do not publish a tarball path: npm can
retain its source path in public registry metadata.

## Opt-in live verification

Live tests are separate from the normal suite. Run them only against an account you control or have permission to use, with explicit authorization for any writes. Use disposable resources, verify the resulting state, and clean up afterward. Do not commit credentials, webhook keys, account identifiers, conversation contents, private artifacts, or raw live responses.

The opt-in [packed SDK live check](docs/live-verification.md) exercises the application API and installed CLI with a journaled disposable fixture. It records exact package hashes and reports bot cleanup separately from storage retention.

For vulnerabilities, follow [Security](SECURITY.md).
