# Verify the packed SDK against a live account

The normal test suite is offline. This optional check packs the current source, installs that exact tarball privately, and tests the installed `createClient` API and `botter` executable against your Grok Bot account.

Use Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those release lines and an existing working login. Review [the live verification scope](../CONTRIBUTING.md#opt-in-live-verification) first.

## Recorded baseline

On October 19, 2026, a privately packed **0.8.1** build passed all 15 steps of
this harness against a real account. Checks covered SDK and installed-CLI
authentication, discovery, history, search, correlated messaging, watching and
cancellation, and a byte-identical 66-byte file upload/download. The exact
installed payload stayed unchanged throughout the run.

The disposable bot was deleted and its absence verified. The storage API has no
verified attachment-delete operation: one 66-byte upload may remain in storage.
Bot cleanup and storage cleanup are separate claims.

The scoped **0.8.1-next.0** preview has different package metadata and release
files. Its runtime files were compared with that tested baseline, but the new
archive has not had a fresh live run. This evidence applies to the tested
operations and request forms; it does not establish current access, every
advanced method, or all background-task outcomes.

## Run a new check

```sh
npm ci --ignore-scripts
npm run check
BOTTER_E2E_CONFIRM=1 npm run test:live
```

Without `BOTTER_E2E_CONFIRM=1`, the script exits before reading credentials, making requests, or creating fixtures.

## Scope

The script creates exactly one labeled, disposable temporal bot. Setup and deletion use the installed CLI because bot administration is a provider-specific command. Application checks use the packed root SDK directly:

- Authentication metadata and bot discovery; bounded history and search.
- One tiny synthetic file upload, byte-identical download, and attachment reference readback.
- One labeled SDK message with a correlated public reply and persisted history/search readback.
- A live transcript subscription, observation of the fixture, and explicit cancellation.
- One labeled CLI message, history/search readback, download, and a three-second watch.
- Idempotent SDK close, deletion of the exact disposable bot, and roster verification of its absence.

It does not change primary-bot selection, account settings, routines, or existing bots. Writes are not automatically retried. A public reply can be a progress update; the check makes no claim that background work completed.

SDK calls have bounded request deadlines, reply waits are bounded, and the run has a six-minute deadline. Cancellation still attempts fixture cleanup with its own deadline.

## Evidence and cleanup

The script creates a private directory under `work/e2e/`. It saves the tarball, installed package, synthetic files, a mode-0600 fixture journal, and a metadata report. The journal is synced before creating the bot, uploading the file, or dispatching a message; it records exact fixture IDs and references for reconciliation. It contains no credentials or private conversation bodies. `work/` is excluded from Git and package releases.

Stdout contains only step statuses, durations, counts, content hashes, and cleanup metadata. The report records the exact tarball SHA-256 and a deterministic hash of its installed source files. Keep reports separate from packaged source so the tested package remains unchanged.

Bot deletion and underlying storage retention are separate. The current verified API has no attachment-delete operation. The report states the possible retained upload count/size and `uploadDeletionVerified: false`; the private journal retains its exact path. A removed bot does not establish that the storage object was deleted.

If the process is interrupted before cleanup, inspect its private journal and run only exact fixture cleanup:

```sh
BOTTER_E2E_CONFIRM=1 npm run test:live -- --cleanup work/e2e/RUN_ID/journal.json
```

Cleanup checks the recorded UUID and fixture name before deletion, then verifies absence. It never recreates a bot or resends a message. A failed cleanup remains explicit in the journal and report; do not remove an unrelated resource to make a check pass.
