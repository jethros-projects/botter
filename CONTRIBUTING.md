# Contributing to botter

Keep botter easy to learn and easy to maintain. Prefer small modules, explicit inputs, and one clear way to perform an operation. Keep everyday help short and put detailed flags in command help.

## Local setup

Use Node.js 22 or newer:

```sh
npm ci
npm run check
npm pack --dry-run
node bin/botter.mjs --help
```

`npm run check` runs the regression suite, offline API coverage check, and isolated tarball installation smoke check. No credentials or live account access should be needed. CI checks Node.js 22 and 24.

## Structure

- `bin/` contains the executable entry point.
- `src/commands.mjs` defines convenience commands and help.
- `src/cli.mjs`, `src/api-cli.mjs`, and `src/gateway-cli.mjs` handle command parsing and presentation.
- Other `src/` modules implement authentication, transports, schemas, and features.
- `schema/verified-support.json` controls the executable API surface; other schema files are references.
- `test/` contains offline regression tests; `scripts/` contains maintenance checks.

## Changes

Describe the user-visible problem and the resulting behavior in a pull request. Include the commands used to verify it. Add focused regression coverage for behavior changes; avoid tests that merely repeat the implementation.

Validate arguments before accessing credentials, request files, or the network. Keep stdout machine-readable and send diagnostics to stderr. Never retry a write automatically or introduce hidden account mutations.

An operation's presence in a reference schema is not evidence that it works. Add support only with a documented scope, enforced request restrictions, and appropriate tests. Keep previous constraints until new evidence justifies changing them.

Live tests are separate from the normal suite. Run them only against an account you control or have permission to use, with explicit authorization for any writes. Use disposable resources, verify the resulting state, and clean up afterward. Do not commit credentials, webhook keys, account identifiers, conversation contents, private artifacts, or raw live responses.

Keep examples runnable from a clean checkout. Update command help and relevant documentation in the same change. Preserve existing authentication storage compatibility unless a migration is part of the change.

For vulnerabilities, follow [Security](SECURITY.md).
