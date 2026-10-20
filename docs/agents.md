# Using Botter from an agent

This is an operating runbook. For application types and examples, use the [SDK guide](SDK.md); for repository changes, use [AGENTS.md](../AGENTS.md).

## Authenticate and discover

Install `@jethros-projects/botter@next` as described in the [README](../README.md).
A host/user must complete browser sign-in with `botter login`, or supply the
SDK's `tokenProvider`/`authManager`. The native service uses the official Cursor
login flow. Construction never starts login. Use the [CLI reference](commands.md)
to find the relevant command family, then read that command's help.

```sh
botter --help
botter --help-all
botter help send
botter help history
botter auth-status
botter list
botter capabilities
botter api list
botter gateway-api list
```

Help and API listings work offline. CLI `capabilities` also asks the server for runtime flags; SDK `client.capabilities()` is offline. Runtime flags do not override the [verified support manifest](../schema/verified-support.json). Schema discovery is reference material, not permission or support.

`botter list` returns `agentId`; pass that value as CLI `BOT` or SDK `botId`. Names resolve only when unambiguous. Choose a temporal bot for sending. SDK `sessionId` selects its native conversation session; omission uses the current viewer session. Do not invent a generic conversation ID.

## Read, send once, then follow

Read a bounded slice before deciding to write:

```sh
botter history BOT --limit 10
botter search BOT --query "release checklist" --pages 2 --page-size 50 --limit 10
botter status BOT
```

`search` reports whether its history scan is complete. A bounded scan with no matches does not establish that the full conversation has none. Keep transcript sequence cursors as decimal strings.

To send text, provide exactly one of `--text` and `--file`:

```sh
botter send BOT --text "Review the release checklist and report blockers" --wait 30
botter send BOT --file ./task.txt
```

`--file` reads a local UTF-8 file; `--file -` means a file named `-`, not stdin. There is no universal `--json` flag or export command. Use topic help for each command's actual flags.

For a request whose outcome you may need to reconcile, generate a UUID once with `node --input-type=module -e "console.log(crypto.randomUUID())"`, record it, and pass that same value as `--message-id UUID`. Do not generate a new ID and blindly resend after a timeout.

```sh
botter watch BOT --duration 30
botter send-status BOT MESSAGE_ID
botter history BOT --limit 20
botter thread BOT ROOT_MESSAGE_ID --pages 2
```

Use the returned `messageId` as the thread root. `--wait 30` and `--duration 30` use seconds; SDK `waitTimeoutMs`/`timeoutMs` use milliseconds. Acceptance and replies may precede task completion. Inspect the conversation and relevant resulting state before reporting success.

## Move files

```sh
botter send BOT --text "Review these notes" --attach ./notes.txt --wait 30
botter upload BOT ./notes.txt
botter artifacts BOT --pages 2
botter download BOT /store/PATH_FROM_RESULT --out ./result.txt
```

Use remote paths returned by upload or observed artifact references; artifact discovery is not a computer filesystem inventory. Existing remote references use `--attachments '[{"path":"/store/PATH_FROM_RESULT","name":"notes.txt"}]'`. An empty text value (`--text ""`) is allowed when attachments are present.

Verified transfers are limited to **5 MiB**, `SINGLE_PUT` uploads, and store downloads. Other storage modes fail explicitly. Downloads refuse an existing destination unless `--overwrite` is supplied. SDK equivalents are `upload({ botId, path })` and `download({ botId, path, output })`.

## Interpret results and recover

Commands return JSON on stdout. `watch` and API streams emit one JSON object per line. Diagnostics and errors go to stderr; separate the streams when capturing output.

| Exit | Meaning | Next step |
| --- | --- | --- |
| `0` | Command finished successfully | Inspect delivery/status; this need not mean the bot's task finished |
| `1` | Operation failed or transcript resync is required | Inspect the error/receipt and current state before another write |
| `2` | Invalid usage | Read `botter help COMMAND` and correct the inputs |

Send receipts include `messageId`, delivery, and optional status. A missing status or lost connection can follow an accepted send. Writes are never automatically retried. Use the recorded ID, history, thread, and send-status discovery to reconcile the result.

If watch emits `resyncRequired`/`cursorTooOld`, or updates returns `resyncRequired: true`, reload history and start a fresh watch. Do not resume from a cursor that skipped an unavailable body.

## Host SDK operations carefully

Use `createClient` from `@jethros-projects/botter`; the CLI calls this same managed SDK. Use object inputs and shared names: `botId`, `text`, `attachments`, `wait`, `output`. Structured native content retains provider keys.

- Supply `RequestOptions.signal` or `timeoutMs` for bounded requests; `watch` deadlines cover the subscription lifetime.
- `watch()` returns a single-consumer async subscription. Always `cancel()` in `finally`; observe `done` for completion or failure. Overflow raises `RESYNC_REQUIRED` rather than dropping events.
- `subscription.cursor` acknowledges consumed entries/deletes/clears, not queued events. It preserves exact decimal sequences. Managed watches start fresh; they do not accept persisted resume cursors.
- Always `await client.close()` when the host finishes. Cleanup cancels pending work and subscriptions without logging out. Injected transports remain caller-owned unless `ownsTransport: true` is explicit.
- Catch `BotterError`. `receipt` and `deliveryState` distinguish an unknown send from an accepted send whose reply wait failed. Keep the original ID and reconcile before retrying.
- Authentication stays in the Node host. Send metadata to a renderer, not access tokens, login verifiers, or raw credential stores.

`@jethros-projects/botter/advanced` and legacy `@jethros-projects/botter/core` expose native helpers and raw transports. Their presence does not imply verified support or the managed SDK's lifecycle guarantees. Use the primary SDK for new client work.
